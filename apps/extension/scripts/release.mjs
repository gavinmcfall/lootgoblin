import fs from 'node:fs';
import { execSync } from 'node:child_process';

const bump = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('usage: release.mjs patch|minor|major');
  process.exit(1);
}

// 1. Bump version
execSync(`npm version ${bump} --no-git-tag-version`, { stdio: 'inherit' });
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

// 2. Build + zip all browser targets + firefox source
execSync('npm run zip:all', { stdio: 'inherit' });

// 3. Emit SHA256SUMS
const outDir = '.output';
const zips = fs.readdirSync(outDir).filter((f) => f.endsWith('.zip'));
const checksums = [];
for (const z of zips) {
  const hash = execSync(`sha256sum ${outDir}/${z}`).toString().trim();
  checksums.push(hash);
}
fs.writeFileSync(`${outDir}/SHA256SUMS`, checksums.join('\n') + '\n');
console.log('wrote SHA256SUMS');

// 4. Git commit + tag
execSync('git add package.json package-lock.json', { stdio: 'inherit' });
execSync(`git commit -m "chore(extension): release v${version}"`, { stdio: 'inherit' });
execSync(`git tag extension-v${version}`, { stdio: 'inherit' });
console.log(`\nExtension v${version} built.`);
console.log(`Artifacts in ${outDir}/. Push tag to trigger CI release: git push --tags`);
