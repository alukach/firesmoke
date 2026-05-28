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

// Bound the per-Frame GPU texture cache. At ~1.6 MB per r32float texture,
// 64 entries cap us at ~100 MB — more than a typical 51-frame forecast,
// with headroom for run switches.
const MAX_CACHED_FRAMES = 64;

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

// Mercator → lnglat helper, mirrored from BitmapLayer's fragment
// shader. We always set _imageCoordinateSystem='lnglat' against the
// MapboxOverlay's Mercator viewport, so BitmapLayer sets
// bitmap.coordinateConversion = -1 and only the inverse transform
// runs — the forward (lnglat→Mercator) branch present upstream is
// dead code under our usage and has been dropped.
//
// WORLD_SCALE mirrors BitmapLayer's hard-coded TILE_SIZE = 512.0:
// deck.gl's Mercator common space is defined in 512-pixel tile units
// (see @math.gl/web-mercator). If deck.gl ever changes that, this
// constant needs to track it.
const float PI = 3.1415926536;
const float WORLD_SCALE = 512.0 / PI / 2.0;

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
  // coordinateConversion = -1 when we render lnglat-bounded data on a
  // Mercator viewport (our only case). Any other value means our usage
  // assumption is violated; we still fall through to the linearly
  // interpolated vTexCoord, which is BitmapLayer's default behavior.
  if (bitmap.coordinateConversion < -0.5) {
    vec2 lnglat = mercator_to_lnglat(vTexPos);
    uv = getUV(lnglat);
  }
  // BlueSky's grid is south-to-north (row 0 = southernmost lat), but
  // BitmapLayer's tex coords put y=0 at the top of the bounds (north).
  // Flip Y when sampling so data lands at the right latitude.
  vec2 dataUv = vec2(uv.x, 1.0 - uv.y);
  // PM2.5 textures are r32float in µg/m³. Normalize against pmMax for
  // the LUT lookup.
  float pm25A = texture(bitmapTexture, dataUv).r;
  float pm25B = texture(bitmapTextureB, dataUv).r;
  float pm25 = mix(pm25A, pm25B, pm25Blend.tMix);
  float t = clamp(pm25 / pm25Blend.pmMax, 0.0, 1.0);
  // Sample the colormap LUT (256x1 RGBA8). The alpha channel encodes the
  // palette's threshold behavior (alpha=0 below the visible threshold).
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
  /** Playback state. As normal props so deck.gl's prop diff triggers
   *  a draw on play/pause/seek/speed — without that the self-sustaining
   *  setNeedsRedraw() loop inside draw() never gets its first call. */
  playing: boolean;
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
  /** Per-Frame GPU texture cache. Map insertion order tracks LRU; on hit
   *  we re-insert to mark recency. Bounded by MAX_CACHED_FRAMES. */
  frameTextures?: Map<Frame, Texture>;
  /** Most recently shown frames per slot. Used purely as a fallback when
   *  the requested frame for the next draw isn't loaded yet — keeps the
   *  display from flashing to black instead of holding the last frame. */
  lastShownA?: Frame;
  lastShownB?: Frame;
  colormapTexture?: Texture;
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
    // texture state if image dimensions change. (_getOrCreateFrameTexture
    // also guards per-entry, but flushing here releases stale GPU memory
    // immediately instead of waiting for each Frame to be re-requested.)
    const { props, oldProps } = params;
    if (
      props.imageWidth !== oldProps.imageWidth ||
      props.imageHeight !== oldProps.imageHeight
    ) {
      const map = this.state.frameTextures;
      if (map) {
        for (const tex of map.values()) tex.destroy();
        map.clear();
      }
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
    // whatever was last shown so we never flash to black.
    const requestedA = peekFrame(idxA);
    const requestedB = peekFrame(idxB);
    const frameA = requestedA ?? this.state.lastShownA ?? null;
    const frameB = requestedB ?? this.state.lastShownB ?? frameA;

    if (!frameA) {
      if (playing) this.setNeedsRedraw();
      return;
    }
    // After the early-return above, frameA is non-null, so frameB's
    // final fallback (?? frameA) is also non-null.
    const frameAResolved = frameA;
    const frameBResolved = frameB ?? frameAResolved;

    // Resolve textures via the per-Frame GPU cache. On a hit (the common
    // case while scrubbing through already-loaded frames) this is a Map
    // lookup with zero uploads. On a miss we allocate + copyImageData
    // once, then the entry sticks around until LRU-evicted.
    //
    // When A and B reference the same Frame the Map returns the same
    // Texture for both slots — no second upload, no duplication.
    //
    // Mutate `this.state` directly for the "last shown" sentinels — these
    // are pure caches that should not trigger deck.gl's updateState
    // lifecycle. setState() inside draw() would schedule a redundant
    // updateState the following tick.
    const dataTexture = this._getOrCreateFrameTexture(frameAResolved);
    const dataTextureB = this._getOrCreateFrameTexture(frameBResolved);
    this.state.lastShownA = frameAResolved;
    this.state.lastShownB = frameBResolved;

    if (this.props.colormapLut !== this.state.lastUploadedLut) {
      this._uploadColormap(this.props.colormapLut);
      this.state.lastUploadedLut = this.props.colormapLut;
    }

    const colormapTexture = this.state.colormapTexture;
    if (!colormapTexture) return;

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
        tMix,
        pmMax: PM_MAX,
      },
    });
    model.draw(this.context.renderPass);

    // Keep the deck.gl render loop running while playing.
    if (playing) this.setNeedsRedraw();
  }

  /**
   * Resolve a Frame to its GPU texture, allocating + uploading on miss.
   * Touches the LRU on hit by re-inserting (Map iteration order = insertion
   * order, so the oldest key is always the LRU). Evicts oldest entries
   * when the cache exceeds MAX_CACHED_FRAMES.
   *
   * Dimension changes (forecast switched to a different grid) destroy the
   * stale texture for this Frame and reallocate at the current size — but
   * normally updateState() flushes the whole cache when imageWidth/Height
   * change, so this fallback only matters if a Frame somehow outlives the
   * grid switch with the wrong texture still attached.
   */
  private _getOrCreateFrameTexture(frame: Frame): Texture {
    const { imageWidth, imageHeight } = this.props;
    let map = this.state.frameTextures;
    if (!map) {
      map = new Map<Frame, Texture>();
      this.state.frameTextures = map;
    }
    let tex = map.get(frame);
    if (tex && tex.width === imageWidth && tex.height === imageHeight) {
      // Re-insert to move to end of insertion order (touch for LRU).
      map.delete(frame);
      map.set(frame, tex);
      return tex;
    }
    if (tex) {
      // Dimensions changed. Discard and re-create at the new grid size.
      tex.destroy();
      map.delete(frame);
    }
    // Evict LRU entries until we're under the cap.
    while (map.size >= MAX_CACHED_FRAMES) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestTex = map.get(oldestKey);
      oldestTex?.destroy();
      map.delete(oldestKey);
    }
    // Allocate + upload.
    const { device } = this.context;
    tex = device.createTexture({
      width: imageWidth,
      height: imageHeight,
      format: "r32float",
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
    tex.copyImageData({ data: frame.data });
    map.set(frame, tex);
    return tex;
  }

  private _uploadColormap(lut: Uint8Array) {
    const { device } = this.context;
    let texture = this.state.colormapTexture;
    if (!texture) {
      texture = device.createTexture({
        width: 256,
        height: 1,
        format: "rgba8unorm",
        // Linear filter smooths the palette ramp between LUT bins.
        sampler: {
          minFilter: "linear",
          magFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        },
      });
      this.state.colormapTexture = texture;
    }
    texture.copyImageData({ data: lut });
  }

  override finalizeState(context: Parameters<BitmapLayer["finalizeState"]>[0]) {
    const map = this.state.frameTextures;
    if (map) {
      for (const tex of map.values()) tex.destroy();
      map.clear();
    }
    this.state.colormapTexture?.destroy();
    super.finalizeState(context);
  }
}
