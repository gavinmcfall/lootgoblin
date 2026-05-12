'use client';
// ColorBubbles — color swatches sized by mass.
// Canvas ref: ColorBubbles (page-consumption.jsx line 240–262).
// Circle size interpolates 50–120px based on mass fraction.

interface ColorDatum {
  /** CSS color (hex or any valid CSS color) */
  hex: string;
  /** Total mass in kg */
  mass: number;
  name: string;
}

interface Props {
  data: ColorDatum[];
}

export function ColorBubbles({ data }: Props) {
  const max = Math.max(...data.map((d) => d.mass), 0.01);
  return (
    <div className="flex min-h-[180px] flex-wrap items-end gap-4">
      {data.map((c) => {
        const size = 50 + (c.mass / max) * 70;
        return (
          <div
            key={c.hex}
            className="flex flex-col items-center gap-2"
          >
            <div
              style={{
                width: size,
                height: size,
                borderRadius: '50%',
                background: c.hex,
                border: '2px solid var(--hairline)',
                boxShadow: '0 1px 3px var(--shadow-sm, rgba(0,0,0,.1))',
              }}
            />
            <div className="text-center leading-[1.2]">
              <div className="font-sans text-[11px] text-fg">{c.name}</div>
              <div className="font-mono text-[9.5px] text-fg-faint">
                {c.hex.toUpperCase()} · {c.mass.toFixed(2)} kg
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
