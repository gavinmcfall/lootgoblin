/**
 * printables.ts — Printables ScavengerAdapter (V2-003-T6)
 *
 * Printables forbids direct server-side scraping per their ToS.
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

export type { ExtensionMediatedAdapterOptions as PrintablesAdapterOptions } from './extension-mediated';

const PRINTABLES_HOSTS = new Set(['printables.com', 'www.printables.com']);

/**
 * Create the Printables adapter instance.
 *
 * There should be one instance per process — register it in createDefaultRegistry().
 */
export function createPrintablesAdapter(options?: ExtensionMediatedAdapterOptions): ScavengerAdapter {
  return {
    ...createExtensionMediatedAdapter('printables', PRINTABLES_HOSTS, options),
    id: 'printables' as const,
    metadata: {
      displayName: 'Printables',
      authMethods: ['extension'],
      supports: { url: true, sourceItemId: true, raw: true },
    },
  };
}
