/**
 * Derive a one-line preview of a ledger event payload for the list row.
 *
 * The payload is polymorphic `unknown`. We don't pretend to understand kinds,
 * we just surface up to three short scalar key/value pairs from an object, or
 * a plain string/number. Nested objects are skipped; nested arrays show their
 * length. Truncation differs by context: a top-level string payload uses the
 * wider 80-char budget (it's all the row has to say), while nested string
 * values inside an object preview clamp at 40 chars so three pairs still fit.
 */
export function payloadPreview(payload: unknown): string {
  if (payload === null || payload === undefined) return '—';
  if (typeof payload === 'string') return truncate(payload, 80);
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (Array.isArray(payload)) return `[${payload.length} items]`;
  if (typeof payload !== 'object') return '—';

  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  let count = 0;
  for (const key of Object.keys(obj)) {
    if (count >= 3) break;
    const v = obj[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      // Skip nested structures for the one-line preview.
      if (Array.isArray(v)) {
        parts.push(`${key}=[${v.length}]`);
        count++;
      }
      continue;
    }
    const s = typeof v === 'string' ? truncate(v, 40) : String(v);
    parts.push(`${key}=${s}`);
    count++;
  }
  if (parts.length === 0) return '—';
  return parts.join(' · ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
