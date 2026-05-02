/**
 * types.ts — V2-005f-T_dcf2
 *
 * Module-level types for the SlicerEstimateExtractor framework.
 *
 * Snake_case is intentional: this shape is the JSON-on-disk wire format that
 * round-trips into `dispatch_jobs.materials_used` (see T_dcf1 schema.forge.ts /
 * MaterialsUsedEntry). Do NOT camelCase — it must serialize compatibly.
 */

export interface SlicerEstimateSlot {
  slot_index: number;
  estimated_grams: number;
  estimated_volume_ml?: number;
  /**
   * Best-guess material name from the slicer (e.g. 'PLA', 'PETG',
   * 'Phrozen Aqua-Gray 8K').
   */
  material_hint?: string;
}

export interface SlicerEstimate {
  slots: SlicerEstimateSlot[];
  total_grams: number;
  /** Slicer-estimated print time in minutes. Optional — not all formats report it. */
  slicer_estimate_print_time_min?: number;
}
