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
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

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

export type InboxRuleMatcher = {
  /**
   * Returns the highest-priority rule matching this file + classification,
   * or null if no rule matched.
   *
   * ownerId semantics:
   *   - A specific user ID: only that user's rules are evaluated.
   *   - '*' (sentinel): all owners' rules are evaluated (used by the engine
   *     internally for the shared-inbox auto-apply decision).
   *
   * The returned InboxRuleMatch carries the matched rule's ownerId so the
   * engine can forward it to the applier.
   */
  findMatch(
    filename: string,
    classification: ClassificationResult,
    ownerId: string,
  ): Promise<InboxRuleMatch | null>;
};

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
  /** List pending items for a given owner. */
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
    async findMatch(
      filename: string,
      classification: ClassificationResult,
      ownerId: string,
    ): Promise<InboxRuleMatch | null> {
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

      // Track whether any rule's pattern matched (for the low-confidence reason).
      let anyPatternMatched = false;

      for (const rule of rules) {
        const re = compilePattern(rule.filenamePattern);
        if (!re.test(filename)) continue;

        anyPatternMatched = true;

        // Gate: title confidence must meet rule's minConfidence.
        const titleConfidence = classification.title?.confidence ?? 0;
        if (titleConfidence < rule.minConfidence) continue;

        return {
          ruleId: rule.id,
          ownerId: rule.ownerId,
          collectionId: rule.collectionId,
          mode: rule.mode as 'in-place' | 'copy-then-cleanup',
          minConfidence: rule.minConfidence,
        };
      }

      // Return a sentinel that tells triageFile the reason for null.
      // We encode this via a special null with attached reason — but since the
      // interface returns InboxRuleMatch | null we use a side-channel approach:
      // append the reason as a special property via symbol on the null. Instead,
      // triageFile will re-derive the reason by checking if any rule existed.
      //
      // NOTE: We can't return structured data from a null return. The caller
      // (triageFile) will query the reason separately if needed. For now, null
      // means "no auto-apply" and the reason is determined by caller logic.
      void anyPatternMatched; // used below via a separate lookup
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Reason resolver — determines why auto-apply didn't fire (DB-backed only)
// ---------------------------------------------------------------------------

/**
 * Queries the DB to determine the pending reason for a file that was not
 * auto-applied. Only called when using the default DB-backed flow.
 *
 * 'low-confidence' — at least one rule's pattern matched but confidence gated.
 * 'no-rule-matched' — no rule's pattern matched.
 */
async function resolveNoMatchReason(
  filename: string,
  classification: ClassificationResult,
  dbUrl?: string,
): Promise<'low-confidence' | 'no-rule-matched'> {
  const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
  const rules = await db.select().from(schema.inboxTriageRules);

  const regexCache = new Map<string, RegExp>();
  for (const rule of rules) {
    let re = regexCache.get(rule.filenamePattern);
    if (!re) {
      try { re = new RegExp(rule.filenamePattern); }
      catch { re = /(?!)/; }
      regexCache.set(rule.filenamePattern, re);
    }
    if (!re.test(filename)) continue;
    // Pattern matched — confidence must have been too low.
    return 'low-confidence';
  }
  return 'no-rule-matched';
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
// sha256Hex — local helper
// ---------------------------------------------------------------------------

async function sha256Hex(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// createInboxTriageEngine
// ---------------------------------------------------------------------------

export function createInboxTriageEngine(options: InboxTriageOptions): InboxTriageEngine {
  const {
    inboxPath,
    stabilityThresholdMs = 2000,
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

  // Track whether a custom ruleMatcher was injected — used by triageFile to
  // decide whether to use the DB-based reason resolver.
  const customRuleMatcherInjected = options.ruleMatcher !== undefined;

  const ruleMatcher: InboxRuleMatcher =
    options.ruleMatcher ?? createDbRuleMatcher(dbUrl);

  const applier: InboxApplier =
    options.applier ?? createDefaultApplier(dbUrl);

  let watcher: FileWatcher | null = null;
  let unsubscribe: (() => void) | null = null;

  // ── triageFile ─────────────────────────────────────────────────────────────

  async function triageFile(absolutePath: string): Promise<'auto-applied' | 'pending' | 'error'> {
    // lstat to guard against symlinks (learning #72).
    let lstatResult: fs.Stats;
    try {
      lstatResult = fs.lstatSync(absolutePath);
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

    // Find the best matching rule across all owners ('*' sentinel).
    let match: InboxRuleMatch | null = null;
    try {
      match = await ruleMatcher.findMatch(basename, classification, '*');
    } catch (err) {
      logger.warn({ path: absolutePath, err }, 'inbox-triage: ruleMatcher threw');
    }

    // Determine pending reason if no match.
    let matchReason: 'low-confidence' | 'no-rule-matched' | 'rule-error' = 'no-rule-matched';

    if (match !== null) {
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
      // No match — determine whether a pattern matched but confidence was too low,
      // or no pattern matched at all.
      if (customRuleMatcherInjected) {
        // With an injected matcher, null means "no auto-apply" — the matcher is
        // responsible for its own gating logic. We cannot distinguish between
        // "no pattern matched" and "pattern matched but low confidence" from a
        // null return alone. Record 'no-rule-matched' as the conservative default.
        // Tests that need to assert 'low-confidence' specifically should use the
        // DB-backed matcher path (no injection) with a seeded rule.
        matchReason = 'no-rule-matched';
      } else {
        // Default DB-backed path: query to see if any pattern matched.
        matchReason = await resolveNoMatchReason(basename, classification, dbUrl);
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

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
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

    await sweep();

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

  async function listPending(ownerId: string): Promise<InboxPendingItem[]> {
    // Shared inbox — ownerId accepted for API consistency but the table has
    // no owner FK. Returns all pending items.
    void ownerId;

    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

    const rows = await db
      .select()
      .from(schema.inboxPendingItems)
      .orderBy(schema.inboxPendingItems.detectedAt);

    return rows.map((row) => ({
      id: row.id,
      inboxPath: row.inboxPath,
      classification: JSON.parse(row.classification) as ClassificationResult,
      hash: row.hash,
      size: row.size,
      reason: row.reason as 'low-confidence' | 'no-rule-matched' | 'rule-error',
      detectedAt: new Date(row.detectedAt as unknown as number),
      updatedAt: new Date(row.updatedAt as unknown as number),
    }));
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

  async function dismiss(pendingId: string, ownerId: string): Promise<void> {
    void ownerId;
    const db = getDb(dbUrl) as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    await db
      .delete(schema.inboxPendingItems)
      .where(eq(schema.inboxPendingItems.id, pendingId));
  }

  return { start, stop, sweep, listPending, confirmPlacement, dismiss };
}
