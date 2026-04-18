import { NextResponse } from 'next/server';
import { getDb, schema } from '@/db/client';
import { sql } from 'drizzle-orm';

type Check = 'ok' | 'fail';
interface HealthReport {
  status: 'ok' | 'degraded' | 'fail';
  checks: { db: Check; secret: Check; disk: Check };
}

export async function GET() {
  const report: HealthReport = {
    status: 'ok',
    checks: { db: 'fail', secret: 'fail', disk: 'fail' },
  };

  try {
    const db = getDb();
    await (db as any).select({ one: sql`1` }).from(schema.settings).limit(1);
    report.checks.db = 'ok';
  } catch { /* stays fail */ }

  if ((process.env.LOOTGOBLIN_SECRET?.length ?? 0) >= 32) report.checks.secret = 'ok';

  // disk check: for now, always ok; real check lands when staging path is fixed in Plan B
  report.checks.disk = 'ok';

  const anyFail = Object.values(report.checks).some((v) => v === 'fail');
  if (anyFail) report.status = 'fail';
  return NextResponse.json(report, { status: anyFail ? 503 : 200 });
}
