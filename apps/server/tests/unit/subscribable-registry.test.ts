import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../../src/scavengers/registry';
import { logger } from '../../src/logger';
import { hasCapability, dispatchDiscovery } from '../../src/scavengers/subscribable';
import type {
  SubscribableAdapter,
  DiscoveryContext,
  DiscoveryEvent,
} from '../../src/scavengers/subscribable';
import type {
  ScavengerAdapter,
  FetchContext,
  FetchTarget,
  ScavengerEvent,
  SourceId,
} from '../../src/scavengers/types';
import type {
  WatchlistSubscriptionKind,
  WatchlistSubscriptionParameters,
} from '../../src/watchlist/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SubscribableAdapter stub. Each capability method, when
 * provided, is a no-op async generator that completes immediately with
 * `discovery-completed`.
 */
function makeSubscribable(
  id: SourceId,
  capabilities: WatchlistSubscriptionKind[],
  options: {
    omitMethods?: ReadonlySet<WatchlistSubscriptionKind>;
  } = {},
): SubscribableAdapter {
  const omit = options.omitMethods ?? new Set<WatchlistSubscriptionKind>();
  const adapter: SubscribableAdapter = {
    id,
    capabilities: new Set(capabilities),
  };

  // Helper async generator that records the call args then completes.
  function makeGen(label: string) {
    return async function* (
      _ctx: DiscoveryContext,
      arg: string,
    ): AsyncIterable<DiscoveryEvent> {
      yield {
        kind: 'progress',
        message: `${label}:${arg}`,
        itemsSeen: 0,
      };
      yield { kind: 'discovery-completed', itemsTotal: 0 };
    };
  }

  if (capabilities.includes('creator') && !omit.has('creator')) {
    adapter.listCreator = makeGen('creator');
  }
  if (capabilities.includes('tag') && !omit.has('tag')) {
    adapter.searchByTag = makeGen('tag');
  }
  if (capabilities.includes('saved_search') && !omit.has('saved_search')) {
    adapter.search = makeGen('search');
  }
  if (capabilities.includes('folder_watch') && !omit.has('folder_watch')) {
    adapter.enumerateFolder = makeGen('folder');
  }
  if (capabilities.includes('url_watch') && !omit.has('url_watch')) {
    adapter.pollUrl = makeGen('url');
  }

  return adapter;
}

function makeRegularAdapter(id: SourceId): ScavengerAdapter {
  return {
    id,
    supports: () => false,
    fetch(_ctx: FetchContext, _target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return (async function* () {})();
    },
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const baseContext: DiscoveryContext = {
  userId: 'user-1',
};

// ---------------------------------------------------------------------------
// SubscribableAdapter registry tests
// ---------------------------------------------------------------------------

describe('ScavengerRegistry — SubscribableAdapter surface', () => {
  describe('registerSubscribable + getSubscribable', () => {
    it('getSubscribable returns the adapter for a registered id', () => {
      const registry = createRegistry();
      const adapter = makeSubscribable('makerworld', ['creator', 'tag']);
      registry.registerSubscribable(adapter);
      expect(registry.getSubscribable('makerworld')).toBe(adapter);
    });

    it('getSubscribable returns undefined for an unregistered id', () => {
      const registry = createRegistry();
      expect(registry.getSubscribable('non-existent-id' as SourceId)).toBeUndefined();
    });

    it('getSubscribable returns undefined when registry is empty', () => {
      const registry = createRegistry();
      expect(registry.getSubscribable('makerworld')).toBeUndefined();
    });

    it('replaces the existing entry on duplicate registration', () => {
      const registry = createRegistry();
      const first = makeSubscribable('cults3d', ['creator']);
      const second = makeSubscribable('cults3d', ['creator']);
      registry.registerSubscribable(first);
      registry.registerSubscribable(second);
      expect(registry.getSubscribable('cults3d')).toBe(second);
    });

    it('emits a warn log on duplicate subscribable registration', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const registry = createRegistry();
        registry.registerSubscribable(makeSubscribable('cults3d', ['creator']));
        registry.registerSubscribable(makeSubscribable('cults3d', ['tag']));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ sourceId: 'cults3d' }),
          expect.stringMatching(/duplicate subscribable registration/i),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('getSubscribableAdapters', () => {
    it('returns a Map view in registration order', () => {
      const registry = createRegistry();
      registry.registerSubscribable(makeSubscribable('makerworld', ['creator']));
      registry.registerSubscribable(makeSubscribable('printables', ['tag']));
      registry.registerSubscribable(makeSubscribable('cults3d', ['creator', 'tag']));

      const map = registry.getSubscribableAdapters();
      expect(Array.from(map.keys())).toEqual(['makerworld', 'printables', 'cults3d']);
    });

    it('returns an empty Map when nothing is registered', () => {
      const registry = createRegistry();
      const map = registry.getSubscribableAdapters();
      expect(map.size).toBe(0);
    });
  });

  describe('getSubscribableForKind', () => {
    it('returns only adapters that declare and implement the given kind', () => {
      const registry = createRegistry();
      const mw = makeSubscribable('makerworld', ['creator', 'tag']);
      const pr = makeSubscribable('printables', ['tag']);
      const gd = makeSubscribable('google-drive', ['folder_watch']);
      registry.registerSubscribable(mw);
      registry.registerSubscribable(pr);
      registry.registerSubscribable(gd);

      expect(registry.getSubscribableForKind('creator')).toEqual([mw]);
      expect(registry.getSubscribableForKind('tag')).toEqual([mw, pr]);
      expect(registry.getSubscribableForKind('folder_watch')).toEqual([gd]);
      expect(registry.getSubscribableForKind('saved_search')).toEqual([]);
      expect(registry.getSubscribableForKind('url_watch')).toEqual([]);
    });

    it('excludes adapters that declare the capability but lack the method', () => {
      const registry = createRegistry();
      // Declares 'creator' but does NOT implement listCreator — registry must
      // exclude it (belt-and-suspenders).
      const broken = makeSubscribable('makerworld', ['creator'], {
        omitMethods: new Set(['creator']),
      });
      registry.registerSubscribable(broken);

      expect(registry.getSubscribableForKind('creator')).toEqual([]);
    });
  });

  describe('hasCapability helper', () => {
    it('returns true when capability is declared and method is implemented', () => {
      const adapter = makeSubscribable('makerworld', ['creator', 'tag']);
      expect(hasCapability(adapter, 'creator')).toBe(true);
      expect(hasCapability(adapter, 'tag')).toBe(true);
    });

    it('returns false when capability is not declared', () => {
      const adapter = makeSubscribable('makerworld', ['creator']);
      expect(hasCapability(adapter, 'tag')).toBe(false);
      expect(hasCapability(adapter, 'saved_search')).toBe(false);
    });

    it('returns false when capability is declared but method is missing', () => {
      const adapter = makeSubscribable('makerworld', ['creator'], {
        omitMethods: new Set(['creator']),
      });
      expect(hasCapability(adapter, 'creator')).toBe(false);
    });
  });

  describe('dispatchDiscovery', () => {
    it('routes creator → listCreator', async () => {
      const adapter = makeSubscribable('makerworld', ['creator']);
      const params: WatchlistSubscriptionParameters = {
        kind: 'creator',
        creatorId: 'creator-123',
      };
      const events = await collect(
        dispatchDiscovery(adapter, 'creator', baseContext, params),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'progress', message: 'creator:creator-123' }),
      );
      expect(events.at(-1)).toEqual({ kind: 'discovery-completed', itemsTotal: 0 });
    });

    it('routes tag → searchByTag', async () => {
      const adapter = makeSubscribable('makerworld', ['tag']);
      const params: WatchlistSubscriptionParameters = { kind: 'tag', tag: 'minis' };
      const events = await collect(
        dispatchDiscovery(adapter, 'tag', baseContext, params),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'progress', message: 'tag:minis' }),
      );
    });

    it('routes saved_search → search', async () => {
      const adapter = makeSubscribable('makerworld', ['saved_search']);
      const params: WatchlistSubscriptionParameters = {
        kind: 'saved_search',
        query: 'dragon',
      };
      const events = await collect(
        dispatchDiscovery(adapter, 'saved_search', baseContext, params),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'progress', message: 'search:dragon' }),
      );
    });

    it('routes folder_watch → enumerateFolder', async () => {
      const adapter = makeSubscribable('google-drive', ['folder_watch']);
      const params: WatchlistSubscriptionParameters = {
        kind: 'folder_watch',
        folderId: 'folder-abc',
      };
      const events = await collect(
        dispatchDiscovery(adapter, 'folder_watch', baseContext, params),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'progress', message: 'folder:folder-abc' }),
      );
    });

    it('routes url_watch → pollUrl', async () => {
      const adapter = makeSubscribable('makerworld', ['url_watch']);
      const params: WatchlistSubscriptionParameters = {
        kind: 'url_watch',
        url: 'https://example.com/x',
      };
      const events = await collect(
        dispatchDiscovery(adapter, 'url_watch', baseContext, params),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'progress',
          message: 'url:https://example.com/x',
        }),
      );
    });

    it('throws when the adapter does not have the requested capability', () => {
      const adapter = makeSubscribable('makerworld', ['creator']);
      const params: WatchlistSubscriptionParameters = { kind: 'tag', tag: 'minis' };
      expect(() => dispatchDiscovery(adapter, 'tag', baseContext, params)).toThrow(
        /does not implement capability 'tag'/,
      );
    });

    it('throws when the adapter declared but failed to implement the method', () => {
      const adapter = makeSubscribable('makerworld', ['creator'], {
        omitMethods: new Set(['creator']),
      });
      const params: WatchlistSubscriptionParameters = {
        kind: 'creator',
        creatorId: 'c1',
      };
      expect(() =>
        dispatchDiscovery(adapter, 'creator', baseContext, params),
      ).toThrow(/does not implement capability 'creator'/);
    });

    it('throws when kind and params.kind disagree', () => {
      const adapter = makeSubscribable('makerworld', ['creator', 'tag']);
      const params: WatchlistSubscriptionParameters = { kind: 'tag', tag: 'minis' };
      expect(() =>
        dispatchDiscovery(adapter, 'creator', baseContext, params),
      ).toThrow(/kind mismatch/);
    });
  });

  describe('dual-registration with regular ScavengerAdapter', () => {
    it('the same id may live in both registries with independent entries', () => {
      const registry = createRegistry();
      const regular = makeRegularAdapter('makerworld');
      const subscribable = makeSubscribable('makerworld', ['creator']);

      registry.register(regular);
      registry.registerSubscribable(subscribable);

      expect(registry.getById('makerworld')).toBe(regular);
      expect(registry.getSubscribable('makerworld')).toBe(subscribable);
      expect(registry.list()).toEqual(['makerworld']);
      expect(Array.from(registry.getSubscribableAdapters().keys())).toEqual([
        'makerworld',
      ]);
    });

    it('registering a SubscribableAdapter does not populate the regular registry', () => {
      const registry = createRegistry();
      registry.registerSubscribable(makeSubscribable('cults3d', ['creator']));

      expect(registry.getById('cults3d')).toBeNull();
      expect(registry.list()).toEqual([]);
    });

    it('registering a regular ScavengerAdapter does not populate the subscribable registry', () => {
      const registry = createRegistry();
      registry.register(makeRegularAdapter('cults3d'));

      expect(registry.getSubscribable('cults3d')).toBeUndefined();
      expect(registry.getSubscribableAdapters().size).toBe(0);
    });
  });
});
