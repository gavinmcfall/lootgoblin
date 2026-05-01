/**
 * types.ts — V2-005d-c T_dc1 + T_dc5
 *
 * Per-model capability data for SDCP 3.0 resin printers (Elegoo Saturn /
 * Mars families on the open SDCP firmware). Drives UI hints (build volume,
 * LCD resolution, XY pixel pitch) and dispatcher behaviour.
 *
 * T_dc5 added: Zod schemas for connection-config + credential payload, used
 * by the adapter to validate operator-provided printer rows before dispatch.
 *
 * NOTE (V2-005d-c-CF-7): Capability values are initial best-effort from
 * research against Elegoo's published spec sheets and community-confirmed
 * teardown data. Refine when authoritative spec data becomes available — the
 * source of truth is the table here, but a follow-up sweep against vendor
 * docs is expected as the SDCP roster expands.
 *
 * The `SdcpKind` type is a strict subset of `ForgePrinterKind`. The legacy
 * generic `'resin_sdcp'` kind in FORGE_PRINTER_KINDS stays for backwards
 * compatibility with V2-005a-era printer rows; new printers should be
 * created with a per-model kind.
 *
 * Tier semantics:
 *   1 — Confirmed SDCP 3.0 device, current Elegoo OTA channel.
 *   2 — Community-reported SDCP support, may need a legacy MQTT/SDCP-1.x
 *       fallback path in the dispatcher.
 */

export const SDCP_KINDS = [
  'sdcp_elegoo_saturn_4',
  'sdcp_elegoo_saturn_4_ultra',
  'sdcp_elegoo_mars_5',
  'sdcp_elegoo_mars_5_ultra',
  'sdcp_elegoo_saturn_3_ultra',
  'sdcp_elegoo_mars_4_ultra',
  'sdcp_elegoo_saturn_2',
  'sdcp_elegoo_mars_3',
] as const;
export type SdcpKind = (typeof SDCP_KINDS)[number];

export interface SdcpModelCapability {
  buildVolumeMm: { x: number; y: number; z: number };
  xyResolutionUm: number;
  lcdResolution: { width: number; height: number };
  lcdType: 'mono' | 'color';
  /** false for all Elegoo SDCP (open boards) — kept here for shape-parity with ChituNetwork. */
  encryptedCtbRequired: boolean;
  displayName: string;
  /** Tier 1 = confirmed; Tier 2 = community-reported, may need legacy MQTT path. */
  tier: 1 | 2;
}

export const SDCP_MODEL_CAPABILITIES: Record<SdcpKind, SdcpModelCapability> = {
  sdcp_elegoo_saturn_4_ultra: {
    buildVolumeMm: { x: 219, y: 123, z: 220 },
    xyResolutionUm: 19,
    lcdResolution: { width: 11520, height: 5120 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Saturn 4 Ultra',
    tier: 1,
  },
  sdcp_elegoo_saturn_4: {
    buildVolumeMm: { x: 219, y: 123, z: 220 },
    xyResolutionUm: 19,
    lcdResolution: { width: 11520, height: 5120 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Saturn 4',
    tier: 1,
  },
  sdcp_elegoo_mars_5_ultra: {
    buildVolumeMm: { x: 153.36, y: 77.76, z: 165 },
    xyResolutionUm: 18,
    lcdResolution: { width: 8520, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Mars 5 Ultra',
    tier: 1,
  },
  sdcp_elegoo_mars_5: {
    buildVolumeMm: { x: 153.36, y: 77.76, z: 150 },
    xyResolutionUm: 18,
    lcdResolution: { width: 8520, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Mars 5',
    tier: 1,
  },
  sdcp_elegoo_saturn_3_ultra: {
    buildVolumeMm: { x: 218.88, y: 122.88, z: 260 },
    xyResolutionUm: 19,
    lcdResolution: { width: 11520, height: 5120 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Saturn 3 Ultra',
    tier: 1,
  },
  sdcp_elegoo_mars_4_ultra: {
    buildVolumeMm: { x: 153.36, y: 77.76, z: 175 },
    xyResolutionUm: 18,
    lcdResolution: { width: 8520, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Mars 4 Ultra',
    tier: 2,
  },
  sdcp_elegoo_saturn_2: {
    buildVolumeMm: { x: 219, y: 123, z: 250 },
    xyResolutionUm: 28.5,
    lcdResolution: { width: 7680, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Saturn 2',
    tier: 2,
  },
  sdcp_elegoo_mars_3: {
    buildVolumeMm: { x: 143, y: 89.6, z: 175 },
    xyResolutionUm: 35,
    lcdResolution: { width: 4098, height: 2560 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    displayName: 'Elegoo Mars 3',
    tier: 2,
  },
};

/** Type guard — narrows `string` to an SDCP per-model kind. */
export function isSdcpKind(kind: string): kind is SdcpKind {
  return (SDCP_KINDS as readonly string[]).includes(kind);
}

import { z } from 'zod';

/**
 * SDCP printer connection-config — operator-provided IP + MainboardID.
 * Discovery (UDP M99999) populates this initially; operator can also enter
 * manually. `port` defaults to 3030 (SDCP 3.0 standard); `startPrint=false`
 * is used by an "upload only" mode that stops after the chunked upload
 * succeeds without firing Cmd 128.
 */
export const SdcpConnectionConfig = z.object({
  ip: z.string().min(1),
  mainboardId: z.string().min(1).max(64),
  port: z.number().int().positive().default(3030),
  startPrint: z.boolean().default(true),
  startLayer: z.number().int().min(0).default(0),
});
export type SdcpConnectionConfigT = z.infer<typeof SdcpConnectionConfig>;

/**
 * SDCP has NO authentication at the protocol level (verified by spec + every
 * community implementation). The 'sdcp_passcode' credential kind in
 * forge_target_credentials is reserved for future firmware that may add auth.
 * For now, the credential row is optional and stores empty/null payload.
 */
export const SdcpCredentialPayload = z.object({}).strict();
export type SdcpCredentialPayloadT = z.infer<typeof SdcpCredentialPayload>;
