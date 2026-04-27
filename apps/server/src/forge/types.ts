/**
 * Forge pillar types — V2-005a-T1
 *
 * Re-exports the schema-side enum unions and Drizzle row types, plus type
 * guards downstream tasks (T2 dispatch worker, T3 adapters, T4-T7 HTTP +
 * UI) can use without re-importing the schema module directly.
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  FORGE_PRINTER_KINDS,
  FORGE_SLICER_KINDS,
  SLICER_INVOCATION_METHODS,
  ACL_LEVELS,
  AGENT_KINDS,
  DISPATCH_TARGET_KINDS,
  DISPATCH_JOB_STATUSES,
  DISPATCH_FAILURE_REASONS,
  agents,
  printers,
  printerReachableVia,
  forgeSlicers,
  printerAcls,
  slicerAcls,
  dispatchJobs,
} from '../db/schema.forge';

// ---------------------------------------------------------------------------
// Enum re-exports
// ---------------------------------------------------------------------------

export {
  FORGE_PRINTER_KINDS,
  FORGE_SLICER_KINDS,
  SLICER_INVOCATION_METHODS,
  ACL_LEVELS,
  AGENT_KINDS,
  DISPATCH_TARGET_KINDS,
  DISPATCH_JOB_STATUSES,
  DISPATCH_FAILURE_REASONS,
};

export type {
  ForgePrinterKind,
  ForgeSlicerKind,
  SlicerInvocationMethod,
  AclLevel,
  AgentKind,
  DispatchTargetKind,
  DispatchJobStatus,
  DispatchFailureReason,
} from '../db/schema.forge';

// ---------------------------------------------------------------------------
// Drizzle row types
// ---------------------------------------------------------------------------

export type Agent = InferSelectModel<typeof agents>;
export type AgentInsert = InferInsertModel<typeof agents>;

export type Printer = InferSelectModel<typeof printers>;
export type PrinterInsert = InferInsertModel<typeof printers>;

export type PrinterReachableVia = InferSelectModel<typeof printerReachableVia>;
export type PrinterReachableViaInsert = InferInsertModel<typeof printerReachableVia>;

export type ForgeSlicer = InferSelectModel<typeof forgeSlicers>;
export type ForgeSlicerInsert = InferInsertModel<typeof forgeSlicers>;

export type PrinterAcl = InferSelectModel<typeof printerAcls>;
export type PrinterAclInsert = InferInsertModel<typeof printerAcls>;

export type SlicerAcl = InferSelectModel<typeof slicerAcls>;
export type SlicerAclInsert = InferInsertModel<typeof slicerAcls>;

export type DispatchJob = InferSelectModel<typeof dispatchJobs>;
export type DispatchJobInsert = InferInsertModel<typeof dispatchJobs>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

import type {
  ForgePrinterKind,
  ForgeSlicerKind,
  SlicerInvocationMethod,
  AclLevel,
  AgentKind,
  DispatchTargetKind,
  DispatchJobStatus,
  DispatchFailureReason,
} from '../db/schema.forge';

export function isForgePrinterKind(value: string): value is ForgePrinterKind {
  return (FORGE_PRINTER_KINDS as readonly string[]).includes(value);
}

export function isForgeSlicerKind(value: string): value is ForgeSlicerKind {
  return (FORGE_SLICER_KINDS as readonly string[]).includes(value);
}

export function isSlicerInvocationMethod(value: string): value is SlicerInvocationMethod {
  return (SLICER_INVOCATION_METHODS as readonly string[]).includes(value);
}

export function isAclLevel(value: string): value is AclLevel {
  return (ACL_LEVELS as readonly string[]).includes(value);
}

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value);
}

export function isDispatchTargetKind(value: string): value is DispatchTargetKind {
  return (DISPATCH_TARGET_KINDS as readonly string[]).includes(value);
}

export function isDispatchJobStatus(value: string): value is DispatchJobStatus {
  return (DISPATCH_JOB_STATUSES as readonly string[]).includes(value);
}

export function isDispatchFailureReason(value: string): value is DispatchFailureReason {
  return (DISPATCH_FAILURE_REASONS as readonly string[]).includes(value);
}
