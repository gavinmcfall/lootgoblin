import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const outDir = '.output';
const stagingDir = path.join(outDir, 'firefox-source');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const include = [
  { from: 'src', to: 'src' },
  { from: 'scripts', to: 'scripts' },
  { from: 'package.json', to: 'package.json' },
  { from: '../../package-lock.json', to: 'package-lock.json' },
  { from: 'wxt.config.ts', to: 'wxt.config.ts' },
  { from: 'tsconfig.json', to: 'tsconfig.json' },
  { from: 'BUILD.md', to: 'BUILD.md' },
  { from: 'README.md', to: 'README.md' },
];

for (const { from, to } of include) {
  const dest = path.join(stagingDir, to);
  if (!fs.existsSync(from)) {
    console.warn('skipping missing', from);
    continue;
  }
  fs.cpSync(from, dest, { recursive: true });
}

const outFile = path.join(outDir, `lootgoblin-firefox-source-${pkg.version}.zip`);
const absOut = path.resolve(outFile);
// Run zip from inside staging so paths are relative
execSync(`cd ${stagingDir} && zip -r ${absOut} .`, { stdio: 'inherit' });
console.log('firefox source zip →', outFile);
