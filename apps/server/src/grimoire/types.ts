/**
 * Grimoire pillar types — V2-007a-T2
 *
 * Re-exports the schema-side enum unions and provides predicates that
 * downstream tasks (T10 CRUD, T11 attachments, V2-005 Forge integration)
 * can use without re-importing the schema module directly.
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  SLICER_KINDS,
  PRINTER_KINDS,
  PROFILE_MATERIAL_KINDS,
  slicerProfiles,
  printSettings,
  grimoireAttachments,
} from '../db/schema.grimoire';

export { SLICER_KINDS, PRINTER_KINDS, PROFILE_MATERIAL_KINDS };
export type { SlicerKind, PrinterKind, ProfileMaterialKind } from '../db/schema.grimoire';

// ---------------------------------------------------------------------------
// Drizzle row types
// ---------------------------------------------------------------------------

export type SlicerProfile = InferSelectModel<typeof slicerProfiles>;
export type SlicerProfileInsert = InferInsertModel<typeof slicerProfiles>;

export type PrintSetting = InferSelectModel<typeof printSettings>;
export type PrintSettingInsert = InferInsertModel<typeof printSettings>;

export type GrimoireAttachment = InferSelectModel<typeof grimoireAttachments>;
export type GrimoireAttachmentInsert = InferInsertModel<typeof grimoireAttachments>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

import type { SlicerKind, PrinterKind, ProfileMaterialKind } from '../db/schema.grimoire';

export function isSlicerKind(value: string): value is SlicerKind {
  return (SLICER_KINDS as readonly string[]).includes(value);
}

export function isPrinterKind(value: string): value is PrinterKind {
  return (PRINTER_KINDS as readonly string[]).includes(value);
}

export function isProfileMaterialKind(value: string): value is ProfileMaterialKind {
  return (PROFILE_MATERIAL_KINDS as readonly string[]).includes(value);
}

/**
 * App-layer XOR check for grimoire_attachments. T11 will own validation
 * but exposing the predicate here lets T10 / T11 share one source of truth.
 *
 * Returns true iff exactly one of slicerProfileId / printSettingId is set.
 */
export function isExactlyOneAttachmentTarget(
  row: Pick<GrimoireAttachment, 'slicerProfileId' | 'printSettingId'>,
): boolean {
  const hasProfile = row.slicerProfileId !== null && row.slicerProfileId !== undefined;
  const hasSetting = row.printSettingId !== null && row.printSettingId !== undefined;
  return hasProfile !== hasSetting; // XOR
}
