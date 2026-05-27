import { useEffect, useState } from "react";
import { currentPosition, type PlaybackState } from "./App.tsx";
import type { ForecastMeta, Frame, PrefetchProgress } from "./useForecast.ts";

const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

// How often to update the slider position + readouts while playing.
// Decoupled from the GPU animation rate so the textual UI doesn't churn React
// at 60Hz.
const DISPLAY_HZ = 10;

// Reserved on the right edge so MapLibre's bottom-right attribution stays
// visible behind the controls panel.
const ATTRIBUTION_GUTTER = 140;

function fmtForecast(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function fmtRun(ts: number): string {
  const d = new Date(ts);
  // Compact form for the run init time — it's secondary info.
  return d.toLocaleString(undefined, {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

type Props = {
  meta: ForecastMeta;
  playback: PlaybackState;
  playbackRef: { readonly current: PlaybackState };
  onPlay: () => void;
  onPause: () => void;
  onSeek: (position: number) => void;
  onSpeedChange: (s: Speed) => void;
  prefetchAll: () => Promise<void>;
  prefetchProgress: PrefetchProgress;
  peekFrame: (idx: number) => Frame | null;
};

export function Controls({
  meta,
  playback,
  playbackRef,
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
  prefetchAll,
  prefetchProgress,
  peekFrame,
}: Props) {
  const N = meta.validTimes.length;
  const [displayPos, setDisplayPos] = useState(() =>
    currentPosition(playback, N),
  );

  useEffect(() => {
    if (!playback.playing) {
      setDisplayPos(currentPosition(playback, N));
      return;
    }
    const id = setInterval(() => {
      setDisplayPos(currentPosition(playbackRef.current, N));
    }, 1000 / DISPLAY_HZ);
    return () => clearInterval(id);
  }, [playback, playbackRef, N]);

  const handlePlayToggle = () => {
    if (playback.playing) onPause();
    else {
      onPlay();
      void prefetchAll();
    }
  };

  const idxA = Math.min(Math.floor(displayPos), Math.max(0, N - 1));
  const idxB = (idxA + 1) % N;
  const tMix = displayPos - Math.floor(displayPos);
  const validTimeNow =
    meta.validTimes[idxA]! +
    tMix * (meta.validTimes[idxB]! - meta.validTimes[idxA]!);
  const initTimeNow =
    tMix < 0.5 ? meta.initTimes[idxA]! : meta.initTimes[idxB]!;

  const frameA = peekFrame(idxA);
  const frameB = peekFrame(idxB);
  const maxPm25 =
    frameA && frameB
      ? frameA.maxPm25 * (1 - tMix) + frameB.maxPm25 * tMix
      : frameA?.maxPm25 ?? null;

  const prefetchPct =
    prefetchProgress.total === 0
      ? 0
      : (prefetchProgress.loaded / prefetchProgress.total) * 100;
  const prefetchDone =
    prefetchProgress.total > 0 &&
    prefetchProgress.loaded === prefetchProgress.total;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        padding: `12px ${ATTRIBUTION_GUTTER}px 16px 16px`,
        background:
          "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.55) 80%, transparent)",
        color: "#eee",
        fontSize: 13,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <button
          onClick={handlePlayToggle}
          style={{
            background: "#fff",
            color: "#000",
            border: "none",
            borderRadius: 4,
            padding: "6px 12px",
            fontWeight: 600,
            cursor: "pointer",
            minWidth: 64,
          }}
        >
          {playback.playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <SpeedPicker value={playback.speed} onChange={onSpeedChange} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ position: "relative" }}>
            <input
              type="range"
              min={0}
              max={Math.max(0, N - 1)}
              step={0.01}
              value={displayPos}
              onChange={(e) => onSeek(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            <PrefetchBar pct={prefetchPct} done={prefetchDone} />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              opacity: 0.6,
            }}
          >
            <span>{fmtForecast(meta.validTimes[0]!)}</span>
            <span>
              {(idxA + 1).toString().padStart(2, " ")} / {N}
              {prefetchProgress.inFlight && (
                <>
                  {" · "}
                  <span style={{ color: "#7ec0ee" }}>
                    cached {prefetchProgress.loaded}/{prefetchProgress.total}
                  </span>
                </>
              )}
            </span>
            <span>{fmtForecast(meta.validTimes[N - 1]!)}</span>
          </div>
        </div>
      </div>

      {/* Headline row: prominent forecast time + max PM2.5; small dim
          run-init line beneath. No "Valid" label — the big date stands on
          its own. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          alignItems: "baseline",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 600 }}>
            {fmtForecast(validTimeNow)}
          </span>
          <span style={{ fontSize: 14, opacity: 0.85 }}>
            Max PM2.5:{" "}
            <span style={{ fontWeight: 600 }}>
              {maxPm25 !== null ? `${maxPm25.toFixed(1)} µg/m³` : "—"}
            </span>
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.55 }}>
          from {fmtRun(initTimeNow)} run
        </div>
      </div>
    </div>
  );
}

function SpeedPicker({
  value,
  onChange,
}: {
  value: Speed;
  onChange: (s: Speed) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderRadius: 4,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.15)",
      }}
      role="group"
      aria-label="Playback speed"
    >
      {SPEEDS.map((s) => {
        const active = s === value;
        return (
          <button
            key={s}
            onClick={() => onChange(s)}
            title={`${s} forecast hour(s) per second`}
            style={{
              background: active ? "#fff" : "transparent",
              color: active ? "#000" : "#eee",
              border: "none",
              borderLeft:
                s === SPEEDS[0] ? "none" : "1px solid rgba(255,255,255,0.15)",
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {s}×
          </button>
        );
      })}
    </div>
  );
}

function PrefetchBar({ pct, done }: { pct: number; done: boolean }) {
  if (done) return null;
  if (pct === 0) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: -2,
        height: 2,
        background: "rgba(126,192,238,0.2)",
        pointerEvents: "none",
        borderRadius: 1,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "#7ec0ee",
          transition: "width 80ms linear",
        }}
      />
    </div>
  );
}
