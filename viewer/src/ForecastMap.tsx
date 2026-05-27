import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Map as MaplibreMapInstance } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo } from "react";
import type { MapEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { Map as MaplibreMap, useControl } from "react-map-gl/maplibre";
import { buildLut, type Palette } from "./colormap.ts";
import type { PlaybackState } from "./playback.ts";
import type { SelectedPoint } from "./PointChart.tsx";
import { Pm25Layer } from "./Pm25Layer.ts";
import { useFireData } from "./useFireData.ts";
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
  meta: ForecastMeta;
  peekFrame: (idx: number) => Frame | null;
  framesVersion: number;
  playback: PlaybackState;
  palette: Palette;
  selectedPoint: SelectedPoint | null;
  onPointClick: (point: SelectedPoint | null) => void;
  onMapLoad?: (map: MaplibreMapInstance) => void;
};

function DeckOverlay({
  meta,
  peekFrame,
  framesVersion,
  playback,
  palette,
  selectedPoint,
}: Props) {
  const overlay = useControl(
    () => new MapboxOverlay({ interleaved: false, layers: [] }),
  );

  // Rebuild the LUT only when the palette changes.
  const colormapLut = useMemo(() => buildLut(palette), [palette]);

  // Fetch BlueSky's published fire detections (input to the dispersion
  // forecast). Silently no-ops if firesmoke.ca blocks CORS.
  const fireData = useFireData();

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
    if (fireData.outlines) {
      ls.push(
        new GeoJsonLayer({
          id: "fire-outlines",
          data: fireData.outlines,
          filled: true,
          getFillColor: [255, 90, 30, 70],
          stroked: true,
          getLineColor: [255, 90, 30, 230],
          lineWidthUnits: "pixels",
          getLineWidth: 1.2,
          pickable: false,
          pointType: "circle",
        }),
      );
    }
    if (fireData.locations) {
      ls.push(
        new GeoJsonLayer({
          id: "fire-locations",
          data: fireData.locations,
          pointType: "circle",
          getPointRadius: 3,
          pointRadiusUnits: "pixels",
          getFillColor: [255, 60, 30, 220],
          getLineColor: [40, 0, 0, 220],
          stroked: true,
          lineWidthUnits: "pixels",
          getLineWidth: 0.8,
          pickable: false,
        }),
      );
    }
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
    fireData.outlines,
    fireData.locations,
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
  const { onMapLoad } = props;
  const center = useMemo(
    () => ({
      longitude: (props.meta.lonMin + props.meta.lonMax) / 2,
      latitude: (props.meta.latMin + props.meta.latMax) / 2,
      zoom: 3,
    }),
    [
      props.meta.lonMin,
      props.meta.lonMax,
      props.meta.latMin,
      props.meta.latMax,
    ],
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
      // Clamp inside the data bounds so a single click outside the domain
      // doesn't crash sampling; PointChart will render an "outside domain"
      // message if the rounded grid cell is out of range.
      props.onPointClick({ lat, lon: lng });
    },
    [props],
  );

  return (
    <MaplibreMap
      initialViewState={center}
      mapStyle={BASEMAP_STYLE}
      style={{ width: "100%", height: "100%" }}
      onLoad={handleLoad}
      onClick={handleClick}
    >
      <DeckOverlay {...props} />
    </MaplibreMap>
  );
}
