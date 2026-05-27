// Fetches BlueSky Canada's published fire-detection KMLs (the input to
// the dispersion forecast) and converts them to GeoJSON for deck.gl.
//
// Two layers:
//   fire_locations.kml — point features for each detected hotspot
//   fire_outlines.kml  — polygon features for the active-fire perimeters
//
// Both are refreshed roughly with each forecast run, so we re-fetch on
// mount. If firesmoke.ca's CORS posture changes and the fetches fail,
// we silently return null layers — the rest of the viewer still works.

import { kml } from "@tmcw/togeojson";
import type { FeatureCollection } from "geojson";
import { useEffect, useState } from "react";

const FIRE_OUTLINES_URL =
  "https://firesmoke.ca/forecasts/current/fire_outlines.kml";
const FIRE_LOCATIONS_URL =
  "https://firesmoke.ca/forecasts/current/fire_locations.kml";

export type FireData = {
  outlines: FeatureCollection | null;
  locations: FeatureCollection | null;
  error: string | null;
  loading: boolean;
};

async function fetchKml(url: string): Promise<FeatureCollection> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} (${url})`);
  const text = await r.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  return kml(doc) as FeatureCollection;
}

export function useFireData(): FireData {
  const [data, setData] = useState<FireData>({
    outlines: null,
    locations: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      fetchKml(FIRE_OUTLINES_URL),
      fetchKml(FIRE_LOCATIONS_URL),
    ]).then((results) => {
      if (cancelled) return;
      const [outlinesR, locationsR] = results;
      const outlines =
        outlinesR.status === "fulfilled" ? outlinesR.value : null;
      const locations =
        locationsR.status === "fulfilled" ? locationsR.value : null;
      const errors = results
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? "error")
        .join("; ");
      setData({
        outlines,
        locations,
        error: errors || null,
        loading: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}
