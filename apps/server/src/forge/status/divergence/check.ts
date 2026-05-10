/**
 * check.ts — V2-005f-CF-5b T_b2
 *
 * Pure divergence-check heuristic. Compares estimated vs measured filament
 * consumption and emits a warning when measured << estimated.
 *
 * Thresholds (hardcoded, empirically tunable):
 *   - Single-color: measured/estimated ratio must be >= 0.50
 *   - Multi-material: aggregate ratio must be >= 0.40
 *   - Minimum: skip when total estimated < 10g (avoids noise on tiny prints)
 *
 * Logs the ratio for EVERY completed print regardless of threshold crossing
 * so operators can tune thresholds from real data.
 *
 * Pure function: no DB calls, no I/O, no module-scope state.
 */
import { logger } from '../../../logger';
import type { MaterialsUsed } from '../../../db/schema.forge';

/** V2-005f-CF-5b T_b2 — divergence-detection thresholds. */
export const CF_5B_SINGLE_COLOR_RATIO = 0.50;
export const CF_5B_MULTI_MATERIAL_RATIO = 0.40;
export const CF_5B_MIN_GRAMS = 10;

export interface RunDivergenceArgs {
  dispatchJobId: string;
  materialsUsed: MaterialsUsed;
  /** CF-5a's emitWarning helper — called when threshold crosses. */
  emitWarning: (args: {
    dispatchJobId: string;
    errorCode: string;
    protocol: string;
    severity: 'info' | 'warning' | 'error';
    message?: string;
  }) => Promise<void>;
}

export async function runDivergenceCheck(args: RunDivergenceArgs): Promise<void> {
  const { dispatchJobId, materialsUsed, emitWarning } = args;

  const totalEstimated = materialsUsed.reduce((sum, s) => sum + s.estimated_grams, 0);
  const totalMeasured = materialsUsed.reduce((sum, s) => sum + (s.measured_grams ?? 0), 0);

  if (totalEstimated < CF_5B_MIN_GRAMS) {
    logger.debug({ dispatchJobId, totalEstimated },
      'cf-5b: skipped (estimated < CF_5B_MIN_GRAMS)');
    return;
  }

  const allMeasuredNull = materialsUsed.every(s => s.measured_grams === null);
  if (allMeasuredNull) {
    logger.debug({ dispatchJobId },
      'cf-5b: skipped (no measured side available)');
    return;
  }

  const ratio = totalMeasured / totalEstimated;

  // Q3=A: log ratio for every completed print (empirical threshold tuning)
  logger.info(
    { dispatchJobId, divergenceRatio: ratio, totalMeasured, totalEstimated },
    'cf-5b: divergence ratio recorded',
  );

  const isMultiMaterial = materialsUsed.length > 1;
  const threshold = isMultiMaterial ? CF_5B_MULTI_MATERIAL_RATIO : CF_5B_SINGLE_COLOR_RATIO;

  if (ratio < threshold) {
    await emitWarning({
      dispatchJobId,
      errorCode: 'divergence-detected',
      protocol: 'forge-cf-5b',
      severity: 'warning',
      message: `measured ${totalMeasured.toFixed(1)}g vs estimated ${totalEstimated.toFixed(1)}g (ratio ${ratio.toFixed(2)} < ${threshold.toFixed(2)})`,
    });
  }
}
