/**
 * GET /api/v1/forge/discover-resin — V2-005d-c T_dc9
 *
 * Runs SDCP + ChituNetwork UDP discovery concurrently and returns both
 * arms' merged results. Any authenticated user (session OR programmatic
 * API key) may call — printers advertise themselves on the LAN broadcast
 * regardless, so discovery itself reveals nothing the caller couldn't
 * sniff with a UDP listener. Sensitive operations (set credentials,
 * dispatch jobs) are gated separately.
 *
 * Optional `?timeoutMs=...` query param controls the discovery window;
 * accepted range 1000–30000ms, default 5000.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateRequest,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/request-auth';
import { logger } from '@/logger';
import { getDiscoverResinPrintersFn } from '@/forge/dispatch/resin/route-helpers';

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const actor = await authenticateRequest(req);
  if (!actor || actor === INVALID_API_KEY) {
    return unauthenticatedResponse(actor as null | typeof INVALID_API_KEY);
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get('timeoutMs');
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (raw !== null) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
      return NextResponse.json(
        {
          error: 'invalid-query',
          reason: 'timeoutMs-out-of-range',
          min: MIN_TIMEOUT_MS,
          max: MAX_TIMEOUT_MS,
        },
        { status: 400 },
      );
    }
    timeoutMs = parsed;
  }

  const startedAt = Date.now();
  const result = await getDiscoverResinPrintersFn()({ timeoutMs });
  const durationMs = Date.now() - startedAt;

  logger.info(
    {
      sdcpCount: result.sdcp.length,
      chituCount: result.chituNetwork.length,
      durationMs,
    },
    'forge resin discovery completed',
  );

  return NextResponse.json(result);
}
