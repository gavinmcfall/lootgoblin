'use client';
// BrandBars — horizontal bars for brand breakdown.
// Canvas ref: BrandBars (page-consumption.jsx line 197–212).
// Mono labels + accent fill (no per-brand color — use accent for all bars).

interface BrandDatum {
  name: string;
  /** Total mass in kg */
  mass: number;
}

interface Props {
  data: BrandDatum[];
}

export function BrandBars({ data }: Props) {
  const max = Math.max(...data.map((d) => d.mass), 0.01);
  return (
    <div
      className="flex flex-col gap-2"
      role="img"
      aria-label={`Mass by brand, top ${data.length} brand${data.length === 1 ? '' : 's'}`}
    >
      {data.map((b) => (
        <div
          key={b.name}
          className="grid items-center gap-[10px]"
          style={{ gridTemplateColumns: '92px 1fr 60px' }}
        >
          <span className="font-sans text-[12px] text-fg">{b.name}</span>
          <div className="relative h-[18px] overflow-hidden rounded-[3px] bg-surface-2">
            <div
              className="h-full bg-accent"
              style={{ width: `${(b.mass / max) * 100}%` }}
            />
          </div>
          <span className="text-right font-mono text-[10.5px] text-fg-muted">
            {b.mass.toFixed(2)} kg
          </span>
        </div>
      ))}
    </div>
  );
}
