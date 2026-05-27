import type { Map as MaplibreMapInstance } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { PALETTES, type PaletteId } from "./colormap.ts";
import { Controls } from "./Controls.tsx";
import { ForecastMap } from "./ForecastMap.tsx";
import { InfoCard } from "./InfoCard.tsx";
import { PaletteCard } from "./PaletteCard.tsx";
import {
  initialPlayback,
  pauseAt,
  playOn,
  seekTo,
  withSpeed,
  type PlaybackState,
  type Speed,
} from "./playback.ts";
import { PointChart, type SelectedPoint } from "./PointChart.tsx";
import { SearchCard } from "./SearchCard.tsx";
import { useForecast } from "./useForecast.ts";

const QUERY_ZARR = new URLSearchParams(window.location.search).get("zarr");
const ZARR_URL =
  QUERY_ZARR ??
  import.meta.env.VITE_ZARR_URL ??
  new URL("/forecasts.zarr", window.location.origin).toString();

export default function App() {
  const state = useForecast(ZARR_URL);
  const [playback, setPlayback] = useState<PlaybackState>(initialPlayback);
  const [paletteId, setPaletteId] = useState<PaletteId>("firesmoke");
  const palette = PALETTES[paletteId]!;
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(null);
  // Always-fresh snapshot for non-React readers (Controls' 10 Hz ticker
  // and the Pm25Layer draw loop). Assign in an effect rather than during
  // render so React 19's concurrent rendering can discard a render
  // without leaving the ref pointing at state that never committed.
  const playbackRef = useRef(playback);
  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  const mapRef = useRef<MaplibreMapInstance | null>(null);
  const handleMapLoad = useCallback((m: MaplibreMapInstance) => {
    mapRef.current = m;
  }, []);
  const flyTo = useCallback((lat: number, lon: number, zoom?: number) => {
    mapRef.current?.flyTo({ center: [lon, lat], zoom: zoom ?? 8 });
    // Select the location too, so the PointChart opens for the searched
    // city as if the user had clicked the map at that spot.
    setSelectedPoint({ lat, lon });
  }, []);

  const N = state.status === "ready" ? state.meta.validTimes.length : 0;

  const play = useCallback(() => setPlayback(playOn), []);
  const pause = useCallback(() => setPlayback((p) => pauseAt(p, N)), [N]);
  const setSpeed = useCallback(
    (s: Speed) => setPlayback((p) => withSpeed(p, s, N)),
    [N],
  );
  const seek = useCallback((position: number) => {
    setPlayback((p) => seekTo(p, position));
  }, []);

  // Auto-play once the forecast metadata has loaded. Only fires on the
  // loading→ready transition; pausing later keeps it paused.
  useEffect(() => {
    if (state.status === "ready") play();
  }, [state.status, play]);

  if (state.status === "loading") {
    return <Centered>Loading forecast store…</Centered>;
  }
  if (state.status === "error") {
    return (
      <Centered>
        <div style={{ maxWidth: 520, textAlign: "left" }}>
          <h2 style={{ marginTop: 0 }}>Could not open forecast store</h2>
          <p style={{ opacity: 0.8 }}>
            Tried <code>{ZARR_URL}</code>. Have you run an ingest yet?
          </p>
          <pre style={{ background: "#222", padding: 12, borderRadius: 4, overflow: "auto", fontSize: 12 }}>
            uv run firesmoke-ingest current --store ./forecasts.zarr
          </pre>
          <p style={{ opacity: 0.6, fontSize: 12 }}>Underlying error: {state.error}</p>
        </div>
      </Centered>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ForecastMap
        meta={state.meta}
        peekFrame={state.peekFrame}
        framesVersion={state.framesVersion}
        playback={playback}
        palette={palette}
        selectedPoint={selectedPoint}
        onPointClick={setSelectedPoint}
        onMapLoad={handleMapLoad}
      />
      <SearchCard flyTo={flyTo} bounds={state.meta} />
      <PaletteCard
        palette={palette}
        paletteId={paletteId}
        onPaletteChange={setPaletteId}
      />
      <InfoCard />
      {selectedPoint && (
        <PointChart
          point={selectedPoint}
          meta={state.meta}
          peekFrame={state.peekFrame}
          framesVersion={state.framesVersion}
          palette={palette}
          playback={playback}
          playbackRef={playbackRef}
          onSeek={seek}
          onClose={() => setSelectedPoint(null)}
        />
      )}
      <Controls
        meta={state.meta}
        playback={playback}
        playbackRef={playbackRef}
        onPlay={play}
        onPause={pause}
        onSeek={seek}
        onSpeedChange={setSpeed}
        prefetchAll={state.prefetchAll}
        prefetchProgress={state.prefetchProgress}
        peekFrame={state.peekFrame}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
