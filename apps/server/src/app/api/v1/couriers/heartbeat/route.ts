// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * POST /api/v1/couriers/heartbeat — V2-006a-T5
 *
 * Courier heartbeat + per-printer reachability report.
 *
 * The Courier calls this endpoint every N seconds. The server:
 *   1. Authenticates the Courier via `authenticateCourier` (x-api-key).
 *   2. Validates the request body with zod.
 *   3. Performs a version handshake — major-version mismatch → 409.
 *   4. Bumps `agents.last_seen_at` via `recordHeartbeat`.
 *   5. Updates `printer_reachable_via` rows for the reported printers.
 *   6. Returns 200 with server_version + heartbeat_interval_seconds.
 *
 * Auth: Courier API key in `x-api-key` header (courier_pairing scope).
 * The agent identity comes ONLY from the key — body fields are ignored for identity.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  authenticateCourier,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/courier-auth';
import { recordHeartbeat } from '@/forge/agents';
import {
  SERVER_VERSION,
  recordReachability,
} from '@/forge/couriers';
import { PRINTER_REACHABLE_STATUSES, type PrinterReachableStatus } from '@/db/schema.forge';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How often (in seconds) the Courier should call this endpoint.
 * Override via COURIER_HEARTBEAT_INTERVAL_SECONDS env var.
 */
const HEARTBEAT_INTERVAL_SECONDS: number = (() => {
  const env = process.env.COURIER_HEARTBEAT_INTERVAL_SECONDS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 30;
})();

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const PrinterReachableStatusSchema = z.enum(
  PRINTER_REACHABLE_STATUSES as unknown as [string, ...string[]],
);

const PrinterEntrySchema = z.object({
  printer_id: z.string().min(1),
  reachable_status: PrinterReachableStatusSchema,
  detail: z.string().optional(),
});

const BodySchema = z.object({
  courier_version: z.string().min(1),
  printers: z.array(PrinterEntrySchema).optional(),
});

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseMajor(version: string): number {
  return parseInt(version.split('.')[0] ?? '0', 10);
}

function parseMinorPatch(version: string): string {
  const parts = version.split('.');
  return `${parts[1] ?? '0'}.${parts[2] ?? '0'}`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Authenticate — identity comes ONLY from the key, never from the body.
  const courier = await authenticateCourier(req);
  if (!courier || courier === INVALID_API_KEY) {
    return unauthenticatedResponse(courier as null | typeof INVALID_API_KEY);
  }
  const { agentId } = courier;

  // 2. Parse + validate body.
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', reason: parsed.error.flatten() },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  // 3. Version handshake.
  const serverMajor = parseMajor(SERVER_VERSION);
  const courierMajor = parseMajor(body.courier_version);

  if (courierMajor !== serverMajor) {
    logger.info(
      { agentId, courierVersion: body.courier_version, serverVersion: SERVER_VERSION },
      'courier heartbeat: major version mismatch — refusing',
    );
    return NextResponse.json(
      {
        error: 'version-incompatible',
        server_version: SERVER_VERSION,
        action: 'upgrade',
      },
      { status: 409 },
    );
  }

  const minorMismatch =
    parseMinorPatch(body.courier_version) !== parseMinorPatch(SERVER_VERSION);

  // 4. Bump last_seen_at.
  const heartbeatResult = await recordHeartbeat({ id: agentId });
  if (!heartbeatResult.ok) {
    logger.error(
      { agentId, reason: heartbeatResult.reason },
      'courier heartbeat: recordHeartbeat failed',
    );
    return NextResponse.json(
      { error: 'internal', reason: heartbeatResult.reason },
      { status: 500 },
    );
  }

  // 5. Update reachability rows (sync — better-sqlite3 .run()).
  // Cast reachable_status to PrinterReachableStatus — zod already validated it.
  const now = new Date();
  if (body.printers && body.printers.length > 0) {
    recordReachability(
      agentId,
      body.printers.map((p) => ({
        printer_id: p.printer_id,
        reachable_status: p.reachable_status as PrinterReachableStatus,
        detail: p.detail,
      })),
      now,
    );
  }

  // 6. Respond.
  const responseBody: Record<string, unknown> = {
    ok: true,
    server_version: SERVER_VERSION,
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
  };
  if (minorMismatch) {
    responseBody.warning = 'minor-version-mismatch';
  }

  return NextResponse.json(responseBody, { status: 200 });
}
