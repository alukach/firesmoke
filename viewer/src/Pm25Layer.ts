// Custom deck.gl layer: PM2.5 raster with a time-driven, GPU-side cross-fade.
//
// The layer owns its own animation: each draw() reads performance.now(),
// derives the current playhead position, picks frames A and B from a caller-
// supplied cache, uploads textures only on integer crossings, and renders
// with mix(frameA, frameB, tMix) before the inline AQI colormap.
//
// While playing, draw() calls setNeedsRedraw() so deck.gl (and MapboxOverlay)
// schedule the next frame — no JS RAF loop and no React re-renders in the
// hot path. React only re-renders on play/pause/seek/speed/frame-loaded.

import { BitmapLayer } from "@deck.gl/layers";
import type { BitmapLayerProps } from "@deck.gl/layers";
import type { UpdateParameters } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { PM_MAX } from "./colormap.ts";
import type { Frame } from "./useForecast.ts";

const FRAGMENT_SHADER = /* glsl */ `\
#version 300 es
#define SHADER_NAME pm25-layer-fragment-shader

#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D bitmapTexture;
uniform sampler2D bitmapTextureB;
uniform sampler2D colormapTexture;

in vec2 vTexCoord;
in vec2 vTexPos;

out vec4 fragColor;

const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / PI / 2.0;

vec2 lnglat_to_mercator(vec2 lnglat) {
  float x = lnglat.x;
  float y = clamp(lnglat.y, -89.9, 89.9);
  return vec2(
    radians(x) + PI,
    PI + log(tan(PI * 0.25 + radians(y) * 0.5))
  ) * WORLD_SCALE;
}

vec2 mercator_to_lnglat(vec2 xy) {
  xy /= WORLD_SCALE;
  return degrees(vec2(
    xy.x - PI,
    atan(exp(xy.y - PI)) * 2.0 - PI * 0.5
  ));
}

vec2 getUV(vec2 pos) {
  return vec2(
    (pos.x - bitmap.bounds[0]) / (bitmap.bounds[2] - bitmap.bounds[0]),
    (pos.y - bitmap.bounds[3]) / (bitmap.bounds[1] - bitmap.bounds[3])
  );
}

void main(void) {
  vec2 uv = vTexCoord;
  if (bitmap.coordinateConversion < -0.5) {
    vec2 lnglat = mercator_to_lnglat(vTexPos);
    uv = getUV(lnglat);
  } else if (bitmap.coordinateConversion > 0.5) {
    vec2 commonPos = lnglat_to_mercator(vTexPos);
    uv = getUV(commonPos);
  }
  // BlueSky's grid is south-to-north (row 0 = southernmost lat), but
  // BitmapLayer's tex coords put y=0 at the top of the bounds (north).
  // Flip Y when sampling so data lands at the right latitude.
  vec2 dataUv = vec2(uv.x, 1.0 - uv.y);
  float pm25A = texture(bitmapTexture, dataUv).r;
  float pm25B = texture(bitmapTextureB, dataUv).r;
  float pm25 = mix(pm25A, pm25B, pm25Blend.tMix);

  // Sample the colormap LUT (256x1 RGBA8). The alpha channel encodes the
  // palette's threshold behavior (alpha=0 below the visible threshold).
  float t = clamp(pm25 / pm25Blend.pmMax, 0.0, 1.0);
  vec4 c = texture(colormapTexture, vec2(t, 0.5));
  fragColor = vec4(c.rgb, c.a * layer.opacity);
  if (fragColor.a < 0.001) discard;

  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

const blendUniformBlock = /* glsl */ `\
layout(std140) uniform pm25BlendUniforms {
  float tMix;
  float pmMax;
} pm25Blend;
`;

type BlendUniforms = { tMix: number; pmMax: number };
type BlendBindings = { bitmapTextureB: Texture; colormapTexture: Texture };

const pm25BlendModule: ShaderModule<BlendUniforms & BlendBindings, BlendUniforms> = {
  name: "pm25Blend",
  vs: blendUniformBlock,
  fs: blendUniformBlock,
  uniformTypes: { tMix: "f32", pmMax: "f32" },
};

export type Pm25LayerProps = Omit<BitmapLayerProps, "image"> & {
  /** Sync lookup into the frame cache. Returns null if the frame is not
   *  yet loaded — the layer falls back to the last loaded frame. */
  peekFrame: (idx: number) => Frame | null;
  /** Total number of frames in the time series. */
  frameCount: number;
  /** Frame dimensions in pixels (== meta.width / meta.height). */
  imageWidth: number;
  imageHeight: number;
  /** Playback state. */
  playing: boolean;
  /** Forecast hours per real-time second. */
  speed: number;
  /** performance.now() snapshot from when playback last started (or seeked). */
  originTime: number;
  /** Frame position [0, frameCount) at originTime. */
  originPosition: number;
  /** Used as a layer prop to force redraw when prefetch lands new frames. */
  framesVersion: number;
  /** 256x1 RGBA8 LUT (1024 bytes) from `buildLut(palette)`. */
  colormapLut: Uint8Array;
};

type Pm25LayerState = {
  dataTexture?: Texture;
  dataTextureB?: Texture;
  colormapTexture?: Texture;
  lastUploadedA?: Frame;
  lastUploadedB?: Frame;
  lastUploadedLut?: Uint8Array;
};

export class Pm25Layer extends BitmapLayer<Pm25LayerProps> {
  static override layerName = "Pm25Layer";
  static override defaultProps = {
    ...BitmapLayer.defaultProps,
    peekFrame: { type: "function", value: (() => null) as Pm25LayerProps["peekFrame"] },
    frameCount: { type: "number", value: 0 },
    imageWidth: { type: "number", value: 0 },
    imageHeight: { type: "number", value: 0 },
    playing: { type: "boolean", value: false },
    speed: { type: "number", value: 1 },
    originTime: { type: "number", value: 0 },
    originPosition: { type: "number", value: 0 },
    framesVersion: { type: "number", value: 0 },
    colormapLut: { type: "object", value: new Uint8Array(256 * 4), async: false },
  };

  declare state: BitmapLayer["state"] & Pm25LayerState;

  override getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      fs: FRAGMENT_SHADER,
      modules: [...(shaders.modules ?? []), pm25BlendModule],
    };
  }

  override updateState(params: UpdateParameters<this>) {
    super.updateState(params);
    // We don't need to react to most prop changes — draw() reads everything
    // it needs from this.props each frame. We DO need to invalidate cached
    // texture state if image dimensions change.
    const { props, oldProps } = params;
    if (
      props.imageWidth !== oldProps.imageWidth ||
      props.imageHeight !== oldProps.imageHeight
    ) {
      this.state.dataTexture?.destroy();
      this.state.dataTextureB?.destroy();
      this.setState({
        dataTexture: undefined,
        dataTextureB: undefined,
        lastUploadedA: undefined,
        lastUploadedB: undefined,
      });
    }
  }

  override draw(opts: Parameters<BitmapLayer["draw"]>[0]) {
    const { shaderModuleProps } = opts;
    const { model, coordinateConversion, bounds, disablePicking } = this.state;
    const {
      peekFrame,
      frameCount,
      playing,
      speed,
      originTime,
      originPosition,
      desaturate,
      transparentColor,
      tintColor,
    } = this.props;

    if (shaderModuleProps?.picking?.isActive && disablePicking) return;
    if (!model || frameCount === 0) return;

    // Derive current playhead from time.
    let position: number;
    if (playing) {
      const dt = (performance.now() - originTime) / 1000;
      position = (originPosition + dt * speed) % frameCount;
      if (position < 0) position += frameCount;
    } else {
      position = originPosition % frameCount;
      if (position < 0) position += frameCount;
    }

    const idxA = Math.floor(position);
    const idxB = (idxA + 1) % frameCount;
    const tMix = position - idxA;

    // Pull frames from the cache. If a frame isn't ready, fall back to
    // whatever was last uploaded so we never flash to black.
    const requestedA = peekFrame(idxA);
    const requestedB = peekFrame(idxB);
    const frameA = requestedA ?? this.state.lastUploadedA ?? null;
    const frameB = requestedB ?? this.state.lastUploadedB ?? frameA;

    if (!frameA) {
      if (playing) this.setNeedsRedraw();
      return;
    }
    // After the early-return above, frameA is non-null, so frameB's
    // final fallback (?? frameA) is also non-null.
    const frameAResolved = frameA;
    const frameBResolved = frameB ?? frameAResolved;

    // Upload textures only when the *frame identity* changes (not every
    // draw). The cache returns stable Frame references, so this naturally
    // amortizes texture creation to ~once per integer crossing.
    if (frameAResolved !== this.state.lastUploadedA) {
      this._uploadTexture("dataTexture", frameAResolved.data);
      this.setState({ lastUploadedA: frameAResolved });
    }
    if (frameBResolved !== this.state.lastUploadedB) {
      this._uploadTexture("dataTextureB", frameBResolved.data);
      this.setState({ lastUploadedB: frameBResolved });
    }
    if (this.props.colormapLut !== this.state.lastUploadedLut) {
      this._uploadColormap(this.props.colormapLut);
      this.setState({ lastUploadedLut: this.props.colormapLut });
    }

    const dataTexture = this.state.dataTexture!;
    const dataTextureB = this.state.dataTextureB ?? dataTexture;
    const colormapTexture = this.state.colormapTexture;
    if (!colormapTexture) return;
    const effectiveTMix = this.state.dataTextureB ? tMix : 0;

    model.shaderInputs.setProps({
      bitmap: {
        bitmapTexture: dataTexture,
        bounds,
        coordinateConversion,
        desaturate,
        tintColor: (tintColor as unknown as number[])
          .slice(0, 3)
          .map((x) => x / 255),
        transparentColor: (transparentColor as unknown as number[]).map(
          (x) => x / 255,
        ),
      },
      pm25Blend: {
        bitmapTextureB: dataTextureB,
        colormapTexture,
        tMix: effectiveTMix,
        pmMax: PM_MAX,
      },
    });
    model.draw(this.context.renderPass);

    // Keep the deck.gl render loop running while playing.
    if (playing) this.setNeedsRedraw();
  }

  private _uploadTexture(
    key: "dataTexture" | "dataTextureB",
    data: Float32Array,
  ) {
    const { imageWidth, imageHeight } = this.props;
    if (!imageWidth || !imageHeight) return;
    const { device } = this.context;
    const old = this.state[key];
    if (old) old.destroy();
    const texture = device.createTexture({
      width: imageWidth,
      height: imageHeight,
      format: "r32float",
      data,
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
    this.setState({ [key]: texture });
  }

  private _uploadColormap(lut: Uint8Array) {
    const { device } = this.context;
    this.state.colormapTexture?.destroy();
    const texture = device.createTexture({
      width: 256,
      height: 1,
      format: "rgba8unorm",
      data: lut,
      // Linear filter smooths the palette ramp between LUT bins.
      sampler: {
        minFilter: "linear",
        magFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
    this.setState({ colormapTexture: texture });
  }

  override finalizeState(context: Parameters<BitmapLayer["finalizeState"]>[0]) {
    this.state.dataTexture?.destroy();
    this.state.dataTextureB?.destroy();
    this.state.colormapTexture?.destroy();
    super.finalizeState(context);
  }
}
