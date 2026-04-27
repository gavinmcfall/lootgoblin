/**
 * route-helpers.ts — V2-005c T_c6
 *
 * Helpers shared by `/api/v1/forge/tools/*` route files. Lives in
 * `src/forge/slicer/` because Next.js App Router forbids non-route exports
 * from `route.ts` files — anything reusable across the four route files
 * (GET list, POST install, DELETE uninstall, POST update) has to live
 * outside the `app/` tree.
 *
 * Also defines a per-process injectable seam for the install pipeline's
 * `http` + `run` dependencies, mirroring the pattern used by the V2-005b
 * forge-slicer-worker. Tests call `setInstallerDeps(...)` to swap in mocks
 * without touching the GitHub API or shelling out to `tar`.
 */
import {
  FORGE_SLICER_KINDS_INSTALLABLE,
  type ForgeSlicerKindInstallable,
} from '@/db/schema.forge';

import { makeFetchHttpClient, type HttpClient } from './github-releases';
import { runCommand } from '../converter/run-command';
import type { RunCommand } from '../converter/run-command';

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

/**
 * Narrow a raw path-param value to a known installable slicer kind, or
 * return null if the param doesn't match the allow-list. Routes turn null
 * into a 400 `invalid-slicer-kind` response.
 */
export function parseSlicerKind(
  raw: string | undefined,
): ForgeSlicerKindInstallable | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return (FORGE_SLICER_KINDS_INSTALLABLE as readonly string[]).includes(raw)
    ? (raw as ForgeSlicerKindInstallable)
    : null;
}

// ---------------------------------------------------------------------------
// Installer-deps injection seam
// ---------------------------------------------------------------------------

export interface InstallerDeps {
  http: HttpClient;
  run: RunCommand;
}

let currentInstallerDeps: InstallerDeps | null = null;

/** Returns the injected deps, falling back to production fetch + execFile. */
export function getInstallerDeps(): InstallerDeps {
  if (currentInstallerDeps) return currentInstallerDeps;
  return { http: makeFetchHttpClient(), run: runCommand };
}

/**
 * Test seam — replace the deps used by POST install/update. Pass `null` to
 * restore production deps. Mirrors the V2-005b worker testability pattern.
 */
export function setInstallerDeps(deps: InstallerDeps | null): void {
  currentInstallerDeps = deps;
}
