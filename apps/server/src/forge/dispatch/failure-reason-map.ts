/**
 * failure-reason-map.ts — V2-005d-a T_da6
 *
 * Bridges adapter-level dispatch failure reasons (open enum exposed by
 * `DispatchHandler` implementations like Moonraker) to the closed schema
 * enum stored on `dispatch_jobs.failure_reason`.
 *
 * The schema enum is intentionally narrower than the adapter enum: the schema
 * captures user-visible failure categories (does the user need to fix auth?
 * is the printer offline? did slicing crash?), while the adapter enum captures
 * protocol-specific outcomes. Callers preserve the original adapter reason in
 * `failure_details` so audit-trail readers can recover full fidelity.
 *
 * FC-L1 carry-forward: this module mirrors the slicer worker's
 * `mapSliceFailure` pattern (see V2-005c-T_c10 / forge-slicer-worker.ts).
 *
 * Mapping table (adapter → schema):
 *   'unreachable'           → 'unreachable'
 *   'auth-failed'           → 'auth-failed'
 *   'rejected'              → 'target-rejected'
 *   'no-credentials'        → 'auth-failed'      (no creds == cannot auth)
 *   'unsupported-protocol'  → 'unsupported-format' (closest closed-set value)
 *   'timeout'               → 'unreachable'      (timeouts == effectively offline)
 *   'unknown'               → 'unknown'
 */

import type { ForgeDispatchFailureReason } from './handler';
import type { DispatchFailureReason } from '@/db/schema.forge';

/**
 * Map an adapter-level failure reason to the closed schema enum value.
 *
 * Callers preserve the raw adapter reason in `failure_details` for forensic
 * inspection — this map is lossy by design.
 */
export function mapAdapterReasonToSchema(
  adapter: ForgeDispatchFailureReason,
): DispatchFailureReason {
  switch (adapter) {
    case 'unreachable':
      return 'unreachable';
    case 'auth-failed':
      return 'auth-failed';
    case 'rejected':
      return 'target-rejected';
    case 'no-credentials':
      // No creds means we cannot authenticate to the target — same user-facing
      // category as 'auth-failed'. Detail line distinguishes them.
      return 'auth-failed';
    case 'unsupported-protocol':
      // No closed-set "no handler" value; 'unsupported-format' is the closest
      // user-visible meaning ("we can't talk to this kind of target").
      return 'unsupported-format';
    case 'timeout':
      // Timeouts are user-visibly "the target wasn't reachable in time".
      return 'unreachable';
    case 'unknown':
    default:
      return 'unknown';
  }
}
