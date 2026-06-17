// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * POST /api/v1/dispatch/claim — V2-006a-T6
 *
 * Courier polls this endpoint to atomically claim the oldest claimable job
 * reachable by its agent. On success, responds with everything the Courier
 * needs to execute the job without further server round-trips.
 *
 * Flow (mirrors forge-claim-worker.ts runOneClaimTick, stopping before
 * markDispatched — T8 handles that transition when the Courier reports success):
 *
 *   1. Authenticate via authenticateCourier — identity from key only.
 *   2. findClaimableCandidate(agentId) — null → { job: null } (polite 200).
 *   3. If printer-target: extractAndPersistSlicerEstimate (best-effort, swallowed).
 *   4. markClaimed({ jobId, agentId }) — race lost → { job: null }.
 *   5. buildExecutionBundle(jobId) — null (vanished) → log + { job: null }.
 *   6. Respond 200 with snake_case execution payload.
 *      download_url = /api/v1/dispatch/artifact/<jobId>  (T7 serves the bytes).
 *
 * Auth: Courier API key in `x-api-key` header (courier_pairing scope).
 * Security: storagePath is never sent to the Courier — only size/sha/mime +
 *           the download_url. Decrypted credential.payload IS sent (the
 *           Courier is authenticated + holds the claim).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticateCourier,
  INVALID_API_KEY,
  unauthenticatedResponse,
} from '@/auth/courier-auth';
import { markClaimed } from '@/forge/dispatch-state';
import {
  findClaimableCandidate,
  extractAndPersistSlicerEstimate,
  buildExecutionBundle,
} from '@/forge/dispatch/claim-core';
import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Authenticate — identity comes ONLY from the courier_pairing key.
  const courier = await authenticateCourier(req);
  if (!courier || courier === INVALID_API_KEY) {
    return unauthenticatedResponse(courier as null | typeof INVALID_API_KEY);
  }
  const { agentId } = courier;

  // 2. Find the oldest claimable job reachable by this agent.
  const candidate = await findClaimableCandidate(agentId);
  if (!candidate) {
    return NextResponse.json({ job: null }, { status: 200 });
  }

  // 3. Best-effort slicer-estimate extraction (printer-target only).
  //    Mirrors the worker: failures are logged and swallowed — they must not
  //    block the claim.
  if (candidate.targetKind === 'printer') {
    try {
      await extractAndPersistSlicerEstimate({
        dispatchJobId: candidate.id,
        lootId: candidate.lootId,
        printerId: candidate.targetId,
      });
    } catch (err) {
      logger.warn(
        { err, jobId: candidate.id },
        'dispatch-claim: slicer-estimate extraction threw — continuing',
      );
    }
  }

  // 4. Atomically claim. Race losers (another agent or worker tick already
  //    flipped the row) bail out gracefully — the Courier will poll again.
  const claimResult = await markClaimed({ jobId: candidate.id, agentId });
  if (!claimResult.ok) {
    return NextResponse.json({ job: null }, { status: 200 });
  }

  // 5. Assemble the execution bundle. In normal operation this cannot be null
  //    after a successful claim, but handle defensively.
  const bundle = await buildExecutionBundle(candidate.id);
  if (!bundle) {
    logger.error(
      { jobId: candidate.id, agentId },
      'dispatch-claim: buildExecutionBundle returned null after successful claim — job row vanished',
    );
    return NextResponse.json({ job: null }, { status: 200 });
  }

  // 6. Respond with the execution payload (snake_case — matches v1 surface).
  //    storagePath is intentionally omitted; the Courier fetches bytes via T7.
  const downloadUrl = `/api/v1/dispatch/artifact/${bundle.job.id}`;

  return NextResponse.json(
    {
      job: {
        id: bundle.job.id,
        target_kind: bundle.job.targetKind,
        target_id: bundle.job.targetId,
        loot_id: bundle.job.lootId,
        owner_id: bundle.job.ownerId,
      },
      printer: bundle.printer
        ? {
            id: bundle.printer.id,
            kind: bundle.printer.kind,
            connection_config: bundle.printer.connectionConfig,
          }
        : null,
      credential: bundle.credential
        ? {
            kind: bundle.credential.kind,
            payload: bundle.credential.payload,
          }
        : null,
      artifact: bundle.artifact
        ? {
            job_id: bundle.artifact.jobId,
            size_bytes: bundle.artifact.sizeBytes,
            sha256: bundle.artifact.sha256,
            mime_type: bundle.artifact.mimeType,
            download_url: downloadUrl,
          }
        : null,
    },
    { status: 200 },
  );
}
