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

// Shared filename sanitizer — used by URL-driven adapters (T5+).
export { sanitizeFilename } from './filename-sanitize';

// ---------------------------------------------------------------------------
// Default registry factory — T4+
//
// Registers all known adapters in a single process-level registry instance.
// URL-driven adapters (T5-T8: cults3d, makerworld, printables, sketchfab,
// google-drive) will be added here as each task lands.
// ---------------------------------------------------------------------------

import { createRegistry } from './registry';
import { createUploadAdapter } from './adapters/upload';
import { createCults3dAdapter } from './adapters/cults3d';
import type { ScavengerRegistry } from './registry';

/**
 * Create a ScavengerRegistry pre-populated with all currently implemented
 * adapters. Routes and instrumentation should call this once and share the
 * instance (or use a module-level singleton).
 *
 * T6-T8 will register makerworld, printables, sketchfab, google-drive
 * as each adapter task completes.
 */
export function createDefaultRegistry(): ScavengerRegistry {
  const registry = createRegistry();
  registry.register(createUploadAdapter());
  registry.register(createCults3dAdapter());
  // T6-T8 will add: makerworld, printables, sketchfab, google-drive
  return registry;
}
