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

/** Parse ?lat=&lon= from the URL into a SelectedPoint for sharing. */
function readPointFromUrl(): SelectedPoint | null {
  const p = new URLSearchParams(window.location.search);
  const lat = parseFloat(p.get("lat") ?? "");
  const lon = parseFloat(p.get("lon") ?? "");
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export default function App() {
  const [runIdx, setRunIdx] = useState<number | undefined>(undefined);
  const state = useForecast(ZARR_URL, runIdx);
  const [playback, setPlayback] = useState<PlaybackState>(initialPlayback);
  const [paletteId, setPaletteId] = useState<PaletteId>("firesmoke");
  const palette = PALETTES[paletteId]!;
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(
    readPointFromUrl,
  );
  // Captured once at mount so the map can fly to a URL-supplied point on
  // first load without re-firing as the user clicks new points.
  const initialPointRef = useRef<SelectedPoint | null>(selectedPoint);

  // Persist the selected point in the URL so it's shareable.
  // Use replaceState — every map click would otherwise create a history
  // entry and clutter the back button.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedPoint) {
      url.searchParams.set("lat", selectedPoint.lat.toFixed(4));
      url.searchParams.set("lon", selectedPoint.lon.toFixed(4));
    } else {
      url.searchParams.delete("lat");
      url.searchParams.delete("lon");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedPoint]);
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
    // If the user landed on a ?lat=&lon= URL, recenter on it once the
    // map is ready. Consume the ref so panning away later isn't undone.
    const initial = initialPointRef.current;
    if (initial) {
      m.flyTo({ center: [initial.lon, initial.lat], zoom: 8, duration: 0 });
      initialPointRef.current = null;
    }
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

  // Auto-play once the prefetch has actually cached every frame. The
  // ref guard is essential: useForecast returns a fresh state object
  // each render (it spreads progress into the ready state), so without
  // it this effect would re-fire and re-trigger play() after the user
  // hits pause, immediately undoing their click.
  const autoPlayedRef = useRef(false);
  useEffect(() => {
    if (autoPlayedRef.current) return;
    if (state.status !== "ready") return;
    const { loaded, total } = state.prefetchProgress;
    if (total > 0 && loaded === total) {
      autoPlayedRef.current = true;
      play();
    }
  }, [state, play]);

  // Spacebar toggles play/pause, except when the user is typing in an
  // input (e.g. the city-search field) or other editable target.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (playbackRef.current.playing) pause();
      else play();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [play, pause]);

  const ready = state.status === "ready";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Always mount the map so basemap tiles load in parallel with the
          worker handshake + prefetch, rather than waiting on them. */}
      <ForecastMap
        meta={ready ? state.meta : null}
        peekFrame={ready ? state.peekFrame : null}
        framesVersion={ready ? state.framesVersion : 0}
        playback={playback}
        palette={palette}
        selectedPoint={selectedPoint}
        onPointClick={setSelectedPoint}
        onMapLoad={handleMapLoad}
      />

      {state.status === "loading" && (
        <Centered overlay>Loading forecast store…</Centered>
      )}
      {state.status === "error" && (
        <Centered overlay>
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
      )}

      {ready && (
        <>
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
            initTimes={state.meta.initTimes}
            selectedRunIdx={state.meta.selectedIdx}
            onRunSelect={setRunIdx}
          />
        </>
      )}
    </div>
  );
}

function Centered({
  children,
  overlay,
}: {
  children: React.ReactNode;
  overlay?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        textAlign: "center",
        // When stacked on top of the map, dim the map and intercept
        // pointer events so the loading/error message reads clearly.
        ...(overlay
          ? {
              position: "absolute",
              top: 0,
              left: 0,
              background: "rgba(17, 17, 17, 0.72)",
              color: "#eee",
              zIndex: 20,
              pointerEvents: "auto",
            }
          : null),
      }}
    >
      {children}
    </div>
  );
}
