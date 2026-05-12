'use client';
// Animated digit grid for pairing codes.
// Supports size variants: 'lg' (big code reveal) and 'md' (compact inline).
// Code format: NNN-NNN — split on '-', rendered as two groups with a gap separator.

interface PairingCodeDigitsProps {
  /** The pairing code in NNN-NNN format */
  code: string;
  size?: 'lg' | 'md';
  /** When true, digits glow/pulse to indicate the extension is connecting */
  pulse?: boolean;
}

const SIZES = {
  lg: { box: 56, font: 36, gap: 8 },
  md: { box: 38, font: 22, gap: 6 },
} as const;

export function PairingCodeDigits({ code, size = 'lg', pulse = false }: PairingCodeDigitsProps) {
  const s = SIZES[size];
  // Split NNN-NNN into two groups of digits; render a gap separator between groups.
  const groups = code.split('-');
  // Flatten to per-char items, tracking group boundaries for the separator.
  const items: Array<{ char: string; afterGroup?: boolean }> = [];
  groups.forEach((group, gi) => {
    group.split('').forEach((ch, ci) => {
      const isLastInGroup = ci === group.length - 1;
      items.push({ char: ch, afterGroup: isLastInGroup && gi < groups.length - 1 });
    });
  });

  return (
    <div className="flex" style={{ gap: s.gap }}>
      {items.map(({ char, afterGroup }, i) => (
        <div key={i} className="flex" style={{ gap: s.gap }}>
          <div
            className={[
              'flex items-center justify-center rounded-md border font-mono text-fg',
              'border-accent-edge bg-surface-2',
              pulse ? 'animate-[lgPulse_1.5s_ease-in-out_infinite]' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              width: s.box,
              height: s.box * 1.25,
              fontSize: s.font,
              fontWeight: 400,
              boxShadow: pulse ? '0 0 0 4px var(--color-accent-edge)' : 'none',
            }}
          >
            {char}
          </div>
          {afterGroup && (
            <div
              className="flex items-center justify-center font-mono text-fg-faint"
              style={{ width: s.box * 0.35, fontSize: s.font * 0.7 }}
            >
              ·
            </div>
          )}
        </div>
      ))}

      {/* Keyframe for the pulse animation */}
      <style>{`
        @keyframes lgPulse {
          0%, 100% { box-shadow: 0 0 0 4px var(--color-accent-edge); }
          50%       { box-shadow: 0 0 0 8px transparent; }
        }
      `}</style>
    </div>
  );
}
