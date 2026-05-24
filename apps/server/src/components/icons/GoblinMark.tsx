// Brand mark — placeholder italic Playfair "L" monogram.
// The real LootGoblin logo is not yet designed; this stand-in renders across
// every surface (sidebar, future favicon, etc). When the final mark lands,
// replace the body of this component and all surfaces pick it up.
// Mirrors the design-system "brand tile" treatment (dark italic L on the
// accent tile; the tile background is applied by the call site).

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
    <span
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-serif)',
        fontStyle: 'italic',
        fontWeight: 700,
        fontSize: size * 0.82,
        lineHeight: 1,
        color,
        userSelect: 'none',
      }}
    >
      L
    </span>
  );
}
