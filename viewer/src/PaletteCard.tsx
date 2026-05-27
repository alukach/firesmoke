import { PALETTES, type Palette, type PaletteId } from "./colormap.ts";
import { useIsCompact } from "./useResponsive.ts";

type Props = {
  palette: Palette;
  paletteId: PaletteId;
  onPaletteChange: (id: PaletteId) => void;
};

/**
 * Floating top-right card with the palette picker and legend.
 * Kept out of the bottom controls bar so it doesn't overlap with
 * MapLibre's bottom-right attribution. Shrinks on phones.
 */
export function PaletteCard({ palette, paletteId, onPaletteChange }: Props) {
  const isCompact = useIsCompact();
  const swatchW = isCompact ? 20 : 28;
  return (
    <div
      style={{
        position: "absolute",
        top: isCompact ? 8 : 12,
        right: isCompact ? 8 : 12,
        padding: isCompact ? "8px 10px" : "10px 12px",
        background: "rgba(0, 0, 0, 0.78)",
        color: "#eee",
        borderRadius: 6,
        fontSize: 12,
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: isCompact ? 6 : 8,
      }}
    >
      <PalettePicker
        value={paletteId}
        onChange={onPaletteChange}
        compact={isCompact}
      />
      <Legend palette={palette} swatchW={swatchW} />
    </div>
  );
}

function PalettePicker({
  value,
  onChange,
  compact,
}: {
  value: PaletteId;
  onChange: (id: PaletteId) => void;
  compact: boolean;
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
              padding: compact ? "8px 10px" : "5px 10px",
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

function Legend({ palette, swatchW }: { palette: Palette; swatchW: number }) {
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
              style={{ width: swatchW, background: s.color }}
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
              style={{ width: swatchW, textAlign: "center" }}
            >
              {s.pm25}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
