/**
 * run-command.ts — V2-005b T_b1
 *
 * DI seam for shelling out to external tools (7z, Blender, which/where, etc.).
 * Every external invocation in the format-converter goes through this
 * interface so unit tests can inject a stub instead of touching the host.
 *
 * Production implementation wraps `child_process.execFile` and normalizes:
 *   - exit code (non-throwing on non-zero — caller decides what to do)
 *   - stdout/stderr buffers as utf-8 strings
 *   - timeout default 60s (overridable per call)
 *
 * Why execFile and not exec: execFile takes a discrete argv array, which
 * avoids shell-injection footguns. Tools we shell out to (7z, blender,
 * which) all accept argv-style invocation.
 *
 * Why we don't throw on non-zero: callers (sevenzip-archives, blender-mesh)
 * inspect stderr and want to surface the tool's own error message in the
 * ConversionResult. A throw-then-catch ladder would just discard that.
 */

import { execFile } from 'node:child_process';

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunCommandOptions {
  /** Milliseconds. Default 60_000. */
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: RunCommandOptions,
) => Promise<RunCommandResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Production implementation using child_process.execFile. */
export const runCommand: RunCommand = (cmd, args, opts) => {
  return new Promise<RunCommandResult>((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        // Generous buffer for `7z l -slt` listings on archives with hundreds
        // of files. 32 MiB covers everything realistic.
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        // execFile only sets `error` for spawn failures (ENOENT) or
        // non-zero exit codes. We always resolve with the captured streams
        // so callers can branch on `code`.
        const stdoutStr = String(stdout ?? '');
        const stderrStr = String(stderr ?? '');
        if (error) {
          // ENOENT (command not found): code is undefined, errno is set.
          // Surface as code=127 (POSIX command-not-found) so callers don't
          // need to special-case the spawn error.
          const code =
            typeof (error as NodeJS.ErrnoException).code === 'string' &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 127
              : typeof (error as { code?: number }).code === 'number'
                ? (error as { code: number }).code
                : 1;
          resolve({ stdout: stdoutStr, stderr: stderrStr || error.message, code });
          return;
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr, code: 0 });
      },
    );
  });
};
