// Brand mark — a minimal goblin glyph. Two eye dots, pointed-ear silhouette,
// hint of a tusk. No "cute illustration"; just a geometric mark.
// Source: planning/design-system/lib/tokens.jsx

export function GoblinMark({
  size = 20,
  color = 'currentColor',
  className,
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* silhouette */}
      <path
        d="M4 13c0-4.4 3.6-8 8-8 1.3 0 2.5.3 3.6.9L18 3l1.2 4.1c1.1 1.4 1.8 3.1 1.8 4.9 0 4.4-3.6 8-8 8s-8-3.6-8-8z"
        fill={color}
        opacity="0.18"
      />
      <path
        d="M4 13c0-4.4 3.6-8 8-8 1.3 0 2.5.3 3.6.9L18 3l1.2 4.1c1.1 1.4 1.8 3.1 1.8 4.9 0 4.4-3.6 8-8 8s-8-3.6-8-8z"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      {/* eyes */}
      <circle cx="10" cy="12" r="1.1" fill={color} />
      <circle cx="14.5" cy="12" r="1.1" fill={color} />
      {/* tusk */}
      <path
        d="M11 16.5c0.6 0.4 1.4 0.4 2 0"
        stroke={color}
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}
