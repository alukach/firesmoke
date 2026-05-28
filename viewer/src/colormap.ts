// PM2.5 colormaps as 256x1 RGBA LUTs sampled on the GPU.
//
// Each palette is a list of stops with PM2.5 thresholds, RGB, and alpha.
// `buildLut` linearly interpolates RGBA between adjacent stops across a
// 256-bin LUT spanning [0, PM_MAX] µg/m³. The shader samples the LUT with
// LINEAR filtering for smooth color transitions.

export const PM_MAX = 500; // µg/m³ — values beyond saturate to the last stop

type Stop = {
  pm25: number;
  rgb: [number, number, number];
  /** 0-255. Use 0 to make a stop fully transparent (e.g. below threshold). */
  alpha: number;
};

export type LegendEntry = { pm25: number; color: string };

export type Palette = {
  id: string;
  label: string;
  stops: Stop[];
  /** Stops to show in the UI legend (typically excludes the alpha=0 anchor). */
  legend: LegendEntry[];
};

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

// US EPA AQI breakpoints — what we shipped originally.
const EPA_AQI_STOPS: Stop[] = [
  { pm25: 0,   rgb: [0, 228, 0],    alpha: 0 },     // transparent baseline
  { pm25: 12,  rgb: [255, 255, 0],  alpha: 120 },
  { pm25: 35,  rgb: [255, 126, 0],  alpha: 170 },
  { pm25: 55,  rgb: [255, 0, 0],    alpha: 200 },
  { pm25: 150, rgb: [143, 63, 151], alpha: 220 },
  { pm25: 250, rgb: [126, 0, 35],   alpha: 220 },
  { pm25: 500, rgb: [50, 0, 15],    alpha: 220 },
];

// firesmoke.ca's published palette.
const FIRESMOKE_STOPS: Stop[] = [
  { pm25: 0,   rgb: [255, 255, 255], alpha: 0 },    // transparent below threshold
  { pm25: 1,   rgb: [0xff, 0xf7, 0xbc], alpha: 140 },
  { pm25: 10,  rgb: [0xfe, 0xe3, 0x91], alpha: 175 },
  { pm25: 28,  rgb: [0xfe, 0xc4, 0x4f], alpha: 200 },
  { pm25: 60,  rgb: [0xfe, 0x99, 0x29], alpha: 220 },
  { pm25: 120, rgb: [0xcc, 0x4c, 0x02], alpha: 230 },
  { pm25: 250, rgb: [0x66, 0x25, 0x06], alpha: 235 },
];

function stopsToLegend(stops: Stop[]): LegendEntry[] {
  return stops
    .filter((s) => s.alpha > 0)
    .map((s) => ({
      pm25: s.pm25,
      color: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})`,
    }));
}

export const PALETTES: Record<string, Palette> = {
  "epa-aqi": {
    id: "epa-aqi",
    label: "EPA AQI",
    stops: EPA_AQI_STOPS,
    legend: stopsToLegend(EPA_AQI_STOPS),
  },
  firesmoke: {
    id: "firesmoke",
    label: "Firesmoke",
    stops: FIRESMOKE_STOPS,
    legend: stopsToLegend(FIRESMOKE_STOPS),
  },
};

export type PaletteId = keyof typeof PALETTES;

// ---------------------------------------------------------------------------
// LUT construction
// ---------------------------------------------------------------------------

function interpStops(stops: Stop[], pm25: number): [number, number, number, number] {
  if (pm25 <= stops[0]!.pm25) {
    const s = stops[0]!;
    return [s.rgb[0], s.rgb[1], s.rgb[2], s.alpha];
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (pm25 <= b.pm25) {
      const t = (pm25 - a.pm25) / (b.pm25 - a.pm25);
      return [
        Math.round(a.rgb[0] + t * (b.rgb[0] - a.rgb[0])),
        Math.round(a.rgb[1] + t * (b.rgb[1] - a.rgb[1])),
        Math.round(a.rgb[2] + t * (b.rgb[2] - a.rgb[2])),
        Math.round(a.alpha + t * (b.alpha - a.alpha)),
      ];
    }
  }
  const last = stops[stops.length - 1]!;
  return [last.rgb[0], last.rgb[1], last.rgb[2], last.alpha];
}

/** Build a 256x1 RGBA8 LUT. Bin i represents PM2.5 = (i / 255) * PM_MAX. */
export function buildLut(palette: Palette): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const pm25 = (i / 255) * PM_MAX;
    const [r, g, b, a] = interpStops(palette.stops, pm25);
    lut[i * 4 + 0] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = a;
  }
  return lut;
}

/** CSS rgba color for an arbitrary PM2.5 value. Mirrors the GPU LUT logic. */
export function colorAt(palette: Palette, pm25: number): string {
  const [r, g, b, a] = interpStops(palette.stops, pm25);
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

export type CategoryStyle = { bg: string; fg: string };

/** Pill style for an EPA AQI category: bar color as background, auto-contrast
 * text color so every category remains legible (white on bright greens / yellows
 * would fail; black on dark reds / purples would fail; this picks per stop). */
export function categoryStyle(palette: Palette, pm25: number): CategoryStyle {
  const [r, g, b] = interpStops(palette.stops, pm25);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    bg: `rgb(${r}, ${g}, ${b})`,
    fg: lum > 140 ? "rgba(0, 0, 0, 0.88)" : "#fff",
  };
}

/** EPA AQI category for a PM2.5 value (µg/m³). Thresholds match EPA_AQI_STOPS. */
export function pmCategory(pm25: number, compact = false): string {
  if (pm25 < 12) return compact ? "Good" : "Good";
  if (pm25 < 35) return compact ? "Mod" : "Moderate";
  if (pm25 < 55) return compact ? "USG" : "Unhealthy for Sensitive Groups";
  if (pm25 < 150) return compact ? "Unh" : "Unhealthy";
  if (pm25 < 250) return compact ? "V.Unh" : "Very Unhealthy";
  return compact ? "Haz" : "Hazardous";
}
