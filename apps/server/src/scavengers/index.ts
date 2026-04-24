/**
 * Scavengers module barrel.
 *
 * Re-exports all public types and utilities from the scavengers layer.
 * Future task modules (T4-T10 adapters) also live under this directory
 * and should be added to this barrel as they land.
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
