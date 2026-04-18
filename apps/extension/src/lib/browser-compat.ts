// WXT injects the `browser` global via webextension-polyfill; this module
// narrows to the specific APIs LootGoblin uses and papers over vendor edges.
// Using `browser.*` works on Chrome/Firefox/Edge/Opera.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const browser: any;

export const bc = {
  storage: {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const res = await browser.storage.local.get(key);
      return res[key];
    },
    async set(key: string, value: unknown): Promise<void> {
      await browser.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await browser.storage.local.remove(key);
    },
  },
  cookies: {
    async getAll(filter: { domain: string }) {
      return browser.cookies.getAll(filter);
    },
  },
  tabs: {
    query: (q: { active?: boolean; currentWindow?: boolean }) => browser.tabs.query(q),
    onUpdated: browser.tabs.onUpdated,
  },
  runtime: {
    sendMessage: browser.runtime.sendMessage,
    onMessage: browser.runtime.onMessage,
    id: browser.runtime.id as string,
  },
  alarms: browser.alarms,
};
