import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../../src/scavengers/registry';
import { logger } from '../../src/logger';
import type { ScavengerAdapter, FetchContext, FetchTarget, ScavengerEvent, SourceId } from '../../src/scavengers/types';

// ---------------------------------------------------------------------------
// Test helpers — minimal adapter stubs
// ---------------------------------------------------------------------------

function makeAdapter(
  id: SourceId,
  supportsFn: (url: string) => boolean = () => false,
): ScavengerAdapter {
  return {
    id,
    supports: supportsFn,
    fetch(_ctx: FetchContext, _target: FetchTarget): AsyncIterable<ScavengerEvent> {
      // Stub — not exercised in these unit tests
      return (async function* () {})();
    },
  };
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('ScavengerRegistry', () => {
  describe('empty registry', () => {
    it('resolveUrl returns null when no adapters are registered', () => {
      const registry = createRegistry();
      expect(registry.resolveUrl('https://cults3d.com/en/3d-model/foo')).toBeNull();
    });

    it('list returns empty array when no adapters are registered', () => {
      const registry = createRegistry();
      expect(registry.list()).toEqual([]);
    });

    it('getById returns null when no adapters are registered', () => {
      const registry = createRegistry();
      expect(registry.getById('makerworld')).toBeNull();
    });
  });

  describe('single adapter registration', () => {
    it('resolveUrl returns the adapter for a matching URL', () => {
      const registry = createRegistry();
      const adapter = makeAdapter('makerworld', (url) => url.includes('makerworld.com'));
      registry.register(adapter);
      const result = registry.resolveUrl('https://makerworld.com/en/models/12345');
      expect(result).toBe(adapter);
    });

    it('resolveUrl returns null for a non-matching URL', () => {
      const registry = createRegistry();
      const adapter = makeAdapter('makerworld', (url) => url.includes('makerworld.com'));
      registry.register(adapter);
      expect(registry.resolveUrl('https://printables.com/model/99')).toBeNull();
    });

    it('getById returns the adapter by its id', () => {
      const registry = createRegistry();
      const adapter = makeAdapter('cults3d', () => false);
      registry.register(adapter);
      expect(registry.getById('cults3d')).toBe(adapter);
    });

    it('getById returns null for an unregistered id', () => {
      const registry = createRegistry();
      const adapter = makeAdapter('cults3d', () => false);
      registry.register(adapter);
      expect(registry.getById('printables')).toBeNull();
    });

    it('list returns the single registered id', () => {
      const registry = createRegistry();
      registry.register(makeAdapter('sketchfab', () => false));
      expect(registry.list()).toEqual(['sketchfab']);
    });
  });

  describe('two adapters with disjoint URL support', () => {
    it('resolveUrl routes makerworld URL to makerworld adapter', () => {
      const registry = createRegistry();
      const mw = makeAdapter('makerworld', (url) => url.includes('makerworld.com'));
      const pr = makeAdapter('printables', (url) => url.includes('printables.com'));
      registry.register(mw);
      registry.register(pr);

      expect(registry.resolveUrl('https://makerworld.com/en/models/1')).toBe(mw);
    });

    it('resolveUrl routes printables URL to printables adapter', () => {
      const registry = createRegistry();
      const mw = makeAdapter('makerworld', (url) => url.includes('makerworld.com'));
      const pr = makeAdapter('printables', (url) => url.includes('printables.com'));
      registry.register(mw);
      registry.register(pr);

      expect(registry.resolveUrl('https://printables.com/model/99')).toBe(pr);
    });

    it('resolveUrl returns null for a URL neither adapter claims', () => {
      const registry = createRegistry();
      registry.register(makeAdapter('makerworld', (url) => url.includes('makerworld.com')));
      registry.register(makeAdapter('printables', (url) => url.includes('printables.com')));

      expect(registry.resolveUrl('https://cults3d.com/en/3d-model/foo')).toBeNull();
    });
  });

  describe('two adapters both claiming the same URL', () => {
    it('returns the first-registered adapter (first-wins)', () => {
      const registry = createRegistry();
      const first = makeAdapter('makerworld', () => true); // claims everything
      const second = makeAdapter('printables', () => true); // also claims everything
      registry.register(first);
      registry.register(second);

      const result = registry.resolveUrl('https://any.example.com/item/1');
      expect(result).toBe(first);
    });

    it('emits a warn log when two adapters both claim the URL', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const registry = createRegistry();
        registry.register(makeAdapter('cults3d', () => true));
        registry.register(makeAdapter('thingiverse', () => true));

        registry.resolveUrl('https://whatever.example/');

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'https://whatever.example/',
            firstId: 'cults3d',
            secondId: 'thingiverse',
          }),
          expect.stringMatching(/multiple adapters/i),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does NOT emit a warn log when only one adapter matches', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const registry = createRegistry();
        registry.register(makeAdapter('cults3d', (url) => url.includes('cults3d.com')));
        registry.register(makeAdapter('thingiverse', (url) => url.includes('thingiverse.com')));

        registry.resolveUrl('https://cults3d.com/3d-model/1');

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('duplicate registration (same id)', () => {
    it('replaces the existing adapter when the same id is registered twice', () => {
      const registry = createRegistry();
      const first = makeAdapter('upload', (url) => url.startsWith('upload://'));
      const second = makeAdapter('upload', (url) => url.startsWith('upload://'));
      registry.register(first);
      registry.register(second);

      // getById should return the second (replacement) adapter
      expect(registry.getById('upload')).toBe(second);
    });

    it('list still contains the id only once after duplicate registration', () => {
      const registry = createRegistry();
      registry.register(makeAdapter('google-drive', () => false));
      registry.register(makeAdapter('google-drive', () => false));

      expect(registry.list()).toEqual(['google-drive']);
      expect(registry.list()).toHaveLength(1);
    });
  });

  describe('list order', () => {
    it('list returns ids in registration order', () => {
      const registry = createRegistry();
      registry.register(makeAdapter('upload', () => false));
      registry.register(makeAdapter('makerworld', () => false));
      registry.register(makeAdapter('printables', () => false));
      registry.register(makeAdapter('cults3d', () => false));

      expect(registry.list()).toEqual(['upload', 'makerworld', 'printables', 'cults3d']);
    });

    it('duplicate registration preserves original insertion position', () => {
      const registry = createRegistry();
      registry.register(makeAdapter('upload', () => false));
      registry.register(makeAdapter('makerworld', () => false));
      // Re-register 'upload' — it was first; after replacement it should still be first
      // because Map.set preserves key insertion order for existing keys.
      registry.register(makeAdapter('upload', () => false));

      expect(registry.list()).toEqual(['upload', 'makerworld']);
    });
  });
});
