'use strict';

// Checks the extension outside the IDE: git reading against throwaway
// repositories, the status-bar text for each state, and activation against a
// minimal stand-in for the IDE's `vscode` module.
//
//   node git-branch-indicator/test_extension.js

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const { readGitState, formatState, readSettings } = require('./extension');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

// Stops git searching above the temp folder, so a temp folder that happens to
// sit inside some other repository still reads as "not a repository".
process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync(os.tmpdir());

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo() {
  const dir = tempDir('arduino-git-branch-indicator-');
  git(dir, 'init', '-q', '-b', 'feat/1-example');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'sketch'));
  fs.writeFileSync(path.join(dir, 'sketch', 'sketch.ino'), 'void setup() {}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first commit');
  return dir;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('branch, commit and subject from a sketch subfolder', async () => {
  const repo = makeRepo();
  const state = await readGitState(path.join(repo, 'sketch'));
  assert.strictEqual(state.ok, true);
  assert.strictEqual(state.branch, 'feat/1-example');
  assert.match(state.commit, /^[0-9a-f]{7,}$/);
  assert.strictEqual(state.subject, 'first commit');
  assert.strictEqual(state.changedFiles, 0);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit}`);
});

test('modified tracked file marks the item; untracked file does not', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'sketch', 'scratch.txt'), 'untracked\n');
  let state = await readGitState(repo);
  assert.strictEqual(state.changedFiles, 0);
  fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'void loop() {}\n');
  state = await readGitState(repo);
  assert.strictEqual(state.changedFiles, 1);
  assert.ok(formatState(state).text.endsWith(' *'));
  assert.match(formatState(state).tooltip, /Uncommitted changes: 1 tracked file/);
});

test('detached HEAD', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '--detach');
  const state = await readGitState(repo);
  assert.strictEqual(state.branch, null);
  assert.match(formatState(state).text, /^\$\(git-branch\) detached @ /);
});

test('folder outside any repository names the reason', async () => {
  const dir = tempDir('git-indicator-no-repo-');
  const state = await readGitState(dir);
  assert.strictEqual(state.ok, false);
  assert.strictEqual(state.reason, 'The open sketch is not inside a git repository.');
  assert.strictEqual(formatState(state).text, '$(git-branch) no git');
});

test('repository with no commits', async () => {
  const dir = tempDir('git-indicator-empty-repo-');
  git(dir, 'init', '-q');
  const state = await readGitState(dir);
  assert.strictEqual(state.ok, false);
  assert.strictEqual(state.reason, 'The repository has no commits yet.');
});

test('git missing from PATH', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const state = await readGitState(os.tmpdir());
    assert.strictEqual(state.ok, false);
    assert.strictEqual(state.reason, 'git was not found on the PATH the IDE was started with.');
  } finally {
    process.env.PATH = savedPath;
  }
});

// The id is the Open VSX namespace plus the name; changing either orphans
// installed copies, so it is pinned here.
test('extension id and author credit', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.strictEqual(`${pkg.publisher}.${pkg.name}`, 'mzspace.arduino-git-branch-indicator');
  assert.deepStrictEqual(pkg.author, { name: 'Mz', url: 'https://mzspace.me' });
});

// A minimal stand-in for the IDE's `vscode` module, loaded in place of the
// real one while `fn` runs. Records poll interval delays and lets a test fire
// a settings change.
async function withFakeIde(repo, fn) {
  const item = { shown: false, show() { this.shown = true; }, dispose() {} };
  const registered = new Map();
  const messages = [];
  const settings = {};
  const configListeners = [];
  const pollDelays = [];
  const noopEvent = () => ({ dispose() {} });
  const fakeVscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      state: { focused: true },
      createStatusBarItem: () => item,
      showInformationMessage: (text) => messages.push(text),
      onDidChangeWindowState: noopEvent,
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: path.join(repo, 'sketch') } }],
      onDidSaveTextDocument: noopEvent,
      onDidChangeWorkspaceFolders: noopEvent,
      getConfiguration: (section) => ({
        get: (key, fallback) => {
          const value = settings[`${section}.${key}`];
          return value === undefined ? fallback : value;
        },
      }),
      onDidChangeConfiguration: (listener) => {
        configListeners.push(listener);
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        registered.set(id, handler);
        return { dispose() {} };
      },
    },
  };
  const changeSettings = (changes) => {
    Object.assign(settings, changes);
    const event = {
      affectsConfiguration: (section) =>
        Object.keys(changes).some((key) => key === section || key.startsWith(`${section}.`)),
    };
    configListeners.forEach((listener) => listener(event));
  };
  const waitFor = async (condition, what) => {
    for (let i = 0; i < 50 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(condition(), `timed out waiting for ${what}`);
  };

  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  Module._load = function load(request, ...rest) {
    return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, ...rest);
  };
  global.setInterval = (callback, delay) => {
    pollDelays.push(delay);
    return originalSetInterval(callback, delay);
  };
  const context = { subscriptions: [] };
  try {
    require('./extension').activate(context);
    await waitFor(() => item.shown, 'the status bar item');
    await fn({ item, registered, messages, pollDelays, changeSettings, waitFor });
  } finally {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    context.subscriptions.forEach((s) => s.dispose());
  }
}

test('activate shows the item; clicking it shows the details', async () => {
  const repo = makeRepo();
  await withFakeIde(repo, async ({ item, registered, messages, pollDelays }) => {
    assert.match(item.text, /^\$\(git-branch\) feat\/1-example @ [0-9a-f]+$/);
    assert.strictEqual(item.command, 'gitBranchIndicator.showDetails');
    assert.deepStrictEqual([...registered.keys()], ['gitBranchIndicator.showDetails']);
    assert.deepStrictEqual(pollDelays, [5000]);

    await registered.get('gitBranchIndicator.showDetails')();
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /^Branch: feat\/1-example\nCommit: [0-9a-f]+ first commit\n/);
    assert.ok(!messages[0].includes('Click for details'));
  });
});

test('settings fall back to defaults and are held to their limits', () => {
  const config = (values) => ({
    get: (key, fallback) => (key in values ? values[key] : fallback),
  });
  assert.strictEqual(readSettings(config({})).pollIntervalSeconds, 5);
  assert.strictEqual(readSettings(config({ pollIntervalSeconds: 30 })).pollIntervalSeconds, 30);
  assert.strictEqual(readSettings(config({ pollIntervalSeconds: 0 })).pollIntervalSeconds, 1);
  assert.strictEqual(readSettings(config({ pollIntervalSeconds: 9999 })).pollIntervalSeconds, 300);
  assert.strictEqual(readSettings(config({ pollIntervalSeconds: '10' })).pollIntervalSeconds, 5);
  assert.strictEqual(readSettings(config({ pollIntervalSeconds: null })).pollIntervalSeconds, 5);
});

test('a settings change applies at once without restarting', async () => {
  const repo = makeRepo();
  await withFakeIde(repo, async ({ item, pollDelays, changeSettings, waitFor }) => {
    changeSettings({ 'editor.fontSize': 20 });
    assert.deepStrictEqual(pollDelays, [5000], 'another extension\'s setting restarted polling');

    git(repo, 'checkout', '-q', '-b', 'feat/2-other');
    changeSettings({ 'gitBranchIndicator.pollIntervalSeconds': 30 });
    assert.deepStrictEqual(pollDelays, [5000, 30000]);
    // The 30 s poll cannot be what shows the new branch within the wait.
    await waitFor(() => item.text.includes('feat/2-other'), 'an immediate refresh');
  });
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n  ${err.message}`);
    }
  }
  tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
