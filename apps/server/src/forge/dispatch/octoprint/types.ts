/**
 * types.ts — V2-005d-d T_dd1
 *
 * Zod schemas for OctoPrint dispatcher.
 *
 * - `OctoprintCredentialPayload` — shape of the decrypted credential payload
 *   stored in `forge_target_credentials.encrypted_blob` for kind='octoprint_api_key'.
 *   Single field: `apiKey` (OctoPrint's `X-Api-Key` header value).
 *
 * - `OctoprintConnectionConfig` — shape of the per-printer
 *   `printers.connection_config` JSON for kind='fdm_octoprint'. Defaults match
 *   typical OctoPrint defaults (port 80, http scheme, /api path, requiresAuth=true,
 *   select=true, startPrint=true). `requiresAuth=false` is unusual for OctoPrint
 *   but provided for parity with Moonraker's trusted-clients mode.
 */
import { z } from 'zod';

export const OctoprintCredentialPayload = z.object({
  apiKey: z.string().min(1).max(256),
});
export type OctoprintCredentialPayloadT = z.infer<typeof OctoprintCredentialPayload>;

export const OctoprintConnectionConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(80),
  scheme: z.enum(['http', 'https']).default('http'),
  apiPath: z.string().default('/api'),
  select: z.boolean().default(true),
  startPrint: z.boolean().default(true),
  requiresAuth: z.boolean().default(true),
});
export type OctoprintConnectionConfigT = z.infer<typeof OctoprintConnectionConfig>;
