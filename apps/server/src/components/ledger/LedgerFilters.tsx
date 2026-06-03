'use client';

import { KNOWN_SUBJECT_TYPES, type LedgerFilterState } from './types';

interface Props {
  value: LedgerFilterState;
  onChange: (next: LedgerFilterState) => void;
  onClear: () => void;
}

/**
 * Filter bar for /ledger. All inputs feed the same `LedgerFilterState`; the
 * page debounces typing-heavy fields (kind, actor) into the query key.
 *
 * Date inputs are HTML `<input type="date">` (local-date strings); the page
 * converts them to ISO `Z` timestamps before sending.
 */
export function LedgerFilters({ value, onChange, onClear }: Props) {
  function set<K extends keyof LedgerFilterState>(key: K, v: LedgerFilterState[K]) {
    onChange({ ...value, [key]: v });
  }

  const anySet = Object.values(value).some((v) => v !== '');

  return (
    <div className="rounded-md border border-hairline bg-surface p-4">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
          filter
        </span>
        <div className="flex-1 border-b border-dashed border-hairline" />
        {anySet && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] uppercase tracking-[1px] text-fg-faint hover:text-accent"
          >
            clear filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="subject type">
          <select
            value={value.subject_type}
            onChange={(e) => set('subject_type', e.target.value)}
            className="w-full rounded-sm border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-fg focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            {KNOWN_SUBJECT_TYPES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>

        <Field label="kind">
          <input
            type="text"
            value={value.kind}
            onChange={(e) => set('kind', e.target.value)}
            placeholder="e.g. material.mix_created"
            className="w-full rounded-sm border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-fg placeholder:text-fg-ghost focus:border-accent focus:outline-none"
          />
        </Field>

        <Field label="actor user id">
          <input
            type="text"
            value={value.actor_user_id}
            onChange={(e) => set('actor_user_id', e.target.value)}
            placeholder="user id"
            className="w-full rounded-sm border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-fg placeholder:text-fg-ghost focus:border-accent focus:outline-none"
          />
        </Field>

        <Field label="occurred after">
          <input
            type="date"
            value={value.occurred_after}
            onChange={(e) => set('occurred_after', e.target.value)}
            className="w-full rounded-sm border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-fg focus:border-accent focus:outline-none"
          />
        </Field>

        <Field label="occurred before">
          <input
            type="date"
            value={value.occurred_before}
            onChange={(e) => set('occurred_before', e.target.value)}
            className="w-full rounded-sm border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-fg focus:border-accent focus:outline-none"
          />
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[9.5px] uppercase tracking-[1px] text-fg-faint">
        {label}
      </span>
      {children}
    </label>
  );
}
