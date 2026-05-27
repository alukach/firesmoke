import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { Map as MaplibreMapInstance } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo } from "react";
import type { MapEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { Map as MaplibreMap, useControl } from "react-map-gl/maplibre";
import { buildLut, type Palette } from "./colormap.ts";
import type { PlaybackState } from "./playback.ts";
import type { SelectedPoint } from "./PointChart.tsx";
import { Pm25Layer } from "./Pm25Layer.ts";
import type { ForecastMeta, Frame } from "./useForecast.ts";

const BASEMAP_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Mapzen Terrarium tiles, hosted by AWS Open Data — no API key required.
// https://registry.opendata.aws/terrain-tiles/
const TERRAIN_TILES =
  "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
const TERRAIN_ATTRIBUTION =
  '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Mapzen Terrain Tiles</a>';

function addHillshade(map: MaplibreMapInstance) {
  if (map.getSource("terrarium")) return;
  map.addSource("terrarium", {
    type: "raster-dem",
    tiles: [TERRAIN_TILES],
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 15,
    attribution: TERRAIN_ATTRIBUTION,
  });
  // Insert beneath the first symbol (label) layer so place names stay legible.
  const layers = map.getStyle().layers ?? [];
  const firstSymbol = layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "hillshade",
      type: "hillshade",
      source: "terrarium",
      paint: {
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "#4a5a78",
        "hillshade-accent-color": "#0a0e18",
        "hillshade-exaggeration": 0.55,
      },
    },
    firstSymbol,
  );
}

type Props = {
  /** Null until the forecast metadata loads; map still renders the basemap. */
  meta: ForecastMeta | null;
  peekFrame: ((idx: number) => Frame | null) | null;
  framesVersion: number;
  playback: PlaybackState;
  palette: Palette;
  selectedPoint: SelectedPoint | null;
  onPointClick: (point: SelectedPoint | null) => void;
  onMapLoad?: (map: MaplibreMapInstance) => void;
};

// Fallback view centered on the BlueSky CONUS+Canada domain — used
// while the real meta is still loading so the basemap can render.
const FALLBACK_VIEW = { longitude: -106, latitude: 51, zoom: 3 };

type OverlayProps = {
  meta: ForecastMeta;
  peekFrame: (idx: number) => Frame | null;
  framesVersion: number;
  playback: PlaybackState;
  palette: Palette;
  selectedPoint: SelectedPoint | null;
};

function DeckOverlay({
  meta,
  peekFrame,
  framesVersion,
  playback,
  palette,
  selectedPoint,
}: OverlayProps) {
  const overlay = useControl(
    () => new MapboxOverlay({ interleaved: false, layers: [] }),
  );

  // Rebuild the LUT only when the palette changes.
  const colormapLut = useMemo(() => buildLut(palette), [palette]);

  // Build a fresh layer instance only when the playback config, frame cache
  // version, palette, or selection changes — NOT per animation tick.
  const layers = useMemo(() => {
    const ls: Layer[] = [
      new Pm25Layer({
        id: "pm25-latest",
        peekFrame,
        frameCount: meta.validTimes.length,
        imageWidth: meta.width,
        imageHeight: meta.height,
        bounds: [meta.lonMin, meta.latMin, meta.lonMax, meta.latMax],
        // Tell BitmapLayer the bounds are in lat/lon so it does the
        // per-fragment Mercator→lnglat UV computation. Otherwise texCoords
        // interpolate linearly in Mercator screen space and mis-sample
        // by ~4° at our latitude range.
        _imageCoordinateSystem: "lnglat",
        opacity: 0.85,
        pickable: false,
        playing: playback.playing,
        speed: playback.speed,
        originTime: playback.originTime,
        originPosition: playback.originPosition,
        framesVersion,
        colormapLut,
      }),
    ];
    if (selectedPoint) {
      ls.push(
        new ScatterplotLayer({
          id: "selected-point",
          data: [selectedPoint],
          getPosition: (d: SelectedPoint) => [d.lon, d.lat],
          getRadius: 6,
          radiusUnits: "pixels",
          getFillColor: [255, 255, 255, 220],
          getLineColor: [0, 0, 0, 255],
          lineWidthUnits: "pixels",
          getLineWidth: 1.5,
          stroked: true,
          pickable: false,
        }),
      );
    }
    return ls;
  }, [
    meta.validTimes.length,
    meta.width,
    meta.height,
    meta.lonMin,
    meta.latMin,
    meta.lonMax,
    meta.latMax,
    peekFrame,
    framesVersion,
    // Including the full playback (or its fields) in the deps means a
    // play/pause/seek/speed change rebuilds the layer instance. deck.gl's
    // state transfer preserves the GPU textures across same-id rebuilds,
    // so the cost is ~just an object allocation. The benefit: deck.gl
    // sees the prop change and schedules a draw, which then calls
    // setNeedsRedraw() inside Pm25Layer.draw() to sustain the loop.
    playback.playing,
    playback.speed,
    playback.originTime,
    playback.originPosition,
    colormapLut,
    selectedPoint,
  ]);

  // Push layer updates as a side effect, not during render — render
  // bodies can run twice under StrictMode or be discarded mid-render
  // under concurrent React, but the overlay mutation would still fire.
  useEffect(() => {
    overlay.setProps({ layers });
  }, [overlay, layers]);

  return null;
}

export function ForecastMap(props: Props) {
  const { onMapLoad, meta, peekFrame, onPointClick } = props;
  // Center on the data domain if known, otherwise show the fallback
  // continental view so the basemap can mount before the worker
  // finishes the handshake.
  const center = useMemo(
    () =>
      meta
        ? {
            longitude: (meta.lonMin + meta.lonMax) / 2,
            latitude: (meta.latMin + meta.latMax) / 2,
            zoom: 3,
          }
        : FALLBACK_VIEW,
    // Intentionally only re-center on first meta arrival; later coord
    // changes would yank the view away from a panned user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleLoad = useCallback(
    (ev: MapEvent) => {
      const map = ev.target as MaplibreMapInstance;
      addHillshade(map);
      onMapLoad?.(map);
    },
    [onMapLoad],
  );

  const handleClick = useCallback(
    (ev: MapLayerMouseEvent) => {
      const { lng, lat } = ev.lngLat;
      // Ignore clicks before the data is loaded — nothing to plot yet.
      if (!meta || !peekFrame) return;
      onPointClick({ lat, lon: lng });
    },
    [meta, peekFrame, onPointClick],
  );

  return (
    <MaplibreMap
      initialViewState={center}
      mapStyle={BASEMAP_STYLE}
      style={{ width: "100%", height: "100%" }}
      onLoad={handleLoad}
      onClick={handleClick}
    >
      {meta && peekFrame && (
        <DeckOverlay
          meta={meta}
          peekFrame={peekFrame}
          framesVersion={props.framesVersion}
          playback={props.playback}
          palette={props.palette}
          selectedPoint={props.selectedPoint}
        />
      )}
    </MaplibreMap>
  );
}
