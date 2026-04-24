/**
 * GET /api/v1/setup/status — V2-001-T8
 *
 * Unauthenticated endpoint. Returns the current first-run state so the UI
 * can decide whether to render the setup wizard, login page, or dashboard.
 *
 * Reachable before any user exists — middleware allowlist covers this via
 * isSetupStatusEndpoint().
 */

import { NextResponse } from 'next/server';
import { getFirstRunState } from '@/setup/first-run';

export async function GET() {
  const state = await getFirstRunState();
  return NextResponse.json(state);
}
