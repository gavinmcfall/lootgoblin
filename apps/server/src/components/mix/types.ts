// Shared types + pure helpers for the Guided Mix (manual entry) flow.
// Wire shapes mirror the backend DTOs (see _shared.ts + mix.ts).

export interface MixRecipeComponent {
  materialProductRef: string;
  ratioOrGrams: number;
  tolerance?: number;
}

export interface MixRecipeDto {
  id: string;
  ownerId: string;
  name: string;
  components: MixRecipeComponent[];
  notes: string | null;
  createdAt: string;
}

export interface MaterialDto {
  id: string;
  kind: string;
  brand: string | null;
  subtype: string | null;
  colorName: string | null;
  colors: string[] | null;
  initialAmount: number;
  remainingAmount: number;
  unit: string;
  active: boolean;
  createdAt: string;
}

/**
 * Derived per-component target/tolerance at the current batch size.
 * `target = ratioOrGrams × scale`; `tol = tolerance × scale` (only when the
 * recipe component carries a tolerance).
 */
export interface ScaledComponent {
  index: number;
  ref: string;
  ratio: number;
  pct: number;
  target: number;
  tol: number | null;
}

/**
 * Scale every recipe component to `batchSize`. The nominal total is
 * `Σ ratioOrGrams`; `scale = batchSize / nominalTotal`.
 */
export function scaleComponents(
  components: MixRecipeComponent[],
  batchSize: number,
): { nominalTotal: number; scale: number; scaled: ScaledComponent[] } {
  const nominalTotal = components.reduce((s, c) => s + c.ratioOrGrams, 0);
  const ratioSum = nominalTotal === 0 ? 1 : nominalTotal;
  const scale = nominalTotal === 0 ? 1 : batchSize / nominalTotal;
  const scaled: ScaledComponent[] = components.map((c, index) => ({
    index,
    ref: c.materialProductRef,
    ratio: c.ratioOrGrams,
    pct: (c.ratioOrGrams / ratioSum) * 100,
    target: c.ratioOrGrams * scale,
    tol: c.tolerance != null ? c.tolerance * scale : null,
  }));
  return { nominalTotal, scale, scaled };
}

/**
 * Weighted-average hex blend of source colors by draw fraction. Returns null
 * unless EVERY source has a usable `colors[0]` hex. Mirrors the design mock's
 * algorithm.
 */
export function synthesizeHex(
  entries: Array<{ hex: string | null | undefined; weight: number }>,
): string | null {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  const HEX = /^#[0-9A-Fa-f]{6}$/;
  if (!entries.every((e) => e.hex && HEX.test(e.hex))) return null;
  const rgb = entries.reduce(
    (acc, e) => {
      const hex = e.hex as string;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const w = e.weight / total;
      return [acc[0] + r * w, acc[1] + g * w, acc[2] + b * w] as [number, number, number];
    },
    [0, 0, 0] as [number, number, number],
  );
  return (
    '#' +
    rgb
      .map((n) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** Friendly one-line label for an inventory material. */
export function materialLabel(m: MaterialDto): string {
  const parts = [m.brand, m.subtype, m.colorName].filter(Boolean);
  if (parts.length === 0) return `${m.kind} · ${m.id.slice(0, 8)}`;
  return parts.join(' ');
}

/** Map applyMixBatch reason codes to friendly messages for sonner. */
export function mixReasonMessage(reason: string, detail?: string): string {
  switch (reason) {
    case 'source-not-found':
      return 'One of the mapped bottles no longer exists.';
    case 'source-not-owned':
      return 'One of the mapped bottles is not in your inventory.';
    case 'source-retired':
      return 'One of the mapped bottles has been retired — pick an active one.';
    case 'source-insufficient':
      return 'A mapped bottle does not have enough remaining for its draw.';
    case 'draw-sum-mismatch':
      return 'Entered weights do not add up to the batch total. Re-check your numbers.';
    case 'draw-count-mismatch':
      return 'The number of weighed components does not match the recipe.';
    case 'recipe-not-found':
      return 'This recipe could not be found.';
    case 'total-volume-invalid':
      return 'The batch total is invalid.';
    case 'color-pattern-mismatch':
      return 'Colour data was incomplete and has been dropped.';
    default:
      return detail ? `${reason}: ${detail}` : `Mix could not be registered (${reason}).`;
  }
}
