/**
 * Unit tests for ledger _shared.ts — Ledger HTTP Layer Task 1
 *
 * Coverage:
 *   toLedgerEventDto:
 *   1. Happy path — all fields populated → correct DTO with ISO strings
 *   2. Null actorUserId → null in DTO
 *   3. Null occurredAt → null in DTO
 *   4. Null payload → null in DTO
 *   5. Null relatedResources → null in DTO
 *   6. Null provenanceClass → null in DTO
 *   7. Valid JSON payload string → parsed to object in DTO
 *   8. Corrupt non-JSON payload → raw string returned + logger.warn fired
 *
 *   ListQuery Zod schema:
 *   9.  Valid params parse successfully
 *   10. Missing optional fields → default limit=50, others undefined
 *   11. limit > 200 → validation error
 *   12. Unknown key rejected by strict()
 *   13. Malformed ISO datetime for occurred_after → validation error
 *   14. limit coerced from string to number
 *   15. limit=0 rejected by min(1)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toLedgerEventDto, ListQuery } from '../../src/app/api/v1/ledger/_shared';
import { schema } from '../../src/db/client';

// ---------------------------------------------------------------------------
// Logger mock — spy on warn calls without hitting real pino
// ---------------------------------------------------------------------------

vi.mock('../../src/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

// Import after mock is registered
import { logger } from '../../src/logger';

// ---------------------------------------------------------------------------
// Helper: build a minimal ledgerEvents row matching $inferSelect shape
// ---------------------------------------------------------------------------

type LedgerRow = typeof schema.ledgerEvents.$inferSelect;

function makeRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: 'evt-001',
    kind: 'ingest.placed',
    actorUserId: 'user-abc',
    subjectType: 'loot',
    subjectId: 'loot-xyz',
    relatedResources: [{ kind: 'collection', id: 'col-1', role: 'parent' }],
    payload: JSON.stringify({ files: 3, bytes: 1024 }),
    provenanceClass: 'system',
    occurredAt: new Date('2024-03-01T10:00:00.000Z'),
    ingestedAt: new Date('2024-03-01T10:00:05.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toLedgerEventDto tests
// ---------------------------------------------------------------------------

describe('toLedgerEventDto — happy path all fields', () => {
  it('maps all populated fields correctly with ISO timestamps', () => {
    const row = makeRow();
    const dto = toLedgerEventDto(row);

    expect(dto.id).toBe('evt-001');
    expect(dto.kind).toBe('ingest.placed');
    expect(dto.actorUserId).toBe('user-abc');
    expect(dto.subjectType).toBe('loot');
    expect(dto.subjectId).toBe('loot-xyz');
    expect(dto.relatedResources).toEqual([{ kind: 'collection', id: 'col-1', role: 'parent' }]);
    expect(dto.payload).toEqual({ files: 3, bytes: 1024 });
    expect(dto.provenanceClass).toBe('system');
    expect(dto.occurredAt).toBe('2024-03-01T10:00:00.000Z');
    expect(dto.ingestedAt).toBe('2024-03-01T10:00:05.000Z');
  });
});

describe('toLedgerEventDto — null actorUserId', () => {
  it('returns null actorUserId in the DTO', () => {
    const dto = toLedgerEventDto(makeRow({ actorUserId: null }));
    expect(dto.actorUserId).toBeNull();
  });
});

describe('toLedgerEventDto — null occurredAt', () => {
  it('returns null occurredAt in the DTO', () => {
    const dto = toLedgerEventDto(makeRow({ occurredAt: null }));
    expect(dto.occurredAt).toBeNull();
  });
});

describe('toLedgerEventDto — null payload', () => {
  it('returns null payload in the DTO', () => {
    const dto = toLedgerEventDto(makeRow({ payload: null }));
    expect(dto.payload).toBeNull();
  });
});

describe('toLedgerEventDto — null relatedResources', () => {
  it('returns null relatedResources in the DTO', () => {
    const dto = toLedgerEventDto(makeRow({ relatedResources: null }));
    expect(dto.relatedResources).toBeNull();
  });
});

describe('toLedgerEventDto — null provenanceClass', () => {
  it('returns null provenanceClass in the DTO', () => {
    const dto = toLedgerEventDto(makeRow({ provenanceClass: null }));
    expect(dto.provenanceClass).toBeNull();
  });
});

describe('toLedgerEventDto — valid JSON payload', () => {
  it('parses valid JSON payload string to an object', () => {
    const payload = { action: 'retire', reason: 'empty spool' };
    const dto = toLedgerEventDto(makeRow({ payload: JSON.stringify(payload) }));
    expect(dto.payload).toEqual(payload);
  });
});

describe('toLedgerEventDto — corrupt payload fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the raw string and fires logger.warn when payload is not valid JSON', () => {
    const corruptPayload = 'not-json-{';
    const dto = toLedgerEventDto(makeRow({ id: 'evt-bad', payload: corruptPayload }));
    expect(dto.payload).toBe(corruptPayload);
    expect(logger.warn).toHaveBeenCalledOnce();
    // The warn call should include the event id for traceability
    const warnArg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(warnArg).toMatchObject({ id: 'evt-bad' });
  });
});

// ---------------------------------------------------------------------------
// ListQuery Zod schema tests
// ---------------------------------------------------------------------------

describe('ListQuery — valid params parse', () => {
  it('parses a fully-populated valid query object', () => {
    const result = ListQuery.safeParse({
      subject_type: 'loot',
      subject_id: 'loot-123',
      kind: 'ingest.placed',
      actor_user_id: 'user-abc',
      occurred_after: '2024-01-01T00:00:00.000Z',
      occurred_before: '2024-12-31T23:59:59.000Z',
      ingested_after: '2024-01-01T00:00:00.000Z',
      ingested_before: '2024-12-31T23:59:59.000Z',
      limit: '100',
      cursor: 'cursor-opaque-string',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
      expect(result.data.subject_type).toBe('loot');
    }
  });
});

describe('ListQuery — all optional fields omitted', () => {
  it('defaults limit to 50 and leaves other fields undefined', () => {
    const result = ListQuery.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.subject_type).toBeUndefined();
      expect(result.data.kind).toBeUndefined();
    }
  });
});

describe('ListQuery — limit > 200 fails', () => {
  it('rejects limit values above 200', () => {
    const result = ListQuery.safeParse({ limit: '201' });
    expect(result.success).toBe(false);
  });
});

describe('ListQuery — unknown key rejected by strict', () => {
  it('rejects query objects with unknown keys', () => {
    const result = ListQuery.safeParse({ unknown_field: 'foo' });
    expect(result.success).toBe(false);
  });
});

describe('ListQuery — malformed ISO datetime fails', () => {
  it('rejects non-datetime occurred_after', () => {
    const result = ListQuery.safeParse({ occurred_after: 'not-a-date' });
    expect(result.success).toBe(false);
  });
});

describe('ListQuery — limit coerced from string', () => {
  it('coerces a string "25" to number 25', () => {
    const result = ListQuery.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });
});

describe('ListQuery — limit=0 rejected by min(1)', () => {
  it('rejects limit values of 0', () => {
    const result = ListQuery.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });
});
