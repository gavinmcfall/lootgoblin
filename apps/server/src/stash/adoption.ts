/**
 * adoption.ts — Library Adoption orchestrator — V2-002-T7
 *
 * Given a stash root containing an already-organized filesystem (Manyfold-style,
 * or any ad-hoc layout):
 *   1. Scan: walk the filesystem to discover files.
 *   2. Group: group files into candidate Loot records via heuristics.
 *   3. Classify: run T6 Classifier on each candidate.
 *   4. Derive templates: observe folder patterns + offer starter templates.
 *   5. Preview: build TemplateOption[] with collision/incompatible/example data.
 *   6. Apply: insert Collection + loot + lootFiles rows (in-place OR copy-then-cleanup).
 *
 * This is distinct from T5 Reconciliation:
 *   T5 = automatic drift detection against already-tracked files.
 *   T7 = user-triggered bulk adoption of a previously-untracked library.
 */

import * as crypto from 'node:crypto';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { eq } from 'drizzle-orm';

import {
  createClassifier,
  type Classifier,
  type ClassificationResult,
} from './classifier';
import {
  createThreeMfProvider,
  createDatapackageProvider,
  createFilenameProvider,
  createFolderPatternProvider,
  createExifProvider,
} from './classifier-providers';

import { walkStashRoot } from './adoption/walker';
import { groupFilesIntoCandidates } from './adoption/grouping';
import { deriveTemplates } from './adoption/template-deriver';
import { buildTemplateOptions } from './adoption/preview';
import { applyAdoptionPlan } from './adoption/applier';

// ---------------------------------------------------------------------------
// Re-export sub-module types for convenience
// ---------------------------------------------------------------------------

export type { WalkedFile } from './adoption/walker';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdoptionCandidate = {
  /** Stable ID for this candidate within the proposal. */
  id: string;
  /** Primary folder (relative to stash root) this candidate lives in. */
  folderRelativePath: string;
  /** Files belonging to this candidate. */
  files: Array<{
    absolutePath: string;
    relativePath: string; // relative to stash root, forward-slash
    size: number;
    mtime: Date;
  }>;
  /** What the T6 Classifier inferred. */
  classification: ClassificationResult;
};

export type TemplateOption = {
  template: string;
  /** How many of the proposal's candidates this template would successfully resolve. */
  predictedLootCount: number;
  /** Candidates that would collide on the resolved path. */
  collisions: Array<{
    proposedPath: string;
    candidateIds: string[];
  }>;
  /** Candidates that cannot resolve because required fields are missing or template is incompatible. */
  incompatible: Array<{
    candidateId: string;
    reason:
      | 'missing-field'
      | 'forbidden-character'
      | 'reserved-name'
      | 'path-too-long'
      | 'segment-too-long'
      | 'empty-segment'
      | 'unknown-transform';
  }>;
  /** Up to 5 example "before → after" mappings for the user. */
  examples: Array<{ candidateId: string; currentPath: string; proposedPath: string }>;
};

export type AdoptionProposal = {
  stashRootId: string;
  candidates: AdoptionCandidate[];
  /** Templates derived from observed folder patterns + starter templates. Sorted by predictedLootCount desc. */
  templateOptions: TemplateOption[];
  /** True if NO detectable pattern emerged from the candidate folder structure. */
  noPatternDetected: boolean;
};

export type AdoptionPlan = {
  stashRootId: string;
  chosenTemplate: string;
  mode: 'in-place' | 'copy-then-cleanup';
  /** Subset of proposal.candidates to actually adopt. */
  candidateIds: string[];
  /**
   * Optional name for the Collection created by this adoption run.
   * Defaults to `Adopted: <stashRoot basename> — <ISO timestamp>`.
   */
  collectionName?: string;
  /**
   * User-supplied field values for candidates with needsUserInput entries.
   * Map: candidateId → { fieldName: userValue }.
   */
  confirmFieldsUserSupplied?: Record<string, Record<string, string>>;
};

export type AdoptionReport = {
  stashRootId: string;
  appliedAt: Date;
  mode: 'in-place' | 'copy-then-cleanup';
  chosenTemplate: string;
  lootsCreated: number;
  lootFilesCreated: number;
  skippedCandidates: Array<{ candidateId: string; reason: string }>;
  errors: Array<{ candidateId: string; error: string }>;
};

// ---------------------------------------------------------------------------
// Default starter templates
// ---------------------------------------------------------------------------

export const ADOPTION_STARTER_TEMPLATES = [
  '{creator|slug}/{title|slug}',
  '{title|slug}',
  'by-creator/{creator|slug}/{title|slug}',
];

// ---------------------------------------------------------------------------
// AdoptionEngine interface
// ---------------------------------------------------------------------------

export interface AdoptionEngine {
  scan(stashRootId: string): Promise<AdoptionProposal>;
  apply(plan: AdoptionPlan): Promise<AdoptionReport>;
}

export type AdoptionEngineOptions = {
  /** Classifier from T6. Defaults to a fresh instance with all rules-based providers. */
  classifier?: Classifier;
  /** Starter templates to offer when no pattern is detected. */
  starterTemplates?: string[];
  /** DATABASE_URL override (used in tests). */
  dbUrl?: string;
};

// ---------------------------------------------------------------------------
// createAdoptionEngine
// ---------------------------------------------------------------------------

/**
 * Creates an AdoptionEngine with the given options.
 *
 * The engine lazily resolves the stash root from the DB on each call.
 * It does NOT subscribe to the reconciler — adoption is a one-shot operation.
 */
export function createAdoptionEngine(options: AdoptionEngineOptions = {}): AdoptionEngine {
  const classifier =
    options.classifier ??
    createClassifier({
      providers: [
        createThreeMfProvider(),
        createDatapackageProvider(),
        createFilenameProvider(),
        createFolderPatternProvider(),
        createExifProvider(),
      ],
    });

  const starterTemplates = options.starterTemplates ?? ADOPTION_STARTER_TEMPLATES;
  const dbUrl = options.dbUrl;

  return {
    // ── scan ─────────────────────────────────────────────────────────────────
    async scan(stashRootId: string): Promise<AdoptionProposal> {
      const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

      // Look up the stash root.
      const rows = await db
        .select()
        .from(schema.stashRoots)
        .where(eq(schema.stashRoots.id, stashRootId));

      const stashRoot = rows[0];
      if (!stashRoot) {
        throw new Error(`Stash root "${stashRootId}" not found`);
      }

      logger.info({ stashRootId, path: stashRoot.path }, 'adoption: scanning stash root');

      // Walk the filesystem.
      const walkedFiles = await walkStashRoot(stashRoot.path);

      logger.info(
        { stashRootId, fileCount: walkedFiles.length },
        'adoption: walk complete',
      );

      // Group files into pre-classification candidates.
      const preClassCandidates = groupFilesIntoCandidates(walkedFiles);

      // Classify each candidate.
      const classifiedCandidates: AdoptionCandidate[] = [];
      await Promise.allSettled(
        preClassCandidates.map(async (preCand) => {
          // Use a deterministic ID based on folderRelativePath so that the same
          // filesystem layout produces the same IDs across scan and apply.
          // This allows AdoptionPlan.candidateIds (captured at scan time) to
          // still reference the correct candidates when apply() re-scans.
          const id = deterministicId(stashRootId, preCand.folderRelativePath);
          let classification: ClassificationResult;

          try {
            classification = await classifier.classify({
              files: preCand.files,
              folderRelativePath: preCand.folderRelativePath,
            });
          } catch (err) {
            logger.warn(
              { err, folder: preCand.folderRelativePath },
              'adoption: classifier threw for candidate; using empty classification',
            );
            classification = { needsUserInput: ['title'] };
          }

          classifiedCandidates.push({
            id,
            folderRelativePath: preCand.folderRelativePath,
            files: preCand.files,
            classification,
          });
        }),
      );

      // Derive templates from observed patterns.
      const { templates: derivedTemplates, patternDetected } =
        deriveTemplates(classifiedCandidates);

      // Build final template list: derived first, then starters (deduped).
      const allTemplates = [...derivedTemplates];
      for (const t of starterTemplates) {
        if (!allTemplates.includes(t)) {
          allTemplates.push(t);
        }
      }

      // Build TemplateOption[] (sorted by predictedLootCount desc).
      const templateOptions = buildTemplateOptions(allTemplates, classifiedCandidates);

      logger.info(
        {
          stashRootId,
          candidateCount: classifiedCandidates.length,
          patternDetected,
          templateCount: templateOptions.length,
        },
        'adoption: scan complete',
      );

      return {
        stashRootId,
        candidates: classifiedCandidates,
        templateOptions,
        noPatternDetected: !patternDetected,
      };
    },

    // ── apply ─────────────────────────────────────────────────────────────────
    async apply(plan: AdoptionPlan): Promise<AdoptionReport> {
      const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

      // Look up the stash root.
      const rows = await db
        .select()
        .from(schema.stashRoots)
        .where(eq(schema.stashRoots.id, plan.stashRootId));

      const stashRoot = rows[0];
      if (!stashRoot) {
        throw new Error(`Stash root "${plan.stashRootId}" not found`);
      }

      // Re-scan to get fresh candidates. In the apply path, the engine does NOT
      // cache proposal state — it re-scans to ensure the FS matches what was
      // previewed. This is intentional: if the user took a long time between
      // scan and apply, we want to use current state.
      const proposal = await this.scan(plan.stashRootId);

      logger.info(
        { stashRootId: plan.stashRootId, mode: plan.mode, candidateCount: plan.candidateIds.length },
        'adoption: applying plan',
      );

      return applyAdoptionPlan(
        plan,
        proposal.candidates,
        stashRoot.path,
        stashRoot.ownerId,
        dbUrl,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Produces a deterministic candidate ID based on the stash root ID and the
 * candidate's folder relative path. Using a deterministic ID means that the
 * same filesystem layout always produces the same candidate IDs, so that
 * candidateIds captured during scan() remain valid when apply() re-scans.
 *
 * Format: SHA-256( stashRootId + '\0' + folderRelativePath )[0..35] formatted
 * as a UUID v4 lookalike (8-4-4-4-12 with fixed version/variant bits stripped
 * — just enough for unique display; not a real UUID random variant).
 */
function deterministicId(stashRootId: string, folderRelativePath: string): string {
  const input = `${stashRootId}\0${folderRelativePath}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  // Format as UUID-like string: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}
