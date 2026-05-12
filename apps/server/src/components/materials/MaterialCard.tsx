'use client';
// MaterialCard — square spool card used in the detail header.
// Reusable for rack view later (MatInventoryRack deferred).
// Canvas reference: SpoolCard (page-materials.jsx line 124-176).

import { MetaBadge } from '@/components/shell/atoms';
import { materialDisplayName, kindLabel } from './materials-labels';
import { RemainingBar } from './RemainingBar';

interface MaterialCardProps {
  material: {
    id: string;
    kind: string;
    brand: string | null;
    subtype: string | null;
    colorName: string | null;
    colors: string[] | null;
    initialAmount: number;
    remainingAmount: number;
    unit: string;
    active: boolean;
    loadedInPrinterId: string | null;
  };
  /** Optional printer name to display in the loaded badge. */
  printerName?: string | null;
  /** Size variant — 'lg' for the detail hero, 'sm' for the grid card. */
  size?: 'sm' | 'lg';
}

export function MaterialCard({ material: m, printerName, size = 'sm' }: MaterialCardProps) {
  const swatchColor = m.colors?.[0] ?? '#888';
  const dim = !m.active;
  const swatchSize = size === 'lg' ? 'w-14 h-14 rounded-[28px]' : 'w-11 h-11 rounded-[22px]';

  return (
    <div
      className={`relative flex flex-col gap-2.5 rounded-lg border border-hairline bg-surface p-3.5 ${dim ? 'opacity-55' : ''}`}
    >
      {!m.active && (
        <span className="absolute right-2.5 top-2.5 font-mono text-[8.5px] uppercase tracking-[1.4px] text-fg-faint">
          Retired
        </span>
      )}

      {/* Swatch + name */}
      <div className="flex items-center gap-3">
        <div
          className={`${swatchSize} shrink-0 border border-hairline`}
          style={{
            background: swatchColor,
            boxShadow: 'inset 0 0 0 3px var(--surface)',
          }}
        />
        <div className="min-w-0">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap font-serif text-[16px] leading-[1.05] tracking-[-0.2px] text-fg">
            {materialDisplayName(m)}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-fg-faint">
            {kindLabel(m.kind)}
            {m.subtype ? ` · ${m.subtype}` : ''}
          </div>
        </div>
      </div>

      {/* Loaded badge or shelf note */}
      {m.loadedInPrinterId ? (
        <div className="flex items-center gap-1.5 rounded-sm border border-accent-edge bg-accent-soft px-2 py-[5px]">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="font-mono text-[10px] tracking-[0.6px] text-accent">
            Loaded{printerName ? ` · ${printerName}` : ''}
          </span>
        </div>
      ) : (
        <div className="font-serif text-[12px] italic text-fg-faint">on shelf</div>
      )}

      {/* Remaining bar */}
      <RemainingBar
        remainingAmount={m.remainingAmount}
        initialAmount={m.initialAmount}
        unit={m.unit}
      />

      {/* Footer — loaded→accent (active emphasis), empty→running (needs action),
          retired→neutral (passive end-state), active default→neutral (steady). */}
      {(() => {
        const tone: 'neutral' | 'accent' | 'running' = !m.active
          ? 'neutral'
          : m.loadedInPrinterId
            ? 'accent'
            : m.remainingAmount === 0
              ? 'running'
              : 'neutral';
        const label = !m.active
          ? 'retired'
          : m.loadedInPrinterId
            ? 'loaded'
            : m.remainingAmount === 0
              ? 'empty'
              : 'active';
        return (
          <div className="flex justify-between font-mono text-[9.5px] text-fg-faint">
            <span>{m.kind}</span>
            <MetaBadge tone={tone}>{label}</MetaBadge>
          </div>
        );
      })()}
    </div>
  );
}
