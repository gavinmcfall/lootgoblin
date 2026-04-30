/**
 * types.ts — V2-005d-a T_da5
 *
 * Zod schemas for Moonraker (Klipper) dispatcher.
 *
 * - `MoonrakerCredentialPayload` — shape of the decrypted credential payload
 *   stored in `forge_target_credentials.encrypted_blob` for kind='fdm_klipper'.
 *   Single field: `apiKey` (Moonraker's `X-Api-Key` header value when API-key
 *   auth is enabled). Bounded length to keep blobs sane.
 *
 * - `MoonrakerConnectionConfig` — shape of the per-printer
 *   `printers.connection_config` JSON for kind='fdm_klipper'. Defaults match
 *   Moonraker's documented defaults (port 7125, http scheme, requiresAuth=true,
 *   startPrint=true). `requiresAuth=false` covers Moonraker's "Trusted Clients"
 *   IP-allowlist mode where no header is required.
 */
import { z } from 'zod';

export const MoonrakerCredentialPayload = z.object({
  apiKey: z.string().min(1).max(256),
});
export type MoonrakerCredentialPayloadT = z.infer<typeof MoonrakerCredentialPayload>;

export const MoonrakerConnectionConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(7125),
  scheme: z.enum(['http', 'https']).default('http'),
  startPrint: z.boolean().default(true),
  requiresAuth: z.boolean().default(true),
});
export type MoonrakerConnectionConfigT = z.infer<typeof MoonrakerConnectionConfig>;
