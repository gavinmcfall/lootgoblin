'use client';
// MixStepper — 5-step header for the Guided Mix wizard.
// Ported from MixManualTopBar in page-mix-manual.jsx, extended from the
// design's 4 steps to 5 (the Map step is inserted at index 2).

const STEPS = ['Recipe', 'Map bottles', 'Enter weights', 'Review', 'Done'] as const;

export function MixStepper({ step }: { step: number }) {
  const stepName = STEPS[step] ?? '';
  return (
    <div className="flex items-center gap-3.5">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[1.6px] text-fg-faint">
          Guided mix · manual · step {step + 1}/{STEPS.length}
        </div>
        <div className="mt-0.5 font-serif text-[22px] italic text-fg">{stepName}</div>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {STEPS.map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            <span
              className={`rounded-[3px] border px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.8px] ${
                i === step
                  ? 'border-accent-edge bg-accent-soft font-semibold text-accent'
                  : i < step
                    ? 'border-transparent font-medium text-fg-muted'
                    : 'border-transparent font-medium text-fg-faint'
              }`}
            >
              {s}
            </span>
            {i < STEPS.length - 1 && (
              <span className="text-[10px] text-fg-faint">›</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
