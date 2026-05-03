/**
 * V2-005e-T_e2: Forge inbox CRUD types.
 *
 * Validation surface for POST/PATCH /api/v1/forge/inboxes.
 * Persists into `forge_inboxes` (V2-005e-T_e1, schema.forge.ts).
 */

import { z } from 'zod';

import { schema } from '../../db/client';

/**
 * POST body — create inbox.
 * `defaultPrinterId` is optional; null = watch-only.
 * `notes` is free-form per-row description.
 */
export const ForgeInboxCreateBody = z
  .object({
    name: z.string().min(1).max(120),
    path: z.string().min(1),
    defaultPrinterId: z.string().min(1).optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

/**
 * PATCH body — update inbox. All fields optional. `defaultPrinterId` and
 * `notes` accept null to clear them.
 *
 * Setting `active = false` triggers stopInboxWatcher; flipping back to true
 * triggers startInboxWatcher (route layer wires this).
 */
export const ForgeInboxUpdateBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    path: z.string().min(1).optional(),
    defaultPrinterId: z.string().min(1).nullable().optional(),
    active: z.boolean().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

export type ForgeInboxCreate = z.infer<typeof ForgeInboxCreateBody>;
export type ForgeInboxUpdate = z.infer<typeof ForgeInboxUpdateBody>;

/** Drizzle row shape for forge_inboxes — re-exported for downstream typing. */
export type ForgeInboxRow = typeof schema.forgeInboxes.$inferSelect;

/** Public DTO returned by HTTP routes. Dates → ms epoch (matches Forge convention). */
export interface ForgeInboxDto {
  id: string;
  ownerId: string;
  name: string;
  path: string;
  defaultPrinterId: string | null;
  active: boolean;
  notes: string | null;
  createdAt: number;
}

export function toForgeInboxDto(row: ForgeInboxRow): ForgeInboxDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    path: row.path,
    defaultPrinterId: row.defaultPrinterId ?? null,
    active: row.active === true,
    notes: row.notes ?? null,
    createdAt: row.createdAt.getTime(),
  };
}
