import fs from 'node:fs';
import path from 'node:path';

const map = {
  'chrome-mv3': 'lootgoblin-chrome',
  'firefox-mv2': 'lootgoblin-firefox',
  'edge-mv3': 'lootgoblin-edge',
};
const outDir = '.output';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

for (const [dir, prefix] of Object.entries(map)) {
  const zipPath = path.join(outDir, dir + '.zip');
  if (!fs.existsSync(zipPath)) continue;
  const target = path.join(outDir, `${prefix}-${pkg.version}.zip`);
  fs.renameSync(zipPath, target);
  console.log('renamed', zipPath, '→', target);
}
