import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { colorAt, type Palette } from "./colormap.ts";
import { currentPosition, type PlaybackState } from "./playback.ts";
import type { ForecastMeta, Frame } from "./useForecast.ts";
import { useIsCompact, useViewportWidth } from "./useResponsive.ts";

const MAX_WIDTH = 380;
const HEIGHT = 130;
const PAD = { top: 8, right: 10, bottom: 22, left: 10 };
const DISPLAY_HZ = 10;
// Reserve horizontal space at the edge of the viewport so the card never
// touches the screen edge.
const SIDE_MARGIN = 24;
// Vertical clearance below the PaletteCard, which is pinned to the same
// top-right corner.
const PALETTE_CARD_CLEARANCE = 110;
const PALETTE_CARD_CLEARANCE_COMPACT = 96;

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

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
  // PointChart sits below the PaletteCard on the right edge, so it has the
  // full right-side column to itself. Cap at MAX_WIDTH on desktop.
  const chartW = isCompact
    ? Math.max(220, vw - SIDE_MARGIN * 2)
    : Math.min(MAX_WIDTH, vw - SIDE_MARGIN * 2);
  const innerW = chartW - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

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
        top: isCompact ? PALETTE_CARD_CLEARANCE_COMPACT : PALETTE_CARD_CLEARANCE,
        right: 12,
        padding: "10px 12px 8px",
        background: "rgba(0, 0, 0, 0.78)",
        color: "#eee",
        borderRadius: 6,
        fontSize: 12,
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        pointerEvents: "auto",
        // Stack explicitly above the map (and the smoke layer rendered
        // by deck.gl's MapboxOverlay) regardless of DOM order.
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        width: chartW + 24,
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
      <div style={{ fontSize: 11, opacity: 0.65, display: "flex", justifyContent: "space-between" }}>
        <span>PM2.5 over forecast (µg/m³)</span>
        <span>
          now:{" "}
          <span style={{ color: "#fff", fontWeight: 600 }}>
            {scrubVal === null ? "—" : `${scrubVal.toFixed(1)}`}
          </span>
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
          height={HEIGHT}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          style={{ cursor: "pointer", display: "block", touchAction: "none" }}
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
          {/* x-axis labels: start / mid / end */}
          {N >= 2 && (
            <>
              <text
                x={PAD.left}
                y={HEIGHT - 4}
                fontSize={9}
                fill="rgba(255,255,255,0.5)"
                textAnchor="start"
              >
                {fmtTime(meta.validTimes[0]!)}
              </text>
              <text
                x={PAD.left + innerW / 2}
                y={HEIGHT - 4}
                fontSize={9}
                fill="rgba(255,255,255,0.5)"
                textAnchor="middle"
              >
                {fmtTime(meta.validTimes[Math.floor(N / 2)]!)}
              </text>
              <text
                x={PAD.left + innerW}
                y={HEIGHT - 4}
                fontSize={9}
                fill="rgba(255,255,255,0.5)"
                textAnchor="end"
              >
                {fmtTime(meta.validTimes[N - 1]!)}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}
