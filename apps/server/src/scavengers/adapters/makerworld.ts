/**
 * makerworld.ts — MakerWorld ScavengerAdapter (V2-003-T6)
 *
 * MakerWorld forbids direct server-side scraping per their ToS.
 * This adapter delegates ALL scraping to the paired browser extension.
 * It only accepts `target.kind = 'raw'` payloads (ExtensionPayload) and
 * downloads the pre-authorized file URLs the extension obtained via its session.
 *
 * Registration: added to createDefaultRegistry() in scavengers/index.ts.
 */

import type { ScavengerAdapter } from '../types';
import {
  createExtensionMediatedAdapter,
  type ExtensionMediatedAdapterOptions,
} from './extension-mediated';

export type { ExtensionMediatedAdapterOptions as MakerWorldAdapterOptions } from './extension-mediated';

const MAKERWORLD_HOSTS = new Set(['makerworld.com', 'www.makerworld.com']);

/**
 * Create the MakerWorld adapter instance.
 *
 * There should be one instance per process — register it in createDefaultRegistry().
 */
export function createMakerWorldAdapter(options?: ExtensionMediatedAdapterOptions): ScavengerAdapter {
  return {
    ...createExtensionMediatedAdapter('makerworld', MAKERWORLD_HOSTS, options),
    id: 'makerworld' as const,
    metadata: {
      displayName: 'MakerWorld',
      authMethods: ['extension'],
      supports: { url: true, sourceItemId: true, raw: true },
    },
  };
}
