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
  ScavengerMetadata,
  ScavengerAuthMethod,
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
//
// `createExtensionMediatedAdapter` is intentionally NOT re-exported here.
// It is an internal factory used only by the makerworld + printables wrappers;
// public consumers should use the per-source factories below.
export type {
  ExtensionPayload,
  ExtensionMediatedAdapterOptions,
} from './adapters/extension-mediated';

export type { MakerWorldAdapterOptions } from './adapters/makerworld';
export { createMakerWorldAdapter } from './adapters/makerworld';

export type { PrintablesAdapterOptions } from './adapters/printables';
export { createPrintablesAdapter } from './adapters/printables';

// Sketchfab adapter — T7 (first OAuth-flow adapter).
export type {
  SketchfabAdapterOptions,
  SketchfabCredentials,
  SketchfabOAuthCredentials,
  SketchfabApiTokenCredentials,
} from './adapters/sketchfab';
export { createSketchfabAdapter } from './adapters/sketchfab';

// Google Drive adapter — T8 (OAuth + API key + folder recursion).
export type {
  GDriveAdapterOptions,
  GDriveCredentials,
  GDriveOAuthCredentials,
  GDriveApiKeyCredentials,
  GDriveDualCredentials,
  GDriveCaps,
} from './adapters/gdrive';
export { createGdriveAdapter } from './adapters/gdrive';

// Thingiverse adapter — V2-003b-T1 (API token + OAuth + remix metadata).
export type {
  ThingiverseAdapterOptions,
  ThingiverseCredentials,
  ThingiverseOAuthCredentials,
  ThingiverseApiTokenCredentials,
  ThingiverseDualCredentials,
  ThingiverseCaps,
} from './adapters/thingiverse';
export { createThingiverseAdapter } from './adapters/thingiverse';

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
import { createSketchfabAdapter } from './adapters/sketchfab';
import { createGdriveAdapter } from './adapters/gdrive';
import { createThingiverseAdapter } from './adapters/thingiverse';
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
  registry.register(createSketchfabAdapter());
  registry.register(createGdriveAdapter());
  registry.register(createThingiverseAdapter());
  return registry;
}

/**
 * Process-level singleton registry — V2-003-T9.
 *
 * Routes that need adapter metadata (e.g. /api/v1/sources, /api/v1/ingest,
 * /api/v1/source-auth/:sourceId) import this singleton instead of calling
 * createDefaultRegistry() per request. The factory is cheap, but the
 * singleton lets us share any future adapter-level cache across requests.
 *
 * HMR-safe: stateless adapters + Map-backed registry. If an adapter ever
 * adds in-memory state, swap this for a global symbol cache to survive
 * dev-mode module reloads.
 */
export const defaultRegistry: ScavengerRegistry = createDefaultRegistry();
