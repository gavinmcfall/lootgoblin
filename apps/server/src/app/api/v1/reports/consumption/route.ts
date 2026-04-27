/**
 * GET /api/v1/reports/consumption — V2-007a-T14
 *
 * Owner-scoped consumption reports backed by T13 helpers
 * (consumptionByBrand / Color / Printer / Outcome / totalConsumption).
 *
 * Auth model
 * ──────────
 * Same `authenticateRequest` shim — session OR programmatic API key.
 * Reports are owner-scoped to the actor; admins do NOT get cross-owner
 * data via this route (admins can use direct DB / future ledger UI).
 *
 * Query params
 * ────────────
 *   dimension = 'brand' | 'color' | 'printer' | 'outcome' | 'total'
 *   since     = ISO 8601 (default: now − 30d)
 *   until     = ISO 8601 (default: now)
 *
 * Response shape
 * ──────────────
 *   dimension!=='total': { dimension, window, rows: [...] }
 *   dimension==='total': { dimension: 'total', window, row: {...} }
 *
 * Each row carries `key`, `totalAmount`, `unit`, `provenance` (six classes,
 * sum equals totalAmount), and `eventCount`. See T13 reports.ts for the
 * exact shape.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  consumptionByBrand,
  consumptionByColor,
  consumptionByOutcome,
  consumptionByPrinter,
  totalConsumption,
} from '@/materials/reports';

import {
  errorResponse,
  parseTimeWindow,
  requireAuth,
} from '../../materials/_shared';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(req.url);
  const dimension = url.searchParams.get('dimension');
  if (!dimension) {
    return errorResponse(
      'invalid-query',
      'dimension is required (brand|color|printer|outcome|total)',
      400,
    );
  }
  if (!['brand', 'color', 'printer', 'outcome', 'total'].includes(dimension)) {
    return errorResponse(
      'invalid-query',
      `unknown dimension '${dimension}' — expected one of: brand, color, printer, outcome, total`,
      400,
    );
  }

  const windowParsed = parseTimeWindow(url.searchParams);
  if (!windowParsed.ok) return windowParsed.response;
  const window = { since: windowParsed.since, until: windowParsed.until };

  const args = { ownerId: actor.id, window };
  const windowSerialized = {
    since: window.since.toISOString(),
    until: window.until.toISOString(),
  };

  switch (dimension) {
    case 'brand': {
      const rows = await consumptionByBrand(args);
      return NextResponse.json({ dimension, window: windowSerialized, rows });
    }
    case 'color': {
      const rows = await consumptionByColor(args);
      return NextResponse.json({ dimension, window: windowSerialized, rows });
    }
    case 'printer': {
      const rows = await consumptionByPrinter(args);
      return NextResponse.json({ dimension, window: windowSerialized, rows });
    }
    case 'outcome': {
      const rows = await consumptionByOutcome(args);
      return NextResponse.json({ dimension, window: windowSerialized, rows });
    }
    case 'total': {
      const row = await totalConsumption(args);
      return NextResponse.json({ dimension, window: windowSerialized, row });
    }
    default: {
      // Exhaustiveness — should never reach here.
      return errorResponse('internal', 'unhandled dimension', 500);
    }
  }
}
