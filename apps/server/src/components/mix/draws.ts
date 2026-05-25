// Pure helpers to build the mix-batch POST body from wizard state.
//
// Mass-conservation invariant (enforced by applyMixBatch):
//   |Σ drawAmount − totalVolume| ≤ 0.1
// We round each draw to 1 decimal, then derive totalVolume as the SUM OF THE
// ROUNDED draws — never round the total independently. This guarantees the
// invariant holds exactly.

import type { MaterialDto, MixRecipeComponent } from './types';
import { materialLabel } from './types';

export interface ComponentDraw {
  sourceMaterialId: string;
  drawAmount: number;
  provenanceClass: 'entered';
  /** Display-only — the resolved inventory label for the chosen bottle. */
  sourceLabel: string;
  /** Display-only — the chosen bottle's first hex, if any. */
  sourceHex: string | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Parse a raw weight-input string into a valid draw weight, or `null` when it
 * isn't a usable value. A blank, non-finite, OR NEGATIVE entry is treated as
 * "not yet filled" — never silently coerced to 0 and submitted. This is the
 * single source of truth for "does this component have a valid weight?", used
 * by both the entry table's fill check and buildDraws.
 */
export function parseWeight(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * Build the per-component draws (rounded to 1 decimal, provenance 'entered')
 * and the derived totalVolume (= Σ of the rounded draws).
 *
 * `weights[index]` is the raw string from the input; callers must have ensured
 * every component has a valid (non-negative, finite) number via parseWeight
 * before reaching Review. A defensively-invalid entry rounds to 0.
 */
export function buildDraws(
  components: MixRecipeComponent[],
  mapping: Record<number, string>,
  sourceById: Map<string, MaterialDto>,
  weights: Record<number, string>,
): { draws: ComponentDraw[]; totalVolume: number } {
  const draws: ComponentDraw[] = components.map((_, index) => {
    const materialId = mapping[index] ?? '';
    const src = sourceById.get(materialId);
    const drawAmount = round1(parseWeight(weights[index]) ?? 0);
    return {
      sourceMaterialId: materialId,
      drawAmount,
      provenanceClass: 'entered',
      sourceLabel: src ? materialLabel(src) : `component ${index + 1}`,
      sourceHex: src?.colors?.[0] ?? null,
    };
  });
  const totalVolume = round1(draws.reduce((s, d) => s + d.drawAmount, 0));
  return { draws, totalVolume };
}
