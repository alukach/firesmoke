import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { colorAt, pmCategory, type Palette } from "./colormap.ts";
import { currentPosition, type PlaybackState } from "./playback.ts";
import type { ForecastMeta, Frame } from "./useForecast.ts";
import { useIsCompact, useViewportWidth } from "./useResponsive.ts";

const PAD = { top: 8, right: 76, bottom: 38, left: 12 };
const DISPLAY_HZ = 10;
const SIDE_GUTTER = 16;
const HEADER_HEIGHT = 28;

export type SelectedPoint = { lat: number; lon: number };

type Props = {
  point: SelectedPoint;
  meta: ForecastMeta;
  peekFrame: (idx: number) => Frame | null;
  framesVersion: number;
  palette: Palette;
  playback: PlaybackState;
  playbackRef: { readonly current: PlaybackState };
  onSeek: (position: number) => void;
  onClose: () => void;
};

function fmtCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

// Solar-time offset from UTC, in hours, derived from longitude (15° per hour).
// Accurate to ~30 min; ignores DST. The goal is "what is the sun doing at this
// point" — close enough for "morning / afternoon / evening" reasoning.
function tzOffsetHours(lon: number): number {
  return Math.round(lon / 15);
}

/** Shift a UTC timestamp into the point's local solar time and return a Date. */
function localDate(ts: number, offsetHours: number): Date {
  return new Date(ts + offsetHours * 3600_000);
}

/** Short weekday abbreviation in local solar time (e.g. "Wed"). */
function fmtDay(ts: number, offsetHours: number): string {
  const d = localDate(ts, offsetHours);
  return d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
}

/** Full date + time for hover tooltips (e.g. "Wed May 28, 14:00 local"). */
function fmtFullLocal(ts: number, offsetHours: number): string {
  const d = localDate(ts, offsetHours);
  return d.toLocaleString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " local";
}

export function PointChart({
  point,
  meta,
  peekFrame,
  framesVersion,
  palette,
  playback,
  playbackRef,
  onSeek,
  onClose,
}: Props) {
  const N = meta.validTimes.length;
  const isCompact = useIsCompact();
  const vw = useViewportWidth();
  // JS-side echo of the CSS clamp(220px, 30vh, 360px) on the drawer wrapper.
  // SVG's height attribute doesn't honor CSS clamp(), so we mirror it here.
  const drawerH = Math.max(220, Math.min(360, window.innerHeight * 0.3));
  const chartH = drawerH - HEADER_HEIGHT - 12;
  const chartW = vw - SIDE_GUTTER * 2;
  const innerW = chartW - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;

  // Sample the time series at the nearest grid cell.
  // framesVersion bumps once per frame as prefetch streams in, so we
  // defer it: the chart's existing bars stay rendered while React waits
  // to process the new sample pass, instead of doing N work per arrival.
  const deferredFramesVersion = useDeferredValue(framesVersion);
  const { series, inBounds } = useMemo(() => {
    const lonStep = (meta.lonMax - meta.lonMin) / Math.max(1, meta.width - 1);
    const latStep = (meta.latMax - meta.latMin) / Math.max(1, meta.height - 1);
    const col = Math.round((point.lon - meta.lonMin) / lonStep);
    const row = Math.round((point.lat - meta.latMin) / latStep);
    const ok = col >= 0 && col < meta.width && row >= 0 && row < meta.height;
    const s: (number | null)[] = new Array(N).fill(null);
    if (ok) {
      for (let i = 0; i < N; i++) {
        const f = peekFrame(i);
        if (f) s[i] = f.data[row * meta.width + col]!;
      }
    }
    return { series: s, inBounds: ok };
    // deferredFramesVersion is intentional: bumps as new frames land in
    // the cache (and tells React to re-sample).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point, meta, peekFrame, deferredFramesVersion, N]);

  // Live scrubber position (separate state, throttled to 10Hz while playing).
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

  const maxVal = useMemo(() => {
    let m = 1; // floor so an all-zero series still draws an axis
    for (const v of series) if (v !== null && v > m) m = v;
    // Round up to a nice axis tick.
    if (m <= 50) return Math.ceil(m / 10) * 10;
    if (m <= 250) return Math.ceil(m / 25) * 25;
    if (m <= 1000) return Math.ceil(m / 100) * 100;
    return Math.ceil(m / 500) * 500;
  }, [series]);

  const tzOff = tzOffsetHours(point.lon);

  // Hour ticks at 06/12/18/00 in local solar time. On compact viewports drop
  // to every 12 hours (00/12) to avoid label crowding.
  const hourStep = isCompact ? 12 : 6;
  const hourTicks = useMemo(() => {
    const ticks: { i: number; hour: string; isMidnight: boolean }[] = [];
    for (let i = 0; i < N; i++) {
      const d = localDate(meta.validTimes[i]!, tzOff);
      const h = d.getUTCHours();
      if (h % hourStep !== 0) continue;
      ticks.push({ i, hour: String(h).padStart(2, "0"), isMidnight: h === 0 });
    }
    return ticks;
  }, [meta.validTimes, N, tzOff, hourStep]);

  // Day groups: contiguous indices that share a local-solar date. Used to
  // center day labels under each day's span.
  const dayGroups = useMemo(() => {
    const groups: { startI: number; endI: number; label: string }[] = [];
    let currentKey = "";
    for (let i = 0; i < N; i++) {
      const d = localDate(meta.validTimes[i]!, tzOff);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (key !== currentKey) {
        groups.push({
          startI: i,
          endI: i,
          label: fmtDay(meta.validTimes[i]!, tzOff),
        });
        currentKey = key;
      } else {
        groups[groups.length - 1]!.endI = i;
      }
    }
    return groups;
  }, [meta.validTimes, N, tzOff]);

  // Which day group currently contains the scrubber? Used to bold its label.
  const activeDayGroup = useMemo(() => {
    const i = Math.floor(displayPos);
    return dayGroups.findIndex((g) => i >= g.startI && i <= g.endI);
  }, [dayGroups, displayPos]);

  const barW = innerW / Math.max(1, N);

  // PM2.5 at the scrubber (linearly interpolated between adjacent frames,
  // clamped at the wrap so we don't blend the last hour into the first).
  const scrubVal = useMemo(() => {
    const i = Math.floor(displayPos);
    const a = series[i];
    if (i === N - 1) return a ?? null;
    const j = (i + 1) % N;
    const t = displayPos - i;
    const b = series[j];
    if (a === null && b === null) return null;
    if (a === null) return b;
    if (b === null) return a;
    return a * (1 - t) + b * t;
  }, [displayPos, series, N]);

  const scrubX = PAD.left + (displayPos / Math.max(1, N)) * innerW;

  // Click + drag (mouse or touch) along the chart to scrub.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef(false);

  const seekFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left - PAD.left;
    const pos = Math.max(0, Math.min(N - 0.001, (x / innerW) * N));
    onSeek(pos);
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    draggingRef.current = true;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    seekFromClientX(e.clientX);
  };
  const stopDragging = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: "var(--controls-height, 0px)",
        left: 0,
        right: 0,
        padding: `12px ${SIDE_GUTTER}px 12px ${SIDE_GUTTER}px`,
        background:
          "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.55))",
        color: "#eee",
        fontSize: 12,
        boxShadow: "0 -2px 8px rgba(0, 0, 0, 0.35)",
        pointerEvents: "auto",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        height: "clamp(220px, 30vh, 360px)",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>{fmtCoord(point.lat, point.lon)}</div>
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close point chart"
          style={{
            background: "transparent",
            color: "#eee",
            border: "none",
            cursor: "pointer",
            fontSize: 16,
            padding: 0,
            lineHeight: 1,
            opacity: 0.6,
          }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.65,
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          columnGap: 8,
        }}
      >
        <span>PM2.5 (µg/m³)</span>
        <span>
          now:{" "}
          <span style={{ color: "#fff", fontWeight: 600 }}>
            {scrubVal === null ? "—" : scrubVal.toFixed(1)}
          </span>
          {scrubVal !== null && (
            <>
              {" "}—{" "}
              <span
                style={{
                  color: colorAt(palette, scrubVal),
                  fontWeight: 600,
                }}
              >
                {pmCategory(scrubVal, isCompact)}
              </span>
            </>
          )}
        </span>
      </div>
      {!inBounds ? (
        <div style={{ padding: "16px 0", textAlign: "center", opacity: 0.7 }}>
          Outside forecast domain
        </div>
      ) : (
        <svg
          ref={svgRef}
          width={chartW}
          height={chartH}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          style={{
            cursor: "pointer",
            display: "block",
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          {/* baseline */}
          <line
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={PAD.top + innerH}
            y2={PAD.top + innerH}
            stroke="rgba(255,255,255,0.2)"
          />
          {/* max-y tick */}
          <text
            x={PAD.left}
            y={PAD.top + 8}
            fontSize={9}
            fill="rgba(255,255,255,0.5)"
          >
            {maxVal}
          </text>
          {/* EPA AQI thresholds — dashed lines + category labels */}
          {[
            { pm: 12, label: "Moderate" },
            { pm: 35, label: "Sensitive" },
            { pm: 55, label: "Unhealthy" },
            { pm: 150, label: "V.Unhealthy" },
          ].map((t) => {
            if (t.pm > maxVal) return null;
            const y = PAD.top + innerH - (t.pm / maxVal) * innerH;
            return (
              <g key={`t${t.pm}`}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + innerW}
                  y1={y}
                  y2={y}
                  stroke="rgba(255,255,255,0.18)"
                  strokeDasharray="2 3"
                />
                <text
                  x={PAD.left + innerW + 4}
                  y={y + 3}
                  fontSize={8}
                  fill="rgba(255,255,255,0.55)"
                  textAnchor="start"
                >
                  {t.label}
                </text>
              </g>
            );
          })}
          {/* bars */}
          {series.map((v, i) => {
            if (v === null) return null;
            if (v < 0.1) return null;
            const h = Math.max(1, (v / maxVal) * innerH);
            const x = PAD.left + i * barW;
            const y = PAD.top + innerH - h;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={Math.max(1, barW - 0.5)}
                height={h}
                fill={colorAt(palette, v)}
              />
            );
          })}
          {/* scrubber */}
          <line
            x1={scrubX}
            x2={scrubX}
            y1={PAD.top}
            y2={PAD.top + innerH}
            stroke="#fff"
            strokeWidth={1.5}
            pointerEvents="none"
          />
          <circle
            cx={scrubX}
            cy={PAD.top}
            r={3}
            fill="#fff"
            pointerEvents="none"
          />
          {/* Hour ticks — small marks above the day-name row */}
          {hourTicks.map((t) => {
            const x = PAD.left + (t.i + 0.5) * barW;
            return (
              <g key={`h${t.i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={PAD.top + innerH}
                  y2={PAD.top + innerH + (t.isMidnight ? 5 : 3)}
                  stroke={t.isMidnight ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.25)"}
                />
                <text
                  x={x}
                  y={PAD.top + innerH + 14}
                  fontSize={9}
                  fill={t.isMidnight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.5)"}
                  textAnchor="middle"
                >
                  {t.hour}
                </text>
              </g>
            );
          })}
          {/* Day labels — centered under each day's span */}
          {dayGroups.map((g, gi) => {
            const cx = PAD.left + ((g.startI + g.endI + 1) / 2) * barW;
            const isActive = gi === activeDayGroup;
            return (
              <text
                key={`d${gi}`}
                x={cx}
                y={chartH - 4}
                fontSize={10}
                fontWeight={isActive ? 600 : 400}
                fill={isActive ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)"}
                textAnchor="middle"
              >
                {g.label}
              </text>
            );
          })}
          {/* Accessible full timestamp for first/last bars (screen-reader tooltip) */}
          <title>
            {`${fmtFullLocal(meta.validTimes[0]!, tzOff)} → ${fmtFullLocal(meta.validTimes[N - 1]!, tzOff)}`}
          </title>
        </svg>
      )}
    </div>
  );
}
