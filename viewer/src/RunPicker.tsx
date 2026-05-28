import { useEffect, useRef, useState } from "react";

type Props = {
  initTimes: number[];           // ms since epoch, ascending
  selectedIdx: number;
  onSelect: (idx: number) => void;
};

const MAX_VISIBLE = 8;
const MAX_TOTAL = 30;

function fmtRun(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC";
}

function fmtAge(ts: number, now: number): string {
  const dh = Math.round((now - ts) / 3600_000);
  if (dh <= 0) return "latest";
  if (dh < 24) return `${dh}h ago`;
  const dd = Math.round(dh / 24);
  return `${dd}d ago`;
}

export function RunPicker({ initTimes, selectedIdx, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (initTimes.length === 0) return null;

  // init_time is stored in arrival order, not sorted (see ingest spec).
  // Sort by timestamp descending for display, mapping back to the original
  // storage index so onSelect receives an index the worker can slice.
  const sortedStorageIdx = initTimes
    .map((_, i) => i)
    .sort((a, b) => initTimes[b]! - initTimes[a]!);
  const latestStorageIdx = sortedStorageIdx[0]!;
  const isLatest = selectedIdx === latestStorageIdx;
  const now = initTimes[latestStorageIdx]!;
  const limit = expanded
    ? Math.min(MAX_TOTAL, sortedStorageIdx.length)
    : Math.min(MAX_VISIBLE, sortedStorageIdx.length);

  const visible: number[] = sortedStorageIdx.slice(0, limit);

  const sel = initTimes[selectedIdx]!;
  const label = isLatest
    ? `Run: latest · ${fmtRun(sel)}`
    : `Run: ${fmtAge(sel, now)} · ${fmtRun(sel)}`;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch forecast run"
        style={{
          background: isLatest ? "rgba(255,255,255,0.08)" : "rgba(255, 180, 60, 0.22)",
          color: "#fff",
          border: isLatest
            ? "1px solid rgba(255,255,255,0.15)"
            : "1px solid rgba(255, 180, 60, 0.55)",
          borderRadius: 6,
          padding: "4px 10px",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {!isLatest && <span aria-hidden>⚠</span>}
        <span>{label}</span>
        <span aria-hidden style={{ opacity: 0.6 }}>⌄</span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            minWidth: 280,
            background: "rgba(0, 0, 0, 0.92)",
            color: "#eee",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            padding: 4,
            maxHeight: 320,
            overflowY: "auto",
            zIndex: 20,
          }}
        >
          {visible.map((i) => {
            const ts = initTimes[i]!;
            const isSel = i === selectedIdx;
            const ageLabel = i === latestStorageIdx ? "latest" : fmtAge(ts, now);
            return (
              <button
                key={i}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => {
                  onSelect(i);
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  background: isSel ? "rgba(255,255,255,0.08)" : "transparent",
                  color: "#eee",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 12,
                  fontWeight: isSel ? 700 : 400,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ opacity: isSel ? 1 : 0.5 }}>{isSel ? "●" : "○"}</span>
                  <span>{fmtRun(ts)}</span>
                </span>
                <span style={{ opacity: 0.6 }}>{ageLabel}</span>
              </button>
            );
          })}
          {!expanded && initTimes.length > MAX_VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              style={{
                width: "100%",
                background: "transparent",
                color: "rgba(255,255,255,0.6)",
                border: "none",
                borderTop: "1px solid rgba(255,255,255,0.1)",
                padding: "6px 8px",
                fontSize: 11,
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              Show more ({Math.min(MAX_TOTAL, initTimes.length) - MAX_VISIBLE} older runs)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
