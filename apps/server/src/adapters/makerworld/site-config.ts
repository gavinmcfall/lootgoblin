import type { SiteConfig } from '../../lib/site-configs';

export function mwSiteConfig(): SiteConfig {
  return {
    siteId: 'makerworld',
    interpreterVersion: 1,
    matches: ['*://makerworld.com/*', '*://*.makerworld.com/*'],
    triggers: [
      // Listing-page card: one button per card container, bottom-right.
      // The `.is-new-version` class wraps each card body (per user inspection
      // of MakerWorld DOM). URL-gated to listing/search/profile pages only so
      // it doesn't fire on the detail page.
      {
        name: 'modelTile',
        selector: '.is-new-version',
        urlMatch: [
          '*://makerworld.com/en/3d-models*',
          '*://makerworld.com/en/search/*',
          '*://makerworld.com/en/@*',
          '*://makerworld.com/en',
          '*://makerworld.com/en/',
        ],
        extract: {
          modelId: {
            selector: 'a[href*="/en/models/"]',
            attr: 'href',
            regex: '/en/models/(\\d+)-',
          },
          title: {
            selector: 'a[href*="/en/models/"]',
            attr: 'title',
          },
          thumbnail: {
            selector: 'img',
            attr: 'src',
          },
        },
        inject: {
          button: { template: 'tag-btn-v1', position: 'append', label: 'Tag' },
        },
      },
      // Detail page: fixed-position floating button in the top-right corner of
      // the viewport. URL-gated to /en/models/<id>-<slug> paths. Injects on
      // body via position:'topbar' so it's stable across scroll / SPA nav.
      {
        name: 'modelPage',
        selector: 'body',
        urlMatch: ['*://makerworld.com/en/models/*'],
        extract: {
          modelId: {
            selector: 'link[rel="canonical"]',
            attr: 'href',
            regex: '/models/(\\d+)-',
          },
          title: {
            selector: 'h1',
            text: true,
          },
        },
        inject: {
          button: { template: 'tag-btn-floating', position: 'topbar', label: 'Tag this model' },
        },
      },
    ],
  };
}
