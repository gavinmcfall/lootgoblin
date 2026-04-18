import { describe, it, expect } from 'vitest';
import { loadSiteConfigs } from '../../src/lib/site-configs';

describe('site-configs loader', () => {
  it('returns at least the MakerWorld adapter config from code', async () => {
    const configs = await loadSiteConfigs();
    const mw = configs.find((c) => c.siteId === 'makerworld');
    expect(mw).toBeDefined();
    expect(mw!.interpreterVersion).toBe(1);
    expect(mw!.matches.some((m) => m.includes('makerworld.com'))).toBe(true);
    expect(mw!.triggers.length).toBeGreaterThan(0);
  });

  it('skips disk merge when SITE_CONFIGS_DIR missing', async () => {
    process.env.SITE_CONFIGS_DIR = '/does/not/exist';
    const configs = await loadSiteConfigs();
    // Should still return the code-provided configs without throwing
    expect(configs.some((c) => c.siteId === 'makerworld')).toBe(true);
  });
});
