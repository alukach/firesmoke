import { useCallback, useRef, useState } from "react";
import { PALETTES, type PaletteId } from "./colormap.ts";
import { Controls, type Speed } from "./Controls.tsx";
import { ForecastMap } from "./ForecastMap.tsx";
import { useForecast } from "./useForecast.ts";

const QUERY_ZARR = new URLSearchParams(window.location.search).get("zarr");
const ZARR_URL =
  QUERY_ZARR ??
  import.meta.env.VITE_ZARR_URL ??
  new URL("/forecasts.zarr", window.location.origin).toString();

/** Snapshot used by both the layer (every draw) and the UI (10 Hz). */
export type PlaybackState = {
  playing: boolean;
  speed: Speed;
  /** performance.now() at the moment playback last started (or seeked). */
  originTime: number;
  /** Frame position [0, N) at originTime. */
  originPosition: number;
};

/** Compute the current continuous playhead position from a PlaybackState. */
export function currentPosition(p: PlaybackState, N: number): number {
  if (N === 0) return 0;
  if (!p.playing) {
    let pos = p.originPosition % N;
    if (pos < 0) pos += N;
    return pos;
  }
  const dt = (performance.now() - p.originTime) / 1000;
  let pos = (p.originPosition + dt * p.speed) % N;
  if (pos < 0) pos += N;
  return pos;
}

export default function App() {
  const state = useForecast(ZARR_URL);
  const [playback, setPlayback] = useState<PlaybackState>({
    playing: false,
    speed: 4,
    originTime: performance.now(),
    originPosition: 0,
  });
  const [paletteId, setPaletteId] = useState<PaletteId>("epa-aqi");
  const palette = PALETTES[paletteId]!;
  // Always-fresh snapshot for non-React readers (Controls' 10 Hz ticker).
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  const N = state.status === "ready" ? state.meta.validTimes.length : 0;

  const play = useCallback(() => {
    setPlayback((p) => {
      if (p.playing) return p;
      return { ...p, playing: true, originTime: performance.now() };
    });
  }, []);

  const pause = useCallback(() => {
    setPlayback((p) => {
      if (!p.playing) return p;
      const dt = (performance.now() - p.originTime) / 1000;
      const N_ = N;
      const pos =
        N_ > 0 ? ((p.originPosition + dt * p.speed) % N_ + N_) % N_ : 0;
      return { ...p, playing: false, originPosition: pos, originTime: performance.now() };
    });
  }, [N]);

  const setSpeed = useCallback(
    (speed: Speed) => {
      setPlayback((p) => {
        if (p.speed === speed) return p;
        // Re-anchor origin so the playhead doesn't jump when speed changes.
        const dt = (performance.now() - p.originTime) / 1000;
        const N_ = N;
        const pos =
          N_ > 0 ? ((p.originPosition + dt * p.speed) % N_ + N_) % N_ : 0;
        return {
          ...p,
          speed,
          originPosition: pos,
          originTime: performance.now(),
        };
      });
    },
    [N],
  );

  const seek = useCallback((position: number) => {
    setPlayback((p) => ({
      ...p,
      playing: false,
      originPosition: position,
      originTime: performance.now(),
    }));
  }, []);

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
      />
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
        palette={palette}
        paletteId={paletteId}
        onPaletteChange={setPaletteId}
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
