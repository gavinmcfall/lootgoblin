/**
 * GET /api/v1/loot/:id/consumption
 *
 * Per-Loot consumption summary derived from dispatch_jobs.materials_used.
 * Returns totalKg, printCount, avgGrams, and a rows array compatible with
 * ConsumptionLootEmbed props.
 *
 * Only completed dispatch jobs (status='completed') are included.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { getDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';

interface MaterialSlot {
  materialId?: string;
  name?: string;
  massG?: number;
  provenanceClass?: string;
  completedAt?: string;
}

interface MaterialsUsedJson {
  slots?: MaterialSlot[];
  totalG?: number;
  provenanceClass?: string;
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol')
    return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const acl = resolveAcl({ user, resource: { kind: 'loot', id }, action: 'read' });
  if (!acl.allowed)
    return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const db = getDb() as any;

  // Confirm the loot exists first.
  const lootRows = await db
    .select({ id: schema.loot.id })
    .from(schema.loot)
    .where(eq(schema.loot.id, id))
    .limit(1);
  if (lootRows.length === 0)
    return NextResponse.json({ error: 'not-found' }, { status: 404 });

  // Pull dispatch jobs for this loot that have materials_used populated.
  const jobs = await db
    .select({
      materialsUsed: schema.dispatchJobs.materialsUsed,
      completedAt: schema.dispatchJobs.completedAt,
    })
    .from(schema.dispatchJobs)
    .where(eq(schema.dispatchJobs.lootId, id));

  const completedJobs = jobs.filter((j: { materialsUsed: unknown; completedAt: unknown }) => j.materialsUsed !== null);

  let totalG = 0;
  let printCount = 0;
  const rows: Array<{
    date: string;
    material: string;
    massG: number;
    provenance: 'measured' | 'estimated' | 'entered' | 'derived' | 'computed' | 'system';
  }> = [];

  for (const job of completedJobs) {
    const mu = job.materialsUsed as MaterialsUsedJson | null;
    if (!mu) continue;
    printCount += 1;

    const dateStr = job.completedAt
      ? new Date(job.completedAt as string | number | Date).toLocaleDateString('en-NZ', {
          month: 'short',
          day: 'numeric',
        })
      : '—';

    const provRaw = mu.provenanceClass ?? 'computed';
    const prov = (['measured', 'estimated', 'entered', 'derived', 'computed', 'system'].includes(provRaw)
      ? provRaw
      : 'computed') as 'measured' | 'estimated' | 'entered' | 'derived' | 'computed' | 'system';

    if (mu.slots && mu.slots.length > 0) {
      for (const slot of mu.slots) {
        const g = slot.massG ?? 0;
        totalG += g;
        const slotProv = (['measured', 'estimated', 'entered', 'derived', 'computed', 'system'].includes(
          slot.provenanceClass ?? '',
        )
          ? slot.provenanceClass!
          : prov) as typeof prov;
        rows.push({
          date: dateStr,
          material: slot.name ?? 'Unknown material',
          massG: g,
          provenance: slotProv,
        });
      }
    } else if (mu.totalG !== undefined) {
      totalG += mu.totalG;
      rows.push({
        date: dateStr,
        material: 'Material',
        massG: mu.totalG,
        provenance: prov,
      });
    }
  }

  const totalKg = totalG / 1000;
  const avgGrams = printCount > 0 ? totalG / printCount : 0;

  return NextResponse.json({ totalKg, printCount, avgGrams, rows });
}
