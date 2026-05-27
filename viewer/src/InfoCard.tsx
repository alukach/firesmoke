// Small floating "info" card explaining the app and linking to the
// repo + data sources. Collapsed to a single icon by default to stay
// out of the way; click to expand.

import { useState } from "react";
import { useIsCompact } from "./useResponsive.ts";

const REPO_URL = "https://github.com/alukach/firesmoke";
const FIRESMOKE_URL = "https://firesmoke.ca/";
const BLUESKY_URL = "https://firesmoke.ca/about/";

export function InfoCard() {
  const isCompact = useIsCompact();
  const [open, setOpen] = useState(false);

  // Tuck under the PaletteCard at top-right. PaletteCard's height is
  // roughly: padding (20) + picker (~28) + gap (8) + legend (~40) — call
  // it ~96, plus the top offset of the PaletteCard itself plus an 8px gap.
  const top = (isCompact ? 8 : 12) + 96 + 8;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="About this viewer"
        aria-label="About"
        style={{
          position: "absolute",
          top,
          right: isCompact ? 8 : 12,
          width: 30,
          height: 30,
          padding: 0,
          background: "rgba(0, 0, 0, 0.78)",
          color: "#eee",
          border: "none",
          borderRadius: "50%",
          cursor: "pointer",
          fontSize: 16,
          fontWeight: 600,
          fontFamily: "Georgia, serif",
          fontStyle: "italic",
          boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
          pointerEvents: "auto",
          zIndex: 10,
        }}
      >
        i
      </button>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        top,
        right: isCompact ? 8 : 12,
        maxWidth: 300,
        padding: "10px 12px",
        background: "rgba(0, 0, 0, 0.82)",
        color: "#eee",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.45,
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        pointerEvents: "auto",
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 6,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>About</div>
        <button
          onClick={() => setOpen(false)}
          title="Close"
          aria-label="Close"
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
      <p style={{ margin: "0 0 8px" }}>
        An animated viewer for North-American wildfire smoke forecasts.
        Click anywhere on the map to inspect PM<sub>2.5</sub> over time
        at that point.
      </p>
      <p style={{ margin: "0 0 4px", opacity: 0.75, fontSize: 11 }}>
        Data:{" "}
        <Link href={FIRESMOKE_URL}>firesmoke.ca</Link>
        {" / "}
        <Link href={BLUESKY_URL}>BlueSky Canada</Link>
        {" "}(UBC Weather Forecast Research Team), reprocessed into
        zarr-v3 for browser playback. Fire detections from{" "}
        <Link href="https://cwfis.cfs.nrcan.gc.ca/">NRCan CWFIS</Link>.
      </p>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 11 }}>
        Source: <Link href={REPO_URL}>{REPO_URL.replace(/^https?:\/\//, "")}</Link>
      </p>
    </div>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "#9cd6ff", textDecoration: "none" }}
    >
      {children}
    </a>
  );
}
