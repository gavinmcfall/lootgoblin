import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'LootGoblin',
    description: 'Tag models, posts, files — LootGoblin scrapes + archives them to your library.',
    permissions: ['storage', 'cookies', 'tabs', 'alarms'],
    host_permissions: [
      'http://*/*',
      'https://*/*',
    ],
    action: { default_title: 'LootGoblin' },
    browser_specific_settings: {
      gecko: {
        id: 'lootgoblin@nerdz.cloud',
        strict_min_version: '128.0',
        ...({ data_collection_permissions: {
          required: [
            'personallyIdentifyingInfo',
            'authenticationInfo',
            'websiteContent',
          ],
          optional: [],
        }} as Record<string, unknown>),
      },
    },
  },
});
