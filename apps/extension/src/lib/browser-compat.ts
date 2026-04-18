// WXT injects the `browser` global via webextension-polyfill; this module
// narrows to the specific APIs LootGoblin uses and papers over vendor edges.
//
// IMPORTANT: content scripts have a restricted surface — `browser.tabs`,
// `browser.cookies`, and `browser.alarms` are UNDEFINED in that context.
// Accessing them at module-load time (even just `browser.tabs.onUpdated`)
// throws a `Cannot read properties of undefined` error. We use getters +
// thin wrappers so the expressions are only evaluated when the caller
// actually uses them from a context where the API exists.

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
    query: (q: { active?: boolean; currentWindow?: boolean }) => browser.tabs?.query(q),
    get onUpdated() {
      return browser.tabs?.onUpdated;
    },
  },
  runtime: {
    sendMessage: (m: unknown) => browser.runtime.sendMessage(m),
    get onMessage() {
      return browser.runtime.onMessage;
    },
    get id() {
      return browser.runtime?.id as string | undefined;
    },
  },
  get alarms() {
    return browser.alarms;
  },
};
