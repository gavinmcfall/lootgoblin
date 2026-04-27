/**
 * update-checker.ts — V2-005c T_c5
 *
 * Slicer update-availability checker. Two entry points:
 *   - runUpdateCheckOnce: a single pass over all installed slicers; probes
 *     GitHub Releases for each `ready` install and patches the registry row
 *     with availableVersion / updateAvailable / lastUpdateCheckAt.
 *   - startSlicerUpdateChecker: schedules the runner (boot-grace + nightly)
 *     and returns a stop() handle. ALL background errors are swallowed so a
 *     transient GitHub blip can never take down the server.
 *
 * Operators who don't want auto-update probing (air-gapped, rate-limit
 * conscious, etc.) can set FORGE_DISABLE_SLICER_AUTOUPDATE=1 — runOnce
 * short-circuits to zeros without touching the network or the DB.
 *
 * Version comparison is plain string-equality for v1; semver-aware ordering
 * lives behind T_c11+ once the UI surfaces "downgrade?" affordances.
 */

import {
  makeFetchHttpClient,
  probeLatestRelease,
  type HttpClient,
} from './github-releases';
import { listInstalls, setInstallStatus } from './registry';
import { logger } from '@/logger';

export interface UpdateCheckResult {
  checked: number;
  updatesAvailable: number;
  failures: number;
}

export async function runUpdateCheckOnce(opts: {
  http: HttpClient;
  dbUrl?: string;
}): Promise<UpdateCheckResult> {
  if (process.env.FORGE_DISABLE_SLICER_AUTOUPDATE === '1') {
    logger.debug(
      'forge.slicer.update-checker: skipped (FORGE_DISABLE_SLICER_AUTOUPDATE=1)',
    );
    return { checked: 0, updatesAvailable: 0, failures: 0 };
  }

  const installs = listInstalls({ dbUrl: opts.dbUrl });
  let checked = 0;
  let updatesAvailable = 0;
  let failures = 0;

  for (const install of installs) {
    // Only probe healthy installs — re-checking 'failed' / 'downloading' rows
    // would race the installer and surface confusing UI states. The installer
    // owns those transitions; this checker only annotates `ready` rows.
    if (install.installStatus !== 'ready') continue;

    checked += 1;
    const checkedAt = new Date();

    try {
      const release = await probeLatestRelease({
        slicerKind: install.slicerKind,
        http: opts.http,
      });
      const updateAvailable = release.version !== install.installedVersion;
      if (updateAvailable) updatesAvailable += 1;

      setInstallStatus({
        slicerKind: install.slicerKind,
        patch: {
          availableVersion: release.version,
          updateAvailable,
          lastUpdateCheckAt: checkedAt,
        },
        dbUrl: opts.dbUrl,
      });
    } catch (err) {
      failures += 1;
      logger.warn(
        {
          slicerKind: install.slicerKind,
          err: err instanceof Error ? err.message : String(err),
        },
        'forge.slicer.update-checker: probe failed',
      );
      // Still bump lastUpdateCheckAt so the UI reflects the attempt — but
      // leave availableVersion / updateAvailable alone so stale-but-known
      // info isn't clobbered by a transient outage.
      try {
        setInstallStatus({
          slicerKind: install.slicerKind,
          patch: { lastUpdateCheckAt: checkedAt },
          dbUrl: opts.dbUrl,
        });
      } catch (innerErr) {
        logger.warn(
          {
            slicerKind: install.slicerKind,
            err:
              innerErr instanceof Error ? innerErr.message : String(innerErr),
          },
          'forge.slicer.update-checker: failed to record probe attempt',
        );
      }
    }
  }

  return { checked, updatesAvailable, failures };
}

export interface StartSlicerUpdateCheckerOpts {
  intervalMs?: number;
  bootGraceMs?: number;
  http?: HttpClient;
  dbUrl?: string;
  /**
   * Test seam: inject a stub runner for scheduler tests so we can assert call
   * counts under fake timers without standing up the full probe stack.
   */
  runner?: (opts: {
    http: HttpClient;
    dbUrl?: string;
  }) => Promise<UpdateCheckResult>;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BOOT_GRACE_MS = 30 * 1000;

export function startSlicerUpdateChecker(
  opts: StartSlicerUpdateCheckerOpts = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const bootGraceMs = opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const http = opts.http ?? makeFetchHttpClient();
  const runner = opts.runner ?? runUpdateCheckOnce;

  const tick = (): void => {
    // Fire-and-forget. Swallow rejections so an unexpected throw inside the
    // runner can't escape into the event loop as an unhandled rejection.
    Promise.resolve()
      .then(() => runner({ http, dbUrl: opts.dbUrl }))
      .then((result) => {
        logger.debug(
          { ...result },
          'forge.slicer.update-checker: tick complete',
        );
      })
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'forge.slicer.update-checker: tick failed',
        );
      });
  };

  const bootTimer = setTimeout(tick, bootGraceMs);
  const intervalTimer = setInterval(tick, intervalMs);

  return function stop(): void {
    clearTimeout(bootTimer);
    clearInterval(intervalTimer);
  };
}
