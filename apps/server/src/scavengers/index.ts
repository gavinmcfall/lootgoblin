/**
 * Scavengers module barrel.
 *
 * Re-exports all public types and utilities from the scavengers layer.
 * Adapters are registered in createDefaultRegistry (wired below).
 */

export type {
  SourceId,
  NormalizedItem,
  AdapterFailureReason,
  ScavengerEvent,
  FetchContext,
  FetchTarget,
  ScavengerAdapter,
} from './types';

export type { ScavengerRegistry } from './registry';

export { createRegistry } from './registry';

export type { RetryDecision, RetryConfig } from './rate-limit';

export { nextRetry, sleep } from './rate-limit';

// Ingest pipeline — T2.
export type { IngestOutcome, IngestOptions, IngestPipeline, QuarantineReason } from './pipeline';
export { createIngestPipeline } from './pipeline';

// Format sniff helper — T2.
export { sniffFormat, DEFAULT_ACCEPTED_FORMATS } from './format-sniff';

// Link resolver — T3.
export type { LinkResolution, LinkContext, LinkResolver } from './link-resolver';
export { createLinkResolver } from './link-resolver';

// Adapters — T4+.
export type { UploadRawPayload } from './adapters/upload';
export { createUploadAdapter } from './adapters/upload';

export type { Cults3dCredentials, Cults3dAdapterOptions } from './adapters/cults3d';
export { createCults3dAdapter } from './adapters/cults3d';

// Extension-mediated adapters — T6.
export type {
  ExtensionPayload,
  ExtensionMediatedAdapterOptions,
} from './adapters/extension-mediated';
export { createExtensionMediatedAdapter } from './adapters/extension-mediated';

export type { MakerWorldAdapterOptions } from './adapters/makerworld';
export { createMakerWorldAdapter } from './adapters/makerworld';

export type { PrintablesAdapterOptions } from './adapters/printables';
export { createPrintablesAdapter } from './adapters/printables';

// Shared filename sanitizer — used by URL-driven adapters (T5+).
export { sanitizeFilename } from './filename-sanitize';

// ---------------------------------------------------------------------------
// Default registry factory — T4+
//
// Registers all known adapters in a single process-level registry instance.
// Extension-mediated adapters (T6: makerworld, printables) and future adapters
// (T7-T8: sketchfab, google-drive) are added here as each task lands.
// ---------------------------------------------------------------------------

import { createRegistry } from './registry';
import { createUploadAdapter } from './adapters/upload';
import { createCults3dAdapter } from './adapters/cults3d';
import { createMakerWorldAdapter } from './adapters/makerworld';
import { createPrintablesAdapter } from './adapters/printables';
import type { ScavengerRegistry } from './registry';

/**
 * Create a ScavengerRegistry pre-populated with all currently implemented
 * adapters. Routes and instrumentation should call this once and share the
 * instance (or use a module-level singleton).
 *
 * T7-T8 will register sketchfab, google-drive as each adapter task completes.
 */
export function createDefaultRegistry(): ScavengerRegistry {
  const registry = createRegistry();
  registry.register(createUploadAdapter());
  registry.register(createCults3dAdapter());
  registry.register(createMakerWorldAdapter());
  registry.register(createPrintablesAdapter());
  // T7-T8 will add: sketchfab, google-drive
  return registry;
}
