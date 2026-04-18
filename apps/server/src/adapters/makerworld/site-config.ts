import type { SiteConfig } from '../../lib/site-configs';

export function mwSiteConfig(): SiteConfig {
  return {
    siteId: 'makerworld',
    interpreterVersion: 1,
    matches: ['*://makerworld.com/*', '*://*.makerworld.com/*'],
    triggers: [
      {
        name: 'modelTile',
        selector: 'a[href*="/en/models/"]',
        extract: {
          modelId: { attr: 'href', regex: '/en/models/(\\d+)-' },
          title: { attr: 'title', text: true },
        },
        inject: {
          button: { template: 'tag-btn-v1', position: 'append', label: 'Tag' },
        },
      },
      {
        name: 'modelPage',
        selector: 'main',
        extract: {
          modelId: {
            selector: 'link[rel="canonical"]',
            attr: 'href',
            regex: '/models/(\\d+)-',
          },
        },
        inject: {
          button: { template: 'tag-btn-v1', position: 'topbar', label: 'Tag this model' },
        },
      },
    ],
  };
}
