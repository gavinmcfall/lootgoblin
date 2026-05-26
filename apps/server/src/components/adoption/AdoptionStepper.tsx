'use client';
// Left stepper rail for the Adoption wizard.
// Ported from AdoptionStepper in planning/design-system/lib/page-adoption.jsx
// (inline styles → Tailwind token classes). The mock's 5 steps collapse to the
// 4 real steps: Scan · Select · Template · Apply.

import { Check } from 'lucide-react';

export const ADOPTION_STEPS = [
  { id: 0, kw: 'SCAN', title: 'Walk the disk', sub: 'discover what is there' },
  { id: 1, kw: 'SELECT', title: 'Choose folders', sub: 'pick what to adopt' },
  { id: 2, kw: 'TEMPLATE', title: 'Pick a shape', sub: 'preview the moves' },
  { id: 3, kw: 'APPLY', title: 'Adopt the hoard', sub: 'create the collection' },
] as const;

export function AdoptionStepper({
  current,
  rootName,
  rootPath,
}: {
  current: number;
  rootName: string;
  rootPath: string;
}) {
  return (
    <div className="flex w-[210px] shrink-0 flex-col gap-4 border-r border-hairline pr-5">
      <div>
        <div className="font-mono text-[9.5px] uppercase tracking-[1.8px] text-fg-faint">
          Adoption
        </div>
        <div className="mt-1 font-serif text-[22px] leading-[1.05] tracking-[-0.4px] text-fg">
          Take in the hoard.
        </div>
        <div className="mt-1.5 font-serif text-[12.5px] italic text-fg-muted">
          Nothing on disk changes until you apply.
        </div>
      </div>

      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {ADOPTION_STEPS.map((s) => {
          const done = s.id < current;
          const on = s.id === current;
          return (
            <li
              key={s.id}
              className={`flex items-start gap-2.5 rounded-md border p-2 ${
                on ? 'border-accent-edge bg-accent-soft' : 'border-transparent'
              }`}
            >
              <span
                className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
                  done || on
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-hairline text-fg-faint'
                }`}
              >
                {done ? <Check className="h-3 w-3" strokeWidth={2.5} /> : s.id + 1}
              </span>
              <span className="min-w-0">
                <span
                  className={`block font-mono text-[9px] tracking-[1.4px] ${on ? 'text-accent' : 'text-fg-faint'}`}
                >
                  {s.kw}
                </span>
                <span
                  className={`mt-0.5 block text-[12.5px] leading-tight ${
                    on ? 'font-semibold text-fg' : done ? 'text-fg-muted' : 'text-fg-faint'
                  }`}
                >
                  {s.title}
                </span>
                <span className="mt-0.5 block font-serif text-[11px] italic leading-snug text-fg-faint">
                  {s.sub}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="mt-auto rounded-md border border-dashed border-hairline bg-surface-2 p-3">
        <div className="font-mono text-[9px] uppercase tracking-[1.2px] text-fg-faint">Source</div>
        <div className="mt-1 truncate font-serif text-[13px] text-fg" title={rootName}>
          {rootName}
        </div>
        <div className="mt-1.5 break-all font-mono text-[10px] text-fg-faint">{rootPath}</div>
      </div>
    </div>
  );
}
