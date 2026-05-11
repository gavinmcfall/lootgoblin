/**
 * Format a Date as a compact mono-friendly relative-age string.
 * Returns "<1m" for sub-minute, "Xm" / "Xh" / "Xd" for older.
 * Edge case: sub-second values still return "<1m" (never "0m").
 *
 * Used by Stash queue table (T3) and History day-grouped ledger (T6).
 * If i18n becomes a requirement, swap to Intl.RelativeTimeFormat at the
 * call site of this helper rather than parameterising here.
 */
export function relativeAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
