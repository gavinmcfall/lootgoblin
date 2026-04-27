/**
 * tool-availability.ts — V2-005b T_b1
 *
 * Per-process cache of "is `<tool>` on PATH?" answers, probed via
 * `which` (POSIX) or `where` (Windows). A successful probe (exit 0) means
 * the tool exists and is callable. A non-zero exit means missing.
 *
 * The cache is a module-level Map keyed by tool name. First call runs the
 * probe and caches the resulting Promise; subsequent calls return the same
 * Promise. Tests reset between runs via `resetToolAvailabilityCache()`.
 *
 * The `runCommand` dependency is injectable so unit tests can stub the
 * which/where probe deterministically without touching the host.
 */

import { runCommand as defaultRunCommand, type RunCommand } from './run-command';

const cache = new Map<string, Promise<boolean>>();

const isWindows = process.platform === 'win32';
const PROBE_CMD = isWindows ? 'where' : 'which';

/**
 * Returns true iff `toolName` resolves to an executable on PATH. Cached
 * per-process per-tool — first probe wins.
 *
 * Optional `runCmd` lets tests inject a fake command runner. When omitted,
 * the production implementation (`runCommand` from ./run-command) is used.
 */
export async function isToolAvailable(
  toolName: string,
  runCmd: RunCommand = defaultRunCommand,
): Promise<boolean> {
  const cached = cache.get(toolName);
  if (cached) return cached;

  const probe = (async () => {
    try {
      const result = await runCmd(PROBE_CMD, [toolName], { timeout: 5_000 });
      return result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      // Defensive: if the probe runner itself throws, treat as missing.
      return false;
    }
  })();

  cache.set(toolName, probe);
  return probe;
}

/**
 * Drop the in-memory cache. Tests call this between cases that simulate
 * different host configurations. Production code never invokes this.
 */
export function resetToolAvailabilityCache(): void {
  cache.clear();
}
