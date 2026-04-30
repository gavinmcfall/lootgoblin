/**
 * handler.ts — V2-005d-a T_da4
 *
 * Defines the DispatchHandler interface that protocol-specific adapters
 * (Moonraker, OctoPrint, BambuLab, etc.) implement, plus the contextual
 * surface (`DispatchContext`) the worker passes to each dispatch invocation.
 *
 * The registry (registry.ts) keeps a Map of these keyed by `kind` (matches
 * the value stored in the `printers.kind` column, e.g. `fdm_klipper`).
 *
 * Pure type module — no DB, HTTP, or filesystem dependencies. The HttpClient
 * abstraction lets handler implementations stay test-friendly while the real
 * worker wires in `globalThis.fetch`.
 */
import type { Logger } from 'pino';

import type { DecryptedCredential } from './credentials';

export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DispatchContext {
  job: { id: string; ownerId: string; targetId: string };
  printer: {
    id: string;
    ownerId: string;
    kind: string;
    connectionConfig: Record<string, unknown>;
  };
  artifact: { storagePath: string; sizeBytes: number; sha256: string };
  credential: DecryptedCredential | null;
  http: HttpClient;
  logger: Logger;
}

export type ForgeDispatchFailureReason =
  | 'unreachable'
  | 'auth-failed'
  | 'rejected'
  | 'no-credentials'
  | 'unsupported-protocol'
  | 'timeout'
  | 'unknown';

export type DispatchOutcome =
  | { kind: 'success'; remoteFilename: string; details?: Record<string, unknown> }
  | { kind: 'failure'; reason: ForgeDispatchFailureReason; details?: string };

export interface DispatchHandler {
  /** Matches the value stored in printers.kind (e.g. 'fdm_klipper'). */
  kind: string;
  dispatch(ctx: DispatchContext): Promise<DispatchOutcome>;
}
