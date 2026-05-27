import { PALETTES, type Palette, type PaletteId } from "./colormap.ts";

// Width of each swatch+label column in the legend. Wide enough to fit
// 3-digit labels like "250" or "500" without overflowing.
const SWATCH_WIDTH = 28;

type Props = {
  palette: Palette;
  paletteId: PaletteId;
  onPaletteChange: (id: PaletteId) => void;
};

/**
 * Floating top-right card with the palette picker and legend.
 * Kept out of the bottom controls bar so it doesn't overlap with
 * MapLibre's bottom-right attribution.
 */
export function PaletteCard({ palette, paletteId, onPaletteChange }: Props) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        padding: "10px 12px",
        background: "rgba(0, 0, 0, 0.78)",
        color: "#eee",
        borderRadius: 6,
        fontSize: 12,
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <PalettePicker value={paletteId} onChange={onPaletteChange} />
      <Legend palette={palette} />
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
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              flex: 1,
            }}
          >
            {PALETTES[id]!.label}
          </button>
        );
      })}
    </div>
  );
}

function Legend({ palette }: { palette: Palette }) {
  return (
    <div>
      <div
        style={{
          opacity: 0.6,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        PM2.5 (µg/m³)
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            borderRadius: 3,
            overflow: "hidden",
            height: 14,
          }}
        >
          {palette.legend.map((s) => (
            <div
              key={s.pm25}
              title={`${s.pm25}+`}
              style={{ width: SWATCH_WIDTH, background: s.color }}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 10,
            opacity: 0.7,
            marginTop: 2,
          }}
        >
          {palette.legend.map((s) => (
            <div
              key={s.pm25}
              style={{ width: SWATCH_WIDTH, textAlign: "center" }}
            >
              {s.pm25}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
