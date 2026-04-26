/**
 * inbox-triage.ts — Inbox Triage Engine — V2-002-T8
 *
 * Watches a designated inbox directory. For each new file:
 *   1. Stat + SHA-256 (T3).
 *   2. Classify (T6).
 *   3. Evaluate triage rules via the injected ruleMatcher.
 *      The sentinel ownerId '*' queries ALL owners' rules (shared inbox).
 *   4. If a rule matches + confidence passes: auto-apply via T7's applySingleCandidate.
 *   5. Otherwise: insert an inbox_pending_items row for user review.
 *
 * User interactions (via API, future T12):
 *   - listPending(ownerId)         — list items awaiting review.
 *   - confirmPlacement(args)       — move file to a collection, remove pending row.
 *   - dismiss(pendingId, ownerId)  — remove pending row, leave file in inbox.
 *
 * Symlink policy (learning #72): sweep uses lstat + skips isSymbolicLink().
 *
 * Error isolation: provider throws / applier throws are caught per-file.
 * The engine continues processing other files and logs warnings. A file that
 * caused an error lands as a pending item with reason 'rule-error'.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { logger } from '../logger';
import { getDb, schema } from '../db/client';
import { createFileWatcher } from './file-watcher';
import type { FileWatcher } from './file-watcher';
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
import { applySingleCandidate } from './adoption/applier';
import { sha256Hex } from './hash-util';
import type { AdoptionCandidate } from './adoption';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InboxPendingItem = {
  id: string;
  inboxPath: string;
  classification: ClassificationResult;
  hash: string;
  size: number;
  reason: 'low-confidence' | 'no-rule-matched' | 'rule-error';
  detectedAt: Date;
  updatedAt: Date;
};

export type InboxRuleMatch = {
  ruleId: string;
  /** The user who owns this rule — passed through to the applier. */
  ownerId: string;
  collectionId: string;
  mode: 'in-place' | 'copy-then-cleanup';
  minConfidence: number;
};

/**
 * Discriminated union returned by `InboxRuleMatcher.find`.
 *
 * The previous design used `InboxRuleMatch | null` and required a separate
 * `resolveNoMatchReason()` helper that re-queried the rules table to figure
 * out WHY the no-match happened. The discriminated union carries that reason
 * inline, eliminating the side-channel query and making injected test seams
 * able to report an accurate reason without hitting the DB.
 */
export type InboxRuleMatchResult =
  | { kind: 'matched'; match: InboxRuleMatch }
  | { kind: 'no-match'; reason: 'low-confidence' | 'no-rule-matched' };

export interface InboxRuleMatcher {
  /**
   * Evaluates all applicable rules against this file + classification and
   * returns either the winning match or a structured no-match reason.
   *
   * ownerId semantics:
   *   - A specific user ID: only that user's rules are evaluated.
   *   - '*' (sentinel): all owners' rules are evaluated (used by the engine
   *     internally for the shared-inbox auto-apply decision).
   *
   * No-match reason semantics (DB-backed matcher):
   *   - 'low-confidence'  — at least one rule's pattern matched but every
   *                         matching rule's minConfidence gated out.
   *   - 'no-rule-matched' — no rule's pattern matched (regardless of
   *                         confidence).
   *
   * Injected matchers may return either reason. Tests that need to assert
   * the exact 'low-confidence' reason should either use the DB-backed
   * matcher (seed a rule) or explicitly return that reason from their seam.
   */
  find(
    filename: string,
    classification: ClassificationResult,
    ownerId: string,
  ): Promise<InboxRuleMatchResult>;
}

export type InboxApplier = {
  /**
   * Called when a rule matches + confidence is sufficient. Applies a
   * single-file adoption to the rule's target Collection.
   */
  apply(args: {
    inboxPath: string;
    ownerId: string;
    collectionId: string;
    mode: 'in-place' | 'copy-then-cleanup';
    classification: ClassificationResult;
  }): Promise<{ lootId: string; lootFileCount: number } | { error: string }>;
};

export type InboxTriageOptions = {
  /** Absolute path to the inbox directory. */
  inboxPath: string;
  /** Global confidence floor. Rules may set their own higher threshold. */
  defaultConfidenceFloor?: number;       // default 0.75
  /** File watcher debounce window in ms. */
  stabilityThresholdMs?: number;         // default 2000
  /** Injected classifier (default: all T6 rules-based providers). */
  classifier?: Classifier;
  /**
   * Injected rule-matcher (default: queries inbox_triage_rules table).
   * Test seam — inject to bypass the DB-backed rule evaluation.
   */
  ruleMatcher?: InboxRuleMatcher;
  /**
   * Injected applier (default: T7's applySingleCandidate).
   * Test seam — inject to bypass the real FS + DB apply path.
   */
  applier?: InboxApplier;
  /** DATABASE_URL override (used in tests). */
  dbUrl?: string;
};

export interface InboxTriageEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Triage all files currently in the inbox — useful for startup catch-up
   * and tests. Returns aggregate counts.
   */
  sweep(): Promise<{ autoApplied: number; pending: number; errors: number }>;
  /**
   * List pending inbox items. Currently returns ALL items across the shared
   * inbox; the `ownerId` argument is accepted for future-proofing when v3+
   * adds per-user inboxes but has no filtering effect today.
   */
  listPending(ownerId: string): Promise<InboxPendingItem[]>;
  /** User confirms a placement. */
  confirmPlacement(args: {
    pendingId: string;
    ownerId: string;
    collectionId: string;
    mode: 'in-place' | 'copy-then-cleanup';
  }): Promise<{ lootId: string } | { error: string }>;
  /** User dismisses — removes pending row, leaves file in inbox. */
  dismiss(pendingId: string, ownerId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default rule matcher — queries inbox_triage_rules
// ---------------------------------------------------------------------------

type RegexCache = Map<string, RegExp>;

/**
 * Creates the production InboxRuleMatcher backed by the DB.
 *
 * ownerId '*' → queries ALL owners' rules ordered by priority.
 * ownerId (specific) → queries only that owner's rules.
 *
 * The returned InboxRuleMatch carries the rule's ownerId regardless of which
 * variant was used.
 */
function createDbRuleMatcher(dbUrl?: string): InboxRuleMatcher {
  const regexCache: RegexCache = new Map();

  function compilePattern(pattern: string): RegExp {
    let re = regexCache.get(pattern);
    if (!re) {
      try {
        re = new RegExp(pattern);
      } catch {
        re = /(?!)/;
      }
      regexCache.set(pattern, re);
    }
    return re;
  }

  return {
    async find(
      filename: string,
      classification: ClassificationResult,
      ownerId: string,
    ): Promise<InboxRuleMatchResult> {
      const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

      // '*' = all owners; otherwise scope to specific ownerId.
      const rulesQuery = ownerId === '*'
        ? db.select().from(schema.inboxTriageRules).orderBy(schema.inboxTriageRules.priority)
        : db
            .select()
            .from(schema.inboxTriageRules)
            .where(eq(schema.inboxTriageRules.ownerId, ownerId))
            .orderBy(schema.inboxTriageRules.priority);

      const rules = await rulesQuery;

      // Track whether any rule's pattern matched so the no-match reason is
      // accurate (low-confidence vs no-rule-matched) without a second query.
      let sawPatternMatch = false;

      for (const rule of rules) {
        const re = compilePattern(rule.filenamePattern);
        if (!re.test(filename)) continue;

        sawPatternMatch = true;

        // Gate: title confidence must meet rule's minConfidence. Iteration
        // continues because a later (lower-priority) rule with a lower
        // threshold might still fire — priority ordering alone doesn't
        // guarantee the first-matching-pattern rule is the winner.
        const titleConfidence = classification.title?.confidence ?? 0;
        if (titleConfidence < rule.minConfidence) continue;

        return {
          kind: 'matched',
          match: {
            ruleId: rule.id,
            ownerId: rule.ownerId,
            collectionId: rule.collectionId,
            mode: rule.mode as 'in-place' | 'copy-then-cleanup',
            minConfidence: rule.minConfidence,
          },
        };
      }

      return {
        kind: 'no-match',
        reason: sawPatternMatch ? 'low-confidence' : 'no-rule-matched',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default applier — delegates to T7's applySingleCandidate
// ---------------------------------------------------------------------------

function createDefaultApplier(dbUrl?: string): InboxApplier {
  return {
    async apply(args: {
      inboxPath: string;
      ownerId: string;
      collectionId: string;
      mode: 'in-place' | 'copy-then-cleanup';
      classification: ClassificationResult;
    }): Promise<{ lootId: string; lootFileCount: number } | { error: string }> {
      const { inboxPath, collectionId, mode, classification } = args;

      const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

      // Look up the collection to get stashRootId + pathTemplate.
      const colRows = await db
        .select()
        .from(schema.collections)
        .where(eq(schema.collections.id, collectionId));

      const col = colRows[0];
      if (!col) {
        return { error: `Collection "${collectionId}" not found` };
      }

      // Look up the stash root for the absolute path.
      const rootRows = await db
        .select()
        .from(schema.stashRoots)
        .where(eq(schema.stashRoots.id, col.stashRootId));

      const root = rootRows[0];
      if (!root) {
        return { error: `Stash root "${col.stashRootId}" not found` };
      }

      const basename = path.basename(inboxPath);
      let fileStat: { size: number; mtime: Date };
      try {
        const s = await fsp.stat(inboxPath);
        fileStat = { size: s.size, mtime: s.mtime };
      } catch (err) {
        return { error: `Could not stat inbox file: ${(err as Error).message}` };
      }

      const candidate: AdoptionCandidate = {
        id: crypto.randomUUID(),
        folderRelativePath: '',
        files: [
          {
            absolutePath: inboxPath,
            relativePath: basename,
            size: fileStat.size,
            mtime: fileStat.mtime,
          },
        ],
        classification,
      };

      return applySingleCandidate({
        candidate,
        collectionId,
        stashRootPath: root.path,
        pathTemplate: col.pathTemplate,
        mode,
        dbUrl,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// createInboxTriageEngine
// ---------------------------------------------------------------------------

export function createInboxTriageEngine(options: InboxTriageOptions): InboxTriageEngine {
  const {
    inboxPath,
    stabilityThresholdMs = 2000,
    defaultConfidenceFloor = 0.75,
    dbUrl,
  } = options;

  const classifier: Classifier =
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

  const ruleMatcher: InboxRuleMatcher =
    options.ruleMatcher ?? createDbRuleMatcher(dbUrl);

  const applier: InboxApplier =
    options.applier ?? createDefaultApplier(dbUrl);

  let watcher: FileWatcher | null = null;
  let unsubscribe: (() => void) | null = null;

  // ── triageFile ─────────────────────────────────────────────────────────────

  async function triageFile(absolutePath: string): Promise<'auto-applied' | 'pending' | 'error'> {
    // lstat to guard against symlinks (learning #72). Async to keep the event
    // loop free while sweep is walking many files (code review fix #8).
    let lstatResult: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      lstatResult = await fsp.lstat(absolutePath);
    } catch {
      logger.warn({ path: absolutePath }, 'inbox-triage: lstat failed, skipping');
      return 'error';
    }
    if (lstatResult.isSymbolicLink()) {
      logger.debug({ path: absolutePath }, 'inbox-triage: skipping symlink');
      return 'error';
    }
    if (!lstatResult.isFile()) {
      return 'error';
    }

    const basename = path.basename(absolutePath);
    const size = lstatResult.size;

    // Compute hash.
    let hash: string;
    try {
      hash = await sha256Hex(absolutePath);
    } catch (err) {
      logger.warn({ path: absolutePath, err }, 'inbox-triage: hash failed');
      hash = '0000000000000000000000000000000000000000000000000000000000000000';
    }

    // Classify.
    let classification: ClassificationResult;
    try {
      classification = await classifier.classify({
        files: [
          {
            absolutePath,
            relativePath: basename,
            size,
            mtime: lstatResult.mtime,
          },
        ],
        folderRelativePath: '',
      });
    } catch (err) {
      logger.warn({ path: absolutePath, err }, 'inbox-triage: classifier threw');
      classification = { needsUserInput: ['title'] };
    }

    const now = new Date();

    // Global confidence floor — operator safety guardrail below which no
    // auto-apply ever happens, regardless of what any rule's minConfidence
    // says. Skip the rule-matcher call entirely so we never accidentally
    // fire on a under-the-floor classification.
    const titleConfidence = classification.title?.confidence ?? 0;
    let matchReason: 'low-confidence' | 'no-rule-matched' | 'rule-error' = 'no-rule-matched';

    if (titleConfidence < defaultConfidenceFloor) {
      matchReason = 'low-confidence';
    } else {
      // Find the best matching rule across all owners ('*' sentinel).
      // The discriminated union carries the no-match reason inline — no
      // second query needed (code review fix #1).
      let matchResult: InboxRuleMatchResult;
      try {
        matchResult = await ruleMatcher.find(basename, classification, '*');
      } catch (err) {
        logger.warn({ path: absolutePath, err }, 'inbox-triage: ruleMatcher threw');
        matchResult = { kind: 'no-match', reason: 'no-rule-matched' };
      }

      if (matchResult.kind === 'matched') {
        const { match } = matchResult;
        // Auto-apply path.
        try {
          const result = await applier.apply({
            inboxPath: absolutePath,
            ownerId: match.ownerId,
            collectionId: match.collectionId,
            mode: match.mode,
            classification,
          });

          if ('error' in result) {
            logger.warn(
              { path: absolutePath, ruleId: match.ruleId, error: result.error },
              'inbox-triage: applier returned error, creating pending item',
            );
            matchReason = 'rule-error';
          } else {
            logger.info(
              { path: absolutePath, lootId: result.lootId, ruleId: match.ruleId },
              'inbox-triage: auto-applied',
            );
            // Remove any stale pending row for this path.
            const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
            await db
              .delete(schema.inboxPendingItems)
              .where(eq(schema.inboxPendingItems.inboxPath, absolutePath));
            return 'auto-applied';
          }
        } catch (err) {
          logger.warn({ path: absolutePath, err }, 'inbox-triage: applier threw, creating pending item');
          matchReason = 'rule-error';
        }
      } else {
        matchReason = matchResult.reason;
      }
    }

    // Pending insert / upsert.
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const classificationJson = JSON.stringify(classification);

    const existingRows = await db
      .select({ id: schema.inboxPendingItems.id })
      .from(schema.inboxPendingItems)
      .where(eq(schema.inboxPendingItems.inboxPath, absolutePath));

    if (existingRows.length > 0) {
      await db
        .update(schema.inboxPendingItems)
        .set({
          classification: classificationJson,
          hash,
          size,
          reason: matchReason,
          updatedAt: now,
        })
        .where(eq(schema.inboxPendingItems.inboxPath, absolutePath));
    } else {
      await db.insert(schema.inboxPendingItems).values({
        id: crypto.randomUUID(),
        inboxPath: absolutePath,
        classification: classificationJson,
        hash,
        size,
        reason: matchReason,
        detectedAt: now,
        updatedAt: now,
      });
    }

    logger.info({ path: absolutePath, reason: matchReason }, 'inbox-triage: pending item created');
    return 'pending';
  }

  // ── sweep ──────────────────────────────────────────────────────────────────

  async function sweep(): Promise<{ autoApplied: number; pending: number; errors: number }> {
    let autoApplied = 0;
    let pending = 0;
    let errors = 0;

    let entries: string[];
    try {
      entries = await fsp.readdir(inboxPath);
    } catch (err) {
      logger.warn({ inboxPath, err }, 'inbox-triage: sweep readdir failed');
      return { autoApplied: 0, pending: 0, errors: 1 };
    }

    for (const entry of entries) {
      const absolutePath = path.join(inboxPath, entry);

      let stat: Awaited<ReturnType<typeof fsp.lstat>>;
      try {
        stat = await fsp.lstat(absolutePath);
      } catch {
        errors++;
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;

      const outcome = await triageFile(absolutePath);
      if (outcome === 'auto-applied') autoApplied++;
      else if (outcome === 'pending') pending++;
      else errors++;
    }

    logger.info({ inboxPath, autoApplied, pending, errors }, 'inbox-triage: sweep complete');
    return { autoApplied, pending, errors };
  }

  // ── start / stop ───────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (watcher !== null) return;

    await fsp.mkdir(inboxPath, { recursive: true });

    // Start order matters (code review fix #5). Previously: sweep → attach
    // listener → start watcher. That left a blind spot between sweep
    // completion and chokidar acquiring its inode watch — files added in
    // that window were missed entirely. New order: attach watcher FIRST so
    // any file added during the sweep window triggers the add event; the
    // inbox_path UNIQUE upsert handles the dedup if sweep + add race for
    // the same file.
    const fw = createFileWatcher({
      paths: [inboxPath],
      emitInitialAdds: false,
      stabilityThresholdMs,
    });

    unsubscribe = fw.onEvent(async (event) => {
      try {
        if (event.kind === 'add' || event.kind === 'change') {
          await triageFile(event.path);
        } else if (event.kind === 'unlink') {
          const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
          await db
            .delete(schema.inboxPendingItems)
            .where(eq(schema.inboxPendingItems.inboxPath, event.path));
          logger.debug({ path: event.path }, 'inbox-triage: unlink — pending row removed if present');
        } else if (event.kind === 'error') {
          logger.warn({ error: event.error }, 'inbox-triage: watcher error');
        }
        // unlinkDir ignored — inbox is flat.
      } catch (err) {
        logger.warn({ err, event }, 'inbox-triage: event handler threw');
      }
    });

    await fw.start();
    watcher = fw;

    // Catch-up sweep for pre-existing files. Runs AFTER watcher is live so
    // no new file is lost.
    await sweep();

    logger.info({ inboxPath }, 'inbox-triage: engine started');
  }

  async function stop(): Promise<void> {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (watcher !== null) {
      await watcher.stop();
      watcher = null;
    }
    logger.info({ inboxPath }, 'inbox-triage: engine stopped');
  }

  // ── listPending ────────────────────────────────────────────────────────────

  async function listPending(_ownerId: string): Promise<InboxPendingItem[]> {
    // Shared inbox — _ownerId accepted for API consistency (future per-user
    // inbox scoping) but the table has no owner FK today.

    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

    const rows = await db
      .select()
      .from(schema.inboxPendingItems)
      .orderBy(schema.inboxPendingItems.detectedAt);

    return rows.map((row) => {
      // Guard parse (code review fix #3) — corrupt classification JSON
      // shouldn't poison the whole listing. Match confirmPlacement's
      // fallback shape so downstream code stays consistent.
      let classification: ClassificationResult;
      try {
        classification = JSON.parse(row.classification) as ClassificationResult;
      } catch (err) {
        logger.warn(
          { err, pendingId: row.id },
          'listPending: corrupt classification JSON; using fallback',
        );
        classification = { needsUserInput: ['title'] };
      }

      return {
        id: row.id,
        inboxPath: row.inboxPath,
        classification,
        hash: row.hash,
        size: row.size,
        reason: row.reason as 'low-confidence' | 'no-rule-matched' | 'rule-error',
        detectedAt: new Date(row.detectedAt as unknown as number),
        updatedAt: new Date(row.updatedAt as unknown as number),
      };
    });
  }

  // ── confirmPlacement ───────────────────────────────────────────────────────

  async function confirmPlacement(args: {
    pendingId: string;
    ownerId: string;
    collectionId: string;
    mode: 'in-place' | 'copy-then-cleanup';
  }): Promise<{ lootId: string } | { error: string }> {
    const { pendingId, ownerId, collectionId, mode } = args;
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

    const rows = await db
      .select()
      .from(schema.inboxPendingItems)
      .where(eq(schema.inboxPendingItems.id, pendingId));

    const row = rows[0];
    if (!row) {
      return { error: `Pending item "${pendingId}" not found` };
    }

    let classification: ClassificationResult;
    try {
      classification = JSON.parse(row.classification) as ClassificationResult;
    } catch {
      classification = { needsUserInput: ['title'] };
    }

    const result = await applier.apply({
      inboxPath: row.inboxPath,
      ownerId,
      collectionId,
      mode,
      classification,
    });

    if ('error' in result) {
      return { error: result.error };
    }

    await db
      .delete(schema.inboxPendingItems)
      .where(eq(schema.inboxPendingItems.id, pendingId));

    return { lootId: result.lootId };
  }

  // ── dismiss ────────────────────────────────────────────────────────────────

  async function dismiss(pendingId: string, _ownerId: string): Promise<void> {
    // Shared inbox — _ownerId accepted for API consistency.
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db
      .delete(schema.inboxPendingItems)
      .where(eq(schema.inboxPendingItems.id, pendingId));
  }

  return { start, stop, sweep, listPending, confirmPlacement, dismiss };
}
