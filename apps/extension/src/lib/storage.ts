import { bc } from './browser-compat';

export interface PairedState {
  serverUrl: string;
  apiKey: string;
  pairedAt: number;
}

export interface CachedSiteConfigs {
  configs: unknown[];
  fetchedAt: number;
}

export const Storage = {
  getPairing: () => bc.storage.get<PairedState>('pairing'),
  setPairing: (p: PairedState) => bc.storage.set('pairing', p),
  clearPairing: () => bc.storage.remove('pairing'),
  getSiteConfigs: () => bc.storage.get<CachedSiteConfigs>('siteConfigs'),
  setSiteConfigs: (v: CachedSiteConfigs) => bc.storage.set('siteConfigs', v),
};
