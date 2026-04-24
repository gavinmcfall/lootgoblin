/**
 * upload.ts — Upload ScavengerAdapter (V2-003-T4)
 *
 * Handles user-uploaded files pre-staged to a tempDir. The route writes the
 * files to a tempDir first, then hands {tempDir, metadata} to this adapter
 * as a 'raw' payload. The adapter moves each file into the pipeline's
 * stagingDir (same-device atomic rename) and yields a completed event.
 *
 * This adapter is NOT URL-driven — supports() always returns false.
 * The route calls _registry.getById('upload') directly.
 */

import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { ScavengerAdapter, ScavengerEvent, FetchContext, FetchTarget } from '../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UploadRawPayload = {
  /**
   * Pre-created tempDir containing the uploaded files.
   * MUST be on the same filesystem device as the pipeline's stagingDir
   * so that fs.rename() is atomic. (Both default to /tmp — guaranteed same device.)
   */
  tempDir: string;
  /** User-provided item metadata. title is required. */
  metadata: {
    title: string;
    description?: string;
    creator?: string;
    license?: string;
    tags?: string[];
  };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the upload adapter instance.
 *
 * There should be one instance per process — register it in createDefaultRegistry().
 */
export function createUploadAdapter(): ScavengerAdapter {
  return {
    id: 'upload' as const,

    /**
     * Upload is not URL-driven. The registry's resolveUrl() path never
     * invokes this adapter. Routes that accept uploads call getById('upload')
     * directly and pass a 'raw' target with the tempDir payload.
     */
    supports(_url: string): boolean {
      return false;
    },

    fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            // ── 1. Validate target kind ──────────────────────────────────────
            if (target.kind !== 'raw') {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: 'upload adapter requires raw target',
              };
              return;
            }

            // ── 2. Validate payload ──────────────────────────────────────────
            const payload = target.payload as UploadRawPayload;

            if (!payload || typeof payload.tempDir !== 'string' || !payload.tempDir) {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: 'upload adapter: payload.tempDir is required',
              };
              return;
            }

            if (
              !payload.metadata ||
              typeof payload.metadata.title !== 'string' ||
              payload.metadata.title.trim().length === 0
            ) {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: 'upload adapter: payload.metadata.title is required',
              };
              return;
            }

            const { tempDir, metadata } = payload;

            // Verify tempDir exists and is a directory.
            try {
              const stat = await fsp.stat(tempDir);
              if (!stat.isDirectory()) {
                yield {
                  kind: 'failed' as const,
                  reason: 'unknown' as const,
                  details: `upload adapter: tempDir is not a directory: ${tempDir}`,
                };
                return;
              }
            } catch (err) {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: `upload adapter: tempDir does not exist or is not accessible: ${(err as Error).message}`,
              };
              return;
            }

            // ── 3. Read tempDir contents ─────────────────────────────────────
            const entries = await fsp.readdir(tempDir, { withFileTypes: true });
            const fileEntries = entries.filter((e) => e.isFile());

            if (fileEntries.length === 0) {
              // Clean up the empty tempDir before yielding failure.
              await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: 'upload adapter: no files in tempDir',
              };
              return;
            }

            // ── 4. Move each file to stagingDir (atomic rename) ─────────────
            const stagedFiles: Array<{
              stagedPath: string;
              suggestedName: string;
              size: number;
            }> = [];

            for (const entry of fileEntries) {
              const filename = entry.name;
              const srcPath = path.join(tempDir, filename);
              const dstPath = path.join(context.stagingDir, filename);

              try {
                await fsp.rename(srcPath, dstPath);
              } catch (renameErr) {
                // EXDEV: cross-device rename — fall back to copy+unlink.
                const code = (renameErr as NodeJS.ErrnoException).code;
                if (code === 'EXDEV') {
                  await fsp.copyFile(srcPath, dstPath);
                  await fsp.unlink(srcPath).catch(() => {});
                } else {
                  throw renameErr;
                }
              }

              // Stat the file for size. Use the destination path (rename is done).
              const stat = await fsp.stat(dstPath);
              stagedFiles.push({
                stagedPath: dstPath,
                suggestedName: filename,
                size: stat.size,
              });
            }

            // ── 5. Clean up tempDir (best effort) ───────────────────────────
            await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});

            // ── 6. Build NormalizedItem ──────────────────────────────────────
            //
            // sourceItemId: a fresh UUID per upload — each upload is its own
            // unique item, not deduplicated by source id.
            yield {
              kind: 'completed' as const,
              item: {
                sourceId: 'upload' as const,
                sourceItemId: crypto.randomUUID(),
                title: metadata.title.trim(),
                description: metadata.description,
                creator: metadata.creator,
                license: metadata.license,
                tags: metadata.tags,
                files: stagedFiles.map((f) => ({
                  stagedPath: f.stagedPath,
                  suggestedName: f.suggestedName,
                  size: f.size,
                  // format left undefined — pipeline sniffs via magic bytes
                })),
              },
            };
          } catch (err) {
            // Catch-all — surface as failed event rather than letting the
            // async generator throw (which would propagate as an unhandled
            // rejection from the pipeline's for-await loop).
            yield {
              kind: 'failed' as const,
              reason: 'unknown' as const,
              details: err instanceof Error ? err.message : String(err),
            };
          }
        },
      };
    },
  };
}
