// Small horizontal meter showing classifier confidence (0–1).
// Uses role="meter" (gauge of a known range) not progressbar.

interface ConfidenceBarProps {
  confidence: number; // 0–1
  width?: number;     // px width of bar track
}

export function ConfidenceBar({ confidence, width = 80 }: ConfidenceBarProps) {
  // Clamp to [0, 1] defensively.
  const clamped = Math.min(1, Math.max(0, confidence));
  const pct = Math.round(clamped * 100);

  // Color derived from confidence tier, using CSS custom properties.
  let colorVar: string;
  if (clamped >= 0.85) {
    colorVar = 'var(--success)';
  } else if (clamped >= 0.5) {
    colorVar = 'var(--running)';
  } else {
    colorVar = 'var(--danger)';
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* meter track */}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={clamped}
        aria-label="Classifier confidence"
        style={{ width }}
        className="h-[3px] rounded-full bg-surface-2 overflow-hidden"
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: colorVar,
          }}
        />
      </div>
      {/* numeric label */}
      <span
        className="font-mono text-[10px] tracking-[0.3px]"
        style={{ color: colorVar }}
      >
        {pct}%
      </span>
    </div>
  );
}
