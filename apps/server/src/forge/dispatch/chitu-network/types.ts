/**
 * types.ts — V2-005d-c T_dc1
 *
 * Per-model capability data for ChituBox legacy network resin printers —
 * Phrozen + Uniformation + legacy-firmware Elegoo (pre-SDCP). These devices
 * speak the older ChiTu network protocol (M-codes over TCP) and accept
 * `.ctb` slices, with Uniformation also accepting `.jxs` and legacy Elegoo
 * also accepting `.cbddlp`.
 *
 * NOTE (V2-005d-c-CF-7): Capability values are initial best-effort from
 * research against vendor spec sheets. The `encryptedCtbRequired` flag is
 * load-bearing for the slice pipeline — locked ChiTu boards (Phrozen,
 * Uniformation GKtwo with stock firmware ≤1.1.1) reject unencrypted
 * `.ctb`; the slicer profile must emit the encrypted variant.
 *
 * The `ChituNetworkKind` type is a strict subset of `ForgePrinterKind`.
 *
 * Tier semantics:
 *   1 — Confirmed ChiTu network protocol with current vendor firmware.
 *   2 — Community-reported / legacy firmware, may need feature probing.
 */

export const CHITU_NETWORK_KINDS = [
  'chitu_network_phrozen_sonic_mighty_8k',
  'chitu_network_phrozen_sonic_mega_8k',
  'chitu_network_phrozen_sonic_mini_8k',
  'chitu_network_uniformation_gktwo',
  'chitu_network_uniformation_gkone',
  'chitu_network_elegoo_mars_legacy',
  'chitu_network_elegoo_saturn_legacy',
] as const;
export type ChituNetworkKind = (typeof CHITU_NETWORK_KINDS)[number];

export interface ChituNetworkModelCapability {
  buildVolumeMm: { x: number; y: number; z: number };
  xyResolutionUm: number;
  lcdResolution: { width: number; height: number };
  lcdType: 'mono' | 'color';
  /**
   * true for locked ChiTu boards (Phrozen Mighty/Mega/Mini 8K, GKtwo,
   * GKone) — slicer profile MUST emit encrypted `.ctb`. false for
   * pre-SDCP open Elegoo boards.
   */
  encryptedCtbRequired: boolean;
  /** Sliced extensions the printer will accept on push. e.g. ['.ctb'] or ['.ctb', '.jxs']. */
  acceptedExtensions: string[];
  displayName: string;
  tier: 1 | 2;
}

export const CHITU_NETWORK_MODEL_CAPABILITIES: Record<ChituNetworkKind, ChituNetworkModelCapability> = {
  chitu_network_phrozen_sonic_mighty_8k: {
    buildVolumeMm: { x: 218, y: 123, z: 235 },
    xyResolutionUm: 28,
    lcdResolution: { width: 7680, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: true,
    acceptedExtensions: ['.ctb'],
    displayName: 'Phrozen Sonic Mighty 8K',
    tier: 1,
  },
  chitu_network_phrozen_sonic_mega_8k: {
    buildVolumeMm: { x: 330, y: 185, z: 400 },
    xyResolutionUm: 43,
    lcdResolution: { width: 7680, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: true,
    acceptedExtensions: ['.ctb'],
    displayName: 'Phrozen Sonic Mega 8K',
    tier: 1,
  },
  chitu_network_phrozen_sonic_mini_8k: {
    buildVolumeMm: { x: 165, y: 72, z: 180 },
    xyResolutionUm: 22,
    lcdResolution: { width: 7500, height: 3240 },
    lcdType: 'mono',
    encryptedCtbRequired: true,
    acceptedExtensions: ['.ctb'],
    displayName: 'Phrozen Sonic Mini 8K',
    tier: 1,
  },
  chitu_network_uniformation_gktwo: {
    buildVolumeMm: { x: 228, y: 128, z: 245 },
    xyResolutionUm: 28,
    lcdResolution: { width: 7680, height: 4320 },
    lcdType: 'mono',
    encryptedCtbRequired: true,
    acceptedExtensions: ['.ctb', '.jxs'],
    displayName: 'Uniformation GKtwo',
    tier: 1,
  },
  chitu_network_uniformation_gkone: {
    buildVolumeMm: { x: 192, y: 120, z: 200 },
    xyResolutionUm: 50,
    lcdResolution: { width: 3840, height: 2400 },
    lcdType: 'mono',
    encryptedCtbRequired: true,
    acceptedExtensions: ['.ctb'],
    displayName: 'Uniformation GKone',
    tier: 2,
  },
  chitu_network_elegoo_mars_legacy: {
    buildVolumeMm: { x: 143, y: 89, z: 165 },
    xyResolutionUm: 47,
    lcdResolution: { width: 2560, height: 1620 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    acceptedExtensions: ['.ctb', '.cbddlp'],
    displayName: 'Elegoo Mars (legacy firmware)',
    tier: 2,
  },
  chitu_network_elegoo_saturn_legacy: {
    buildVolumeMm: { x: 192, y: 120, z: 200 },
    xyResolutionUm: 50,
    lcdResolution: { width: 3840, height: 2400 },
    lcdType: 'mono',
    encryptedCtbRequired: false,
    acceptedExtensions: ['.ctb', '.cbddlp'],
    displayName: 'Elegoo Saturn (legacy firmware)',
    tier: 2,
  },
};

/** Type guard — narrows `string` to a ChituNetwork per-model kind. */
export function isChituNetworkKind(kind: string): kind is ChituNetworkKind {
  return (CHITU_NETWORK_KINDS as readonly string[]).includes(kind);
}

import { z } from 'zod';

/**
 * ChituBox legacy network printer connection-config — operator-provided IP only.
 * No authentication at protocol level; printer is trusted-LAN.
 */
export const ChituNetworkConnectionConfig = z.object({
  ip: z.string().min(1),
  port: z.number().int().positive().default(3000),
  startPrint: z.boolean().default(true),
  /** Per-stage timeout — defaults to 60000 to accommodate slower WiFi. */
  stageTimeoutMs: z.number().int().positive().default(60_000),
});
export type ChituNetworkConnectionConfigT = z.infer<typeof ChituNetworkConnectionConfig>;

/**
 * ChituBox legacy network has NO authentication. The 'sdcp_passcode' kind
 * (shared with SDCP for storage convenience) stores empty payload.
 */
export const ChituNetworkCredentialPayload = z.object({}).strict();
export type ChituNetworkCredentialPayloadT = z.infer<typeof ChituNetworkCredentialPayload>;
