import { defineContentScript } from 'wxt/utils/define-content-script';
import { getSiteConfigs, findMatchingConfig } from '@/lib/site-configs';
import { runInterpreter } from '@/interpreter';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    const configs = await getSiteConfigs();
    const match = findMatchingConfig(location.href, configs);
    if (!match) return;
    runInterpreter(match);
  },
});
