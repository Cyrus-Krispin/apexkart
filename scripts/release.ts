// Cut a release: move CHANGELOG.md's "Unreleased" notes under a new version, bump package.json,
// commit, and create an annotated git tag vX.Y.Z on main.
//
//   npm run release -- minor          # or patch / major / an explicit 0.4.0
//   npm run release -- minor --push   # also push main and the tag
//   npm run version:check             # CHANGELOG.md and package.json agree (runs in npm run build)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'https://github.com/Cyrus-Krispin/apexkart';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (msg: string): never => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const released = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
const latest = released[0];

if (process.argv.includes('--check')) {
  if (!latest) fail('CHANGELOG.md has no released version');
  if (pkg.version !== latest) fail(`package.json is ${pkg.version} but CHANGELOG.md's latest release is ${latest}`);
  console.log(`version ${latest} ok`);
  process.exit(0);
}

const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? fail('say which version: patch, minor, major or X.Y.Z');
const [maj, min, pat] = (latest ?? '0.0.0').split('.').map(Number);
const next =
  arg === 'major' ? `${maj + 1}.0.0` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg === 'patch' ? `${maj}.${min}.${pat + 1}` : /^\d+\.\d+\.\d+$/.test(arg) ? arg : fail(`bad version "${arg}"`);
const tag = `v${next}`;

// Releases are cut from an up-to-date, clean main.
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('switch to main first');
if (git('status', '--porcelain')) fail('commit or stash your changes first');
git('fetch', '--quiet', '--tags', 'origin');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in sync with origin/main (pull or push first)');
if (git('tag', '-l', tag)) fail(`tag ${tag} already exists`);
if (released.includes(next)) fail(`${next} is already in CHANGELOG.md`);

const unreleased = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[)/m.exec(changelog);
const notes = unreleased?.[1].trim() ?? '';
if (!notes) fail('nothing under "## [Unreleased]" in CHANGELOG.md: add the new features and fixes first');

const date = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time
let out = changelog.replace(/^## \[Unreleased\]\n[\s\S]*?(?=^## \[)/m, `## [Unreleased]\n\n## [${next}] - ${date}\n\n${notes}\n\n`);
out = out.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${REPO}/compare/${tag}...HEAD\n[${next}]: ${REPO}/compare/v${latest}...${tag}`);
writeFileSync('CHANGELOG.md', out);

pkg.version = next;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
git('commit', '--quiet', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', `ApexKart ${tag}\n\n${notes}`);
console.log(`Released ${tag} (commit ${git('rev-parse', '--short', 'HEAD')}).`);

if (process.argv.includes('--push')) {
  git('push', '--quiet', 'origin', 'main', tag);
  console.log(`Pushed main and ${tag}.`);
} else console.log(`Push when ready:  git push origin main ${tag}`);
