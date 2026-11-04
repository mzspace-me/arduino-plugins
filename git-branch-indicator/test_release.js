'use strict';

// Checks release.ps1 end to end without touching GitHub: each test copies the
// plugin into a throwaway repository whose origin is a local bare repository,
// and puts a stand-in `gh` first on PATH that records its arguments. Windows
// only, like the script (needs Windows PowerShell and git).
//
//   node git-branch-indicator/test_release.js

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN = path.basename(__dirname);
const PLUGIN_FILES = [
  'package.json',
  'extension.js',
  'README.md',
  'CHANGELOG.md',
  'icon.png',
  'build_vsix.ps1',
  'release.ps1',
];
const { version, name: packageName } = require('./package.json');
const TAG = `${PLUGIN}-v${version}`;
const GH_REPO = 'owner/arduino-plugins';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// A `gh` that answers the calls release.ps1 makes and logs each one as a JSON
// line. FAKE_GH_AUTH=fail makes `gh auth status` report signed out.
const fakeGhDir = tempDir('arduino-release-fake-gh-');
fs.writeFileSync(path.join(fakeGhDir, 'fake_gh.js'), `
const args = process.argv.slice(2);
require('fs').appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'auth') process.exit(process.env.FAKE_GH_AUTH === 'fail' ? 1 : 0);
if (args[0] === 'repo') { console.log(${JSON.stringify(GH_REPO)}); process.exit(0); }
if (args[0] === 'release') { console.log('https://github.com/${GH_REPO}/releases/tag/' + args[2]); process.exit(0); }
process.exit(2);
`);
fs.writeFileSync(path.join(fakeGhDir, 'gh.cmd'), `@"${process.execPath}" "%~dp0fake_gh.js" %*\r\n`);

function commit(repo, message) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

// A clean main, in sync with its origin, holding a copy of this plugin.
function makeRepo() {
  const origin = tempDir('arduino-release-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = tempDir('arduino-release-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'tag.gpgSign', 'false');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.mkdirSync(path.join(repo, PLUGIN));
  for (const file of PLUGIN_FILES) {
    fs.copyFileSync(path.join(__dirname, file), path.join(repo, PLUGIN, file));
  }
  // The repository-wide licence, which build_vsix.ps1 packs from the root.
  fs.copyFileSync(path.join(__dirname, '..', 'LICENSE'), path.join(repo, 'LICENSE'));
  commit(repo, 'feat: first plugin commit');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin, ghLog: path.join(tempDir('arduino-release-gh-log-'), 'gh.log') };
}

function release({ repo, ghLog }, { dryRun = true, ghAuth = 'ok' } = {}) {
  const env = { ...process.env, FAKE_GH_LOG: ghLog, FAKE_GH_AUTH: ghAuth };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  env[pathKey] = `${fakeGhDir};${env[pathKey]}`;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, PLUGIN, 'release.ps1')];
  const result = spawnSync('powershell', dryRun ? [...args, '-DryRun'] : args, { env, encoding: 'utf8' });
  const ghCalls = fs.existsSync(ghLog)
    ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  return { ...result, ghCalls };
}

function readNotes(repo) {
  return fs.readFileSync(path.join(repo, PLUGIN, 'dist', 'release', 'release-notes.md'), 'utf8');
}

function assertRefused(result, message) {
  assert.strictEqual(result.status, 1, `expected a refusal, got exit ${result.status}\n${result.stdout}`);
  assert.match(result.stderr, message);
  assert.ok(!result.ghCalls.some((call) => call[0] === 'release'), 'gh release was called');
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('dry run checks, builds and prints the plan without tagging', () => {
  const setup = makeRepo();
  const result = release(setup);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`annotated tag ${TAG} on`), result.stdout);
  assert.ok(result.stdout.includes(`for ${TAG} on ${GH_REPO} with ${packageName}-${version}.vsix`), result.stdout);
  assert.ok(fs.existsSync(path.join(setup.repo, PLUGIN, 'dist', 'release', `${packageName}-${version}.vsix`)));
  assert.strictEqual(git(setup.repo, 'tag'), '');
  assert.strictEqual(git(setup.origin, 'tag'), '');
  assert.ok(!result.ghCalls.some((call) => call[0] === 'release'), 'gh release was called');
});

test('release tags, pushes the tag and attaches the .vsix', () => {
  const setup = makeRepo();
  const result = release(setup, { dryRun: false });
  assert.strictEqual(result.status, 0, result.stderr);
  const head = git(setup.repo, 'rev-parse', 'HEAD');
  assert.strictEqual(git(setup.repo, 'rev-parse', `${TAG}^{commit}`), head);
  assert.strictEqual(git(setup.origin, 'rev-parse', `${TAG}^{commit}`), head);
  assert.strictEqual(git(setup.repo, 'cat-file', '-t', TAG), 'tag', 'tag is not annotated');

  const create = result.ghCalls.find((call) => call[0] === 'release');
  assert.deepStrictEqual(create.slice(0, 3), ['release', 'create', TAG]);
  assert.ok(create[3].endsWith(`${packageName}-${version}.vsix`), create[3]);
  for (const flag of ['--repo', '--title', '--notes-file']) assert.ok(create.includes(flag), flag);
  assert.strictEqual(create[create.indexOf('--repo') + 1], GH_REPO);
  assert.ok(create.includes('--verify-tag'), 'release would not require the pushed tag');
  assert.match(readNotes(setup.repo), /^Changes:\n\n- feat: first plugin commit \([0-9a-f]+\)\n/);
});

test('notes list only plugin commits since the previous release', () => {
  const setup = makeRepo();
  git(setup.repo, 'tag', '-a', '-m', 'previous', `${PLUGIN}-v0.0.1`);
  fs.appendFileSync(path.join(setup.repo, 'README.md'), 'root only\n');
  commit(setup.repo, 'docs: root readme only');
  fs.appendFileSync(path.join(setup.repo, PLUGIN, 'extension.js'), '\n');
  commit(setup.repo, 'fix: plugin change');
  git(setup.repo, 'push', '-q', 'origin', 'main');

  const result = release(setup);
  assert.strictEqual(result.status, 0, result.stderr);
  const notes = readNotes(setup.repo);
  assert.match(notes, new RegExp(`^Changes since ${PLUGIN}-v0\\.0\\.1:\\n\\n- fix: plugin change \\([0-9a-f]+\\)\\n\\n## Install`));
});

test('refuses when gh is not signed in', () => {
  assertRefused(release(makeRepo(), { ghAuth: 'fail' }), /gh is not signed in/);
});

test('refuses off main', () => {
  const setup = makeRepo();
  git(setup.repo, 'checkout', '-q', '-b', 'feature');
  assertRefused(release(setup), /On branch 'feature'\. Releases are made from main/);
});

test('refuses with uncommitted changes to tracked files', () => {
  const setup = makeRepo();
  fs.appendFileSync(path.join(setup.repo, PLUGIN, 'extension.js'), '\n');
  assertRefused(release(setup), /uncommitted changes/);
});

test('refuses when main is not in sync with origin/main', () => {
  const setup = makeRepo();
  fs.appendFileSync(path.join(setup.repo, PLUGIN, 'extension.js'), '\n');
  commit(setup.repo, 'fix: not pushed');
  assertRefused(release(setup), /is not in sync with origin\/main/);
});

test('refuses when the tag exists locally', () => {
  const setup = makeRepo();
  git(setup.repo, 'tag', TAG);
  assertRefused(release(setup), new RegExp(`Tag ${TAG} already exists locally`));
});

test('refuses when the tag exists only on origin', () => {
  const setup = makeRepo();
  git(setup.repo, 'tag', TAG);
  git(setup.repo, 'push', '-q', 'origin', `refs/tags/${TAG}`);
  git(setup.repo, 'tag', '-d', TAG);
  assertRefused(release(setup), new RegExp(`Tag ${TAG} already exists on origin`));
});

test('refuses when no plugin commit follows the previous release', () => {
  const setup = makeRepo();
  git(setup.repo, 'tag', '-a', '-m', 'previous', `${PLUGIN}-v0.0.1`);
  assertRefused(release(setup), /No commits touch/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n  ${err.message}`);
  }
}
tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
