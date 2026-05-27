import { useCallback, useState } from "react";
import { useIsCompact } from "./useResponsive.ts";

type Bounds = {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
};

type Props = {
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  bounds: Bounds;
};

type Status =
  | { kind: "idle" }
  | { kind: "info"; msg: string }
  | { kind: "error"; msg: string };

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const CITY_ZOOM = 8;

function inBounds(lat: number, lon: number, b: Bounds): boolean {
  return (
    lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax
  );
}

export function SearchCard({ flyTo, bounds }: Props) {
  const isCompact = useIsCompact();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setBusy(true);
      setStatus({ kind: "info", msg: "Searching…" });
      try {
        const url = new URL(NOMINATIM_URL);
        url.searchParams.set("q", trimmed);
        url.searchParams.set("format", "json");
        url.searchParams.set("limit", "1");
        url.searchParams.set("countrycodes", "us,ca,mx");
        const r = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const results = (await r.json()) as Array<{ lat: string; lon: string }>;
        if (results.length === 0) {
          setStatus({ kind: "error", msg: "Not found" });
          return;
        }
        const lat = Number(results[0]!.lat);
        const lon = Number(results[0]!.lon);
        flyTo(lat, lon, CITY_ZOOM);
        setStatus(
          inBounds(lat, lon, bounds)
            ? { kind: "idle" }
            : { kind: "info", msg: "Outside forecast area" },
        );
      } catch (err) {
        setStatus({
          kind: "error",
          msg: err instanceof Error ? err.message : "Search failed",
        });
      } finally {
        setBusy(false);
      }
    },
    [flyTo, bounds],
  );

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus({ kind: "error", msg: "Geolocation unavailable" });
      return;
    }
    setBusy(true);
    setStatus({ kind: "info", msg: "Locating…" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        flyTo(latitude, longitude, CITY_ZOOM);
        setStatus(
          inBounds(latitude, longitude, bounds)
            ? { kind: "idle" }
            : { kind: "info", msg: "Outside forecast area" },
        );
        setBusy(false);
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Permission denied"
            : err.code === err.POSITION_UNAVAILABLE
              ? "Position unavailable"
              : err.code === err.TIMEOUT
                ? "Geolocation timed out"
                : "Geolocation failed";
        setStatus({ kind: "error", msg });
        setBusy(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, [flyTo, bounds]);

  return (
    <div
      style={{
        position: "absolute",
        top: isCompact ? 8 : 12,
        left: isCompact ? 8 : 12,
        padding: isCompact ? "8px 10px" : "10px 12px",
        background: "rgba(0, 0, 0, 0.78)",
        color: "#eee",
        borderRadius: 6,
        fontSize: 12,
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        pointerEvents: "auto",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        width: isCompact ? "calc(100vw - 16px)" : 280,
        maxWidth: "calc(100vw - 16px)",
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query);
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search city or place…"
          aria-label="Search city or place"
          disabled={busy}
          style={{
            flex: 1,
            minWidth: 0,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 4,
            color: "#eee",
            padding: "6px 8px",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={useMyLocation}
          disabled={busy}
          title="Use my location"
          aria-label="Use my location"
          style={{
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 4,
            color: "#eee",
            padding: "6px 10px",
            cursor: busy ? "default" : "pointer",
            fontSize: 14,
          }}
        >
          📍
        </button>
      </form>
      {status.kind !== "idle" && (
        <div
          style={{
            fontSize: 11,
            opacity: 0.75,
            color: status.kind === "error" ? "#ff9b9b" : "#cfd8e3",
          }}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}
