import { useEffect, useState } from "react";
import { currentPosition, type PlaybackState } from "./App.tsx";
import { PALETTES, type Palette, type PaletteId } from "./colormap.ts";
import type { ForecastMeta, Frame, PrefetchProgress } from "./useForecast.ts";

const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

// How often to update the slider position + readouts while playing.
// Decoupled from the GPU animation rate so the textual UI doesn't churn React
// at 60Hz.
const DISPLAY_HZ = 10;

function fmt(ts: number): string {
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
  palette: Palette;
  paletteId: PaletteId;
  onPaletteChange: (id: PaletteId) => void;
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
  palette,
  paletteId,
  onPaletteChange,
}: Props) {
  const N = meta.validTimes.length;
  // The displayed slider/readout position. Only updated by the 10Hz ticker
  // while playing; otherwise reflects playback.originPosition directly.
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

  // Read current frames sync-only for the max-PM2.5 readout (no React state
  // for frame data).
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
        padding: "12px 16px 16px",
        background:
          "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.55) 80%, transparent)",
        color: "#eee",
        fontSize: 13,
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
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
            <span>{fmt(meta.validTimes[0]!)}</span>
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
            <span>{fmt(meta.validTimes[N - 1]!)}</span>
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 24,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Readout label="Valid" value={fmt(validTimeNow)} bold />
        <Readout label="From run" value={fmt(initTimeNow)} />
        <Readout
          label="Max PM2.5"
          value={maxPm25 !== null ? `${maxPm25.toFixed(1)} µg/m³` : "—"}
        />
        <PalettePicker value={paletteId} onChange={onPaletteChange} />
        <Legend palette={palette} />
      </div>
    </div>
  );
}

function Readout({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <div
        style={{
          opacity: 0.6,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontWeight: bold ? 600 : 400, fontSize: 14 }}>{value}</div>
    </div>
  );
}

function SpeedPicker({ value, onChange }: { value: Speed; onChange: (s: Speed) => void }) {
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
              borderLeft: s === SPEEDS[0] ? "none" : "1px solid rgba(255,255,255,0.15)",
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

// Width of each swatch+label column in the legend. Wide enough to fit
// 3-digit labels like "500" without overflowing.
const SWATCH_WIDTH = 28;

function Legend({ palette }: { palette: Palette }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ opacity: 0.6, fontSize: 11 }}>PM2.5 (µg/m³)</span>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", borderRadius: 3, overflow: "hidden", height: 14 }}>
          {palette.legend.map((s) => (
            <div
              key={s.pm25}
              title={`${s.pm25}+`}
              style={{ width: SWATCH_WIDTH, background: s.color }}
            />
          ))}
        </div>
        <div style={{ display: "flex", fontSize: 10, opacity: 0.7, marginTop: 2 }}>
          {palette.legend.map((s) => (
            <div key={s.pm25} style={{ width: SWATCH_WIDTH, textAlign: "center" }}>
              {s.pm25}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PalettePicker({
  value,
  onChange,
}: {
  value: PaletteId;
  onChange: (id: PaletteId) => void;
}) {
  return (
    <div>
      <div
        style={{
          opacity: 0.6,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 2,
        }}
      >
        Palette
      </div>
      <div
        style={{
          display: "flex",
          borderRadius: 4,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.15)",
        }}
        role="group"
        aria-label="Colormap palette"
      >
        {(Object.keys(PALETTES) as PaletteId[]).map((id, i) => {
          const active = id === value;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              style={{
                background: active ? "#fff" : "transparent",
                color: active ? "#000" : "#eee",
                border: "none",
                borderLeft: i === 0 ? "none" : "1px solid rgba(255,255,255,0.15)",
                padding: "5px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {PALETTES[id]!.label}
            </button>
          );
        })}
      </div>
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
