/**
 * hash-util.ts — shared SHA-256 hashing helper.
 *
 * Extracted from inbox-triage.ts and adoption/applier.ts (T8 code review fix #7)
 * so both code paths share a single implementation.
 *
 * Streaming via node:stream/promises.pipeline so large files don't pull the
 * whole buffer into memory.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Streams a file through SHA-256 and returns the hex digest.
 *
 * Errors propagate — callers decide whether to fall back to a zero-hash
 * sentinel or surface the error. The previous per-site implementations
 * each had their own try/catch fallback; that remains the caller's
 * responsibility.
 */
export async function sha256Hex(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest('hex');
}
