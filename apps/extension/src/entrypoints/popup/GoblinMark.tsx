// Brand mark — italic Playfair "L" monogram. Mirror of apps/server's GoblinMark.
// Kept in-extension because apps/extension is a separate app and cannot import
// from apps/server. If the real mark lands later, update both sites in tandem.

export function GoblinMark({
  size = 20,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <span
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
