import { useEffect, useState } from "react";
import { currentPosition, SPEEDS, type PlaybackState, type Speed } from "./playback.ts";
import type { ForecastMeta, Frame, PrefetchProgress } from "./useForecast.ts";
import { useIsCompact } from "./useResponsive.ts";

// Re-export so legacy import paths (Controls.tsx → Speed) keep working
// without touching every caller in this commit.
export type { Speed };

// How often to update the slider position + readouts while playing.
// Decoupled from the GPU animation rate so the textual UI doesn't churn React
// at 60Hz.
const DISPLAY_HZ = 10;

// Reserved on the right edge so MapLibre's bottom-right attribution stays
// visible behind the controls panel.
const ATTRIBUTION_GUTTER = 140;

function fmtForecast(ts: number, utc: boolean): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    timeZone: utc ? "UTC" : undefined,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function fmtRun(ts: number, utc: boolean): string {
  const d = new Date(ts);
  // Compact form for the run init time — it's secondary info.
  return d.toLocaleString(undefined, {
    timeZone: utc ? "UTC" : undefined,
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
  const isCompact = useIsCompact();
  const N = meta.validTimes.length;
  const [displayPos, setDisplayPos] = useState(() =>
    currentPosition(playback, N),
  );
  // Default to the user's local timezone. Click the time readout to
  // toggle to UTC (useful for cross-referencing the BlueSky run names).
  const [useUtc, setUseUtc] = useState(false);
  const toggleTz = () => setUseUtc((u) => !u);

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
  // Clamp at the wrap (idxA = N-1, idxB = 0): the forecast doesn't wrap,
  // so interpolating from validTimes[N-1] to validTimes[0] produces a
  // ~2.5-day backwards jump in the readout. Hold the last frame's time.
  const wrapping = idxA === N - 1;
  const validTimeNow = wrapping
    ? meta.validTimes[idxA]!
    : meta.validTimes[idxA]! +
      tMix * (meta.validTimes[idxB]! - meta.validTimes[idxA]!);
  const initTimeNow = wrapping
    ? meta.initTimes[idxA]!
    : tMix < 0.5
      ? meta.initTimes[idxA]!
      : meta.initTimes[idxB]!;

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

  // On compact viewports MapLibre auto-collapses the attribution to a small
  // "i" button so we don't need to reserve a wide gutter for it.
  const gutter = isCompact ? 12 : ATTRIBUTION_GUTTER;
  const headlineFs = isCompact ? 15 : 17;
  const subFs = isCompact ? 13 : 14;

  const slider = (
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
        <span>{fmtForecast(meta.validTimes[0]!, useUtc)}</span>
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
        <span>{fmtForecast(meta.validTimes[N - 1]!, useUtc)}</span>
      </div>
    </div>
  );

  const playButton = (
    <button
      onClick={handlePlayToggle}
      style={{
        background: "#fff",
        color: "#000",
        border: "none",
        borderRadius: 4,
        padding: isCompact ? "10px 14px" : "6px 12px",
        fontWeight: 600,
        cursor: "pointer",
        minWidth: isCompact ? 80 : 64,
        fontSize: isCompact ? 14 : 13,
      }}
    >
      {playback.playing ? "⏸ Pause" : "▶ Play"}
    </button>
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        padding: `12px ${gutter}px ${isCompact ? 12 : 16}px 16px`,
        background:
          "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.55) 80%, transparent)",
        color: "#eee",
        fontSize: 13,
        pointerEvents: "auto",
      }}
    >
      {isCompact ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {playButton}
            <SpeedPicker
              value={playback.speed}
              onChange={onSpeedChange}
              compact={isCompact}
            />
          </div>
          {slider}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          {playButton}
          <SpeedPicker
            value={playback.speed}
            onChange={onSpeedChange}
            compact={isCompact}
          />
          {slider}
        </div>
      )}

      {/* Headline row: prominent forecast time + max PM2.5; small dim
          run-init line beneath. */}
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
            gap: isCompact ? 12 : 16,
            flexWrap: "wrap",
          }}
        >
          <span
            onClick={toggleTz}
            title={`Click to switch to ${useUtc ? "local time" : "UTC"}`}
            style={{
              fontSize: headlineFs,
              fontWeight: 600,
              cursor: "pointer",
              userSelect: "none",
              // Tabular-nums + min-width keeps the digit columns
              // stable so the adjacent Max PM2.5 doesn't shift as the
              // displayed time (or timezone abbreviation) changes width.
              fontVariantNumeric: "tabular-nums",
              display: "inline-block",
              minWidth: isCompact ? undefined : "22ch",
            }}
          >
            {fmtForecast(validTimeNow, useUtc)}
          </span>
          <span style={{ fontSize: subFs, opacity: 0.85 }}>
            Max PM2.5:{" "}
            <span
              style={{
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                display: "inline-block",
                minWidth: "5ch",
                textAlign: "right",
              }}
            >
              {maxPm25 !== null ? maxPm25.toFixed(1) : "—"}
            </span>{" "}
            µg/m³
          </span>
        </div>
        <div
          onClick={toggleTz}
          style={{ fontSize: 11, opacity: 0.55, cursor: "pointer", userSelect: "none" }}
        >
          from {fmtRun(initTimeNow, useUtc)} run
        </div>
      </div>
    </div>
  );
}

function SpeedPicker({
  value,
  onChange,
  compact,
}: {
  value: Speed;
  onChange: (s: Speed) => void;
  compact: boolean;
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
              padding: compact ? "10px 12px" : "6px 10px",
              fontSize: compact ? 13 : 12,
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
