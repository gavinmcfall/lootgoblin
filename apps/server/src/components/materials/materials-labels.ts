// Shared label helpers for Materials UI. Single source of truth across
// MaterialsTable, MaterialCard, detail page, and filter UI.

/** Human-readable kind label for a MATERIAL_KINDS value. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'filament_spool': return 'Filament';
    case 'resin_bottle':   return 'Resin';
    case 'mix_batch':      return 'Mix';
    case 'recycled_spool': return 'Recycled';
    case 'other':          return 'Other';
    default:               return kind;
  }
}

/** Short kind label for filters / chips. */
export function kindLabelShort(kind: string): string {
  switch (kind) {
    case 'filament_spool': return 'Filament';
    case 'resin_bottle':   return 'Resin';
    case 'mix_batch':      return 'Mix';
    case 'recycled_spool': return 'Recycled';
    case 'other':          return 'Other';
    default:               return kind;
  }
}

/** Human-readable unit label. */
export function unitLabel(unit: string): string {
  switch (unit) {
    case 'g':  return 'g';
    case 'ml': return 'ml';
    default:   return unit;
  }
}

/** Human-readable color pattern label. */
export function colorPatternLabel(pattern: string | null | undefined): string {
  if (!pattern) return '';
  switch (pattern) {
    case 'solid':         return 'solid';
    case 'dual-tone':     return 'dual-tone';
    case 'gradient':      return 'gradient';
    case 'multi-section': return 'multi-section';
    default:              return pattern;
  }
}

/** Derive a display name from brand + colorName + subtype fields. */
export function materialDisplayName(m: {
  brand: string | null;
  colorName: string | null;
  subtype: string | null;
  kind: string;
}): string {
  const parts: string[] = [];
  if (m.brand) parts.push(m.brand);
  if (m.colorName) parts.push(m.colorName);
  else if (m.subtype) parts.push(m.subtype);
  if (parts.length === 0) return kindLabel(m.kind);
  return parts.join(' · ');
}
