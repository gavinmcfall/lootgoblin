/**
 * Cursor codec for GET /api/v1/ledger pagination.
 *
 * Extracted from route.ts so Next.js route files only export HTTP-verb handlers
 * (Next.js 15 forbids non-verb exports from route.ts).
 *
 * Codec spec
 * ──────────
 * encodeCursor(ts, id) = base64url(`${ts.getTime()}|${id}`)
 * decodeCursor(cursor) → {ingestedAt: Date, id: string} | null (null = restart list)
 * Compound form: OR(lt(ingestedAt, c.ts), AND(eq(ingestedAt, c.ts), lt(id, c.id)))
 * handles same-millisecond stability correctly.
 */

export function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.getTime()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { ingestedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const pipeIdx = raw.indexOf('|');
    if (pipeIdx === -1) return null;
    const msStr = raw.slice(0, pipeIdx);
    const id = raw.slice(pipeIdx + 1);
    const ms = Number(msStr);
    if (!Number.isFinite(ms) || ms <= 0 || !id) return null;
    return { ingestedAt: new Date(ms), id };
  } catch {
    return null;
  }
}
