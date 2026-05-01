/**
 * GET /api/v1/forge/dispatch/:id/status/stream — V2-005f-T_dcf12
 *
 * Server-Sent Events. Subscribes to the in-memory StatusEventBus and
 * forwards every emitted StatusEvent for the dispatch as a single SSE
 * frame:
 *
 *   event: status
 *   data: {<JSON-serialized StatusEvent>}
 *
 * Lifecycle:
 *   - Owner-or-admin ACL. Cross-owner returns 404 (mirrors `/status` and
 *     `/events`).
 *   - If the dispatch is already in a terminal state (`completed` /
 *     `failed`) at request time, write one terminal frame and close —
 *     no subscription needed.
 *   - Otherwise subscribe to the bus, write frames, and close once a
 *     terminal-kind event arrives.
 *   - Heartbeat comment every 30s so intermediate proxies (Cloudflare,
 *     nginx) don't drop the idle connection. Comment lines (`:` prefix)
 *     are ignored by EventSource per the SSE spec.
 *   - Cleans up on client disconnect (`req.signal` abort).
 *
 * Distinct from /api/v1/jobs/stream — that's the V1 ingest-pipeline SSE.
 */

import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';
import { getDefaultStatusEventBus } from '@/forge/status/event-bus';
import type { StatusEvent } from '@/forge/status/types';

import { errorResponse, requireAuth } from '../../../../_shared';

export const dynamic = 'force-dynamic';

const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed']);
const HEARTBEAT_MS = 30_000;

function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disable proxy buffering (nginx, Cloudflare reverse-proxy modes).
    'x-accel-buffering': 'no',
  };
}

function frame(event: StatusEvent | { kind: string; terminal: true; status: string }): string {
  return `event: status\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  if (typeof id !== 'string' || id.length === 0) {
    return errorResponse('invalid-path', 'missing dispatch id', 400);
  }

  const db = getServerDb();
  const rows = await db
    .select()
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }
  if (actor.role !== 'admin' && row.ownerId !== actor.id) {
    return errorResponse('not-found', 'dispatch-not-found', 404);
  }

  // Already terminal — single frame + close. No bus subscription needed:
  // the dispatch can't generate new status events.
  if (TERMINAL_STATES.has(row.status)) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        try {
          controller.enqueue(
            enc.encode(
              frame({ kind: row.status, status: row.status, terminal: true }),
            ),
          );
        } catch {
          /* client already gone */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  // Live stream — subscribe to bus, write frames, close on terminal event.
  const bus = getDefaultStatusEventBus();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();

      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          /* client already gone — next abort will clean up */
        }
      };

      const heartbeat = setInterval(() => {
        // SSE comment line — ignored by EventSource, keeps the socket warm.
        safeEnqueue(enc.encode(`: keepalive\n\n`));
      }, HEARTBEAT_MS);

      const closeOnce = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const unsub = bus.subscribe(id, (event) => {
        safeEnqueue(enc.encode(frame(event)));
        if (event.kind === 'completed' || event.kind === 'failed') {
          unsub();
          closeOnce();
        }
      });

      // Auto-cleanup on client disconnect.
      req.signal.addEventListener('abort', () => {
        unsub();
        closeOnce();
      });
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
