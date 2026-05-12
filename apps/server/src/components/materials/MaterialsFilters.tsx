'use client';
// MaterialsFilters — kind + state filter row for the inventory list.
// Canvas reference: MatFilters (page-materials.jsx line 65-92).
// Active state: bg-accent-soft text-accent; inactive: text-fg-muted hover:text-fg.

const KIND_FILTERS = [
  { value: '', label: 'All' },
  { value: 'filament_spool', label: 'Filament' },
  { value: 'resin_bottle', label: 'Resin' },
  { value: 'mix_batch', label: 'Mix' },
  { value: 'recycled_spool', label: 'Recycled' },
] as const;

const STATE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'retired', label: 'Retired' },
] as const;

interface MaterialsFiltersProps {
  kind: string;
  state: string;
  onKind: (v: string) => void;
  onState: (v: string) => void;
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm border px-2.5 py-[5px] font-mono text-[9.5px] uppercase tracking-[1.2px] transition-colors ${
        active
          ? 'border-accent-edge bg-accent-soft text-accent'
          : 'border-transparent text-fg-muted hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

export function MaterialsFilters({
  kind,
  state,
  onKind,
  onState,
}: MaterialsFiltersProps) {
  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-1">
      {KIND_FILTERS.map((f) => (
        <FilterPill
          key={f.value}
          label={f.label}
          active={kind === f.value}
          onClick={() => onKind(f.value)}
        />
      ))}

      <span className="mx-1.5 h-[18px] w-px bg-hairline" />

      {STATE_FILTERS.map((f) => (
        <FilterPill
          key={f.value}
          label={f.label}
          active={state === f.value}
          onClick={() => onState(f.value)}
        />
      ))}
    </div>
  );
}
