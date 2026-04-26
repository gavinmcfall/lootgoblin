import { describe, it, expect } from 'vitest';
import type { DiscoveryEvent } from '../../src/scavengers/subscribable';

/**
 * Type-shape coverage for the DiscoveryEvent discriminated union.
 *
 * No runtime behavior to exercise — the goal is to catch breaking changes to
 * the discriminator shape at compile time. Each variant is constructed
 * literally and narrowed via the `kind` discriminator.
 */
describe('DiscoveryEvent — discriminated union shape', () => {
  it('item-discovered minimal shape', () => {
    const ev: DiscoveryEvent = {
      kind: 'item-discovered',
      sourceItemId: 'abc',
    };
    if (ev.kind === 'item-discovered') {
      expect(ev.sourceItemId).toBe('abc');
      expect(ev.sourceUrl).toBeUndefined();
      expect(ev.metadataHint).toBeUndefined();
    }
  });

  it('item-discovered with full metadataHint', () => {
    const publishedAt = new Date('2026-01-01T00:00:00Z');
    const ev: DiscoveryEvent = {
      kind: 'item-discovered',
      sourceItemId: 'abc',
      sourceUrl: 'https://example.com/x',
      metadataHint: { title: 'Test', publishedAt },
    };
    if (ev.kind === 'item-discovered') {
      expect(ev.metadataHint?.title).toBe('Test');
      expect(ev.metadataHint?.publishedAt).toBe(publishedAt);
    }
  });

  it('progress shape', () => {
    const ev: DiscoveryEvent = {
      kind: 'progress',
      message: 'fetching page 2',
      itemsSeen: 25,
    };
    if (ev.kind === 'progress') {
      expect(ev.itemsSeen).toBe(25);
    }
  });

  it('rate-limited shape', () => {
    const ev: DiscoveryEvent = {
      kind: 'rate-limited',
      retryAfterMs: 5000,
      attempt: 2,
    };
    if (ev.kind === 'rate-limited') {
      expect(ev.retryAfterMs).toBe(5000);
      expect(ev.attempt).toBe(2);
    }
  });

  it('auth-required reasons', () => {
    const reasons = ['expired', 'revoked', 'missing', 'rate-limited-backoff'] as const;
    for (const reason of reasons) {
      const ev: DiscoveryEvent = {
        kind: 'auth-required',
        reason,
        surfaceToUser: 'Reauthenticate please',
      };
      if (ev.kind === 'auth-required') {
        expect(ev.reason).toBe(reason);
      }
    }
  });

  it('discovery-completed with cursor', () => {
    const ev: DiscoveryEvent = {
      kind: 'discovery-completed',
      cursor: 'page=42&since=2026-01-01',
      itemsTotal: 17,
    };
    if (ev.kind === 'discovery-completed') {
      expect(ev.cursor).toBe('page=42&since=2026-01-01');
      expect(ev.itemsTotal).toBe(17);
    }
  });

  it('discovery-completed without cursor', () => {
    const ev: DiscoveryEvent = {
      kind: 'discovery-completed',
      itemsTotal: 0,
    };
    if (ev.kind === 'discovery-completed') {
      expect(ev.cursor).toBeUndefined();
      expect(ev.itemsTotal).toBe(0);
    }
  });

  it('discovery-failed reasons', () => {
    const reasons = [
      'auth-revoked',
      'rate-limit-exhausted',
      'content-removed',
      'no-results',
      'network-error',
      'unknown',
    ] as const;
    for (const reason of reasons) {
      const ev: DiscoveryEvent = {
        kind: 'discovery-failed',
        reason,
        details: 'something went wrong',
        error: new Error('boom'),
      };
      if (ev.kind === 'discovery-failed') {
        expect(ev.reason).toBe(reason);
        expect(ev.details).toBe('something went wrong');
      }
    }
  });

  it('exhaustive switch over DiscoveryEvent compiles', () => {
    function classify(ev: DiscoveryEvent): string {
      switch (ev.kind) {
        case 'item-discovered':
          return 'item';
        case 'progress':
          return 'progress';
        case 'rate-limited':
          return 'rate-limited';
        case 'auth-required':
          return 'auth';
        case 'discovery-completed':
          return 'completed';
        case 'discovery-failed':
          return 'failed';
      }
    }
    expect(classify({ kind: 'item-discovered', sourceItemId: 'x' })).toBe('item');
    expect(
      classify({ kind: 'discovery-completed', itemsTotal: 0 }),
    ).toBe('completed');
  });
});
