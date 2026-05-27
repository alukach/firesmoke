// PM2.5 colormap (US EPA AQI breakpoints) baked into a 256-bin RGBA LUT
// for sampling on the GPU. Index i in the LUT corresponds to
// PM2.5 = i * (PM_MAX / 255), with alpha following a sqrt ramp so low
// concentrations are translucent.

export const PM_MAX = 500; // µg/m³ — values beyond this saturate the colormap

type Stop = { pm25: number; rgb: [number, number, number] };

const STOPS: Stop[] = [
  { pm25: 0, rgb: [0, 228, 0] },        // Good — green
  { pm25: 12, rgb: [255, 255, 0] },     // Moderate — yellow
  { pm25: 35, rgb: [255, 126, 0] },     // USG — orange
  { pm25: 55, rgb: [255, 0, 0] },       // Unhealthy — red
  { pm25: 150, rgb: [143, 63, 151] },   // Very unhealthy — purple
  { pm25: 250, rgb: [126, 0, 35] },     // Hazardous — maroon
  { pm25: 500, rgb: [50, 0, 15] },      // Very hazardous — dark
];

function interpRgb(value: number): [number, number, number] {
  if (value <= STOPS[0]!.pm25) return STOPS[0]!.rgb;
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i]!;
    const b = STOPS[i + 1]!;
    if (value <= b.pm25) {
      const t = (value - a.pm25) / (b.pm25 - a.pm25);
      return [
        Math.round(a.rgb[0] + t * (b.rgb[0] - a.rgb[0])),
        Math.round(a.rgb[1] + t * (b.rgb[1] - a.rgb[1])),
        Math.round(a.rgb[2] + t * (b.rgb[2] - a.rgb[2])),
      ];
    }
  }
  return STOPS[STOPS.length - 1]!.rgb;
}

function alphaFor(value: number): number {
  if (value <= 0.1) return 0;
  const norm = Math.min(1, Math.sqrt(value / 75));
  return Math.round(40 + norm * 180);
}

/**
 * Build a 256x1 RGBA Uint8Array LUT. Bin i represents
 * PM2.5 = (i / 255) * PM_MAX. Alpha is pre-baked.
 */
export function buildColormapLut(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const pm25 = (i / 255) * PM_MAX;
    const [r, g, b] = interpRgb(pm25);
    lut[i * 4 + 0] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = alphaFor(pm25);
  }
  return lut;
}

/** Color/legend pairs for a UI legend strip. */
export const LEGEND = STOPS.map((s) => ({
  pm25: s.pm25,
  color: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})`,
}));
