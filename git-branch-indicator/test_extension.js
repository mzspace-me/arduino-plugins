'use strict';

// Checks the extension outside the IDE: git reading against throwaway
// repositories, the status-bar text for each state, and activation and the
// click menu against a minimal stand-in for the IDE's `vscode` module.
//
//   node git-branch-indicator/test_extension.js

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const { readGitState, formatState, readSettings, branchAtCommit, menuEntries } = require('./extension');

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

async function waitFor(condition, what) {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(condition(), `timed out waiting for ${what}`);
}

// Activates the extension against a minimal stand-in for the IDE's `vscode`
// module. `pickLabel` chooses the quick pick entry a click "selects"; every
// message and clipboard write is recorded, as is each poll interval started.
// `changeSettings` edits user settings and fires the change event.
async function activateFake(folder) {
  const item = { shown: false, show() { this.shown = true; }, dispose() {} };
  const fake = {
    item,
    registered: new Map(),
    messages: [],
    warnings: [],
    menus: [],
    clipboard: [],
    pollDelays: [],
    pickLabel: undefined,
  };
  const settings = {};
  const configListeners = [];
  const noopEvent = () => ({ dispose() {} });
  const fakeVscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      state: { focused: true },
      createStatusBarItem: () => item,
      showInformationMessage: (text, options) => fake.messages.push({ text, options }),
      showWarningMessage: (text) => fake.warnings.push(text),
      showErrorMessage: (text) => assert.fail(`unexpected error message: ${text}`),
      showQuickPick: async (entries) => {
        fake.menus.push(entries);
        return entries.find((e) => e.label === fake.pickLabel);
      },
      onDidChangeWindowState: noopEvent,
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: folder } }],
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
    env: {
      clipboard: { writeText: async (text) => fake.clipboard.push(text) },
    },
    commands: {
      registerCommand: (id, handler) => {
        fake.registered.set(id, handler);
        return { dispose() {} };
      },
    },
  };

  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  Module._load = function load(request, ...rest) {
    return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, ...rest);
  };
  // Stays replaced until dispose, since a settings change restarts polling.
  global.setInterval = (callback, delay) => {
    fake.pollDelays.push(delay);
    return originalSetInterval(callback, delay);
  };
  const context = { subscriptions: [] };
  try {
    require('./extension').activate(context);
  } finally {
    Module._load = originalLoad;
  }
  fake.dispose = () => {
    context.subscriptions.forEach((s) => s.dispose());
    global.setInterval = originalSetInterval;
  };
  fake.changeSettings = (changes) => {
    Object.assign(settings, changes);
    const event = {
      affectsConfiguration: (section) =>
        Object.keys(changes).some((key) => key === section || key.startsWith(`${section}.`)),
    };
    configListeners.forEach((listener) => listener(event));
  };
  await waitFor(() => item.shown, 'the status bar item');
  fake.click = (pickLabel) => {
    fake.pickLabel = pickLabel;
    return fake.registered.get(item.command)();
  };
  return fake;
}

test('branch @ commit text for clean, dirty and detached states', () => {
  const state = { ok: true, branch: 'test', commit: 'af3346a', changedFiles: 0 };
  assert.strictEqual(branchAtCommit(state), 'test @ af3346a');
  assert.strictEqual(branchAtCommit({ ...state, changedFiles: 2 }), 'test @ af3346a (dirty)');
  assert.strictEqual(branchAtCommit({ ...state, branch: null }), 'detached @ af3346a');
});

test('menu entries preview the copy text, or say there is no git', () => {
  const ok = { ok: true, branch: 'test', commit: 'af3346a', changedFiles: 1 };
  assert.deepStrictEqual(
    menuEntries(ok).map((e) => [e.label, e.description]),
    [
      ['Show details', undefined],
      ['Copy branch @ commit', 'test @ af3346a (dirty)'],
    ]
  );
  const noGit = { ok: false, folder: '/x', reason: 'No sketch folder is open.' };
  assert.strictEqual(menuEntries(noGit)[1].description, 'no git');
});

test('activate shows the item; clicking it opens the menu; Show details', async () => {
  const repo = makeRepo();
  const fake = await activateFake(path.join(repo, 'sketch'));
  try {
    assert.match(fake.item.text, /^\$\(git-branch\) feat\/1-example @ [0-9a-f]+$/);
    assert.strictEqual(fake.item.command, 'gitBranchIndicator.openMenu');
    assert.deepStrictEqual(
      [...fake.registered.keys()],
      ['gitBranchIndicator.openMenu', 'gitBranchIndicator.showDetails']
    );
    assert.deepStrictEqual(fake.pollDelays, [5000]);

    await fake.click(undefined);
    assert.strictEqual(fake.menus.length, 1);
    assert.deepStrictEqual(fake.messages, [], 'dismissing the menu does nothing');

    await fake.click('Show details');
    assert.strictEqual(fake.messages.length, 1);
    assert.match(fake.messages[0].text, /^Branch: feat\/1-example\nCommit: [0-9a-f]+ first commit\n/);
    assert.ok(!fake.messages[0].text.includes('Click for'));
    assert.deepStrictEqual(fake.messages[0].options, { modal: true });

    await fake.registered.get('gitBranchIndicator.showDetails')();
    assert.strictEqual(fake.messages[1].text, fake.messages[0].text);
  } finally {
    fake.dispose();
  }
});

test('Copy branch @ commit copies and confirms, marking uncommitted changes', async () => {
  const repo = makeRepo();
  const fake = await activateFake(repo);
  try {
    const commit = fake.item.text.split(' @ ')[1];
    await fake.click('Copy branch @ commit');
    fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'void loop() {}\n');
    await fake.click('Copy branch @ commit');
    assert.deepStrictEqual(fake.clipboard, [
      `feat/1-example @ ${commit}`,
      `feat/1-example @ ${commit} (dirty)`,
    ]);
    assert.deepStrictEqual(
      fake.messages.map((m) => m.text),
      fake.clipboard.map((text) => `Copied: ${text}`)
    );
  } finally {
    fake.dispose();
  }
});

test('Copy branch @ commit without git warns with the reason', async () => {
  const fake = await activateFake(tempDir('git-indicator-no-repo-'));
  try {
    await fake.click('Copy branch @ commit');
    assert.deepStrictEqual(fake.clipboard, []);
    assert.deepStrictEqual(fake.warnings, [
      'Nothing to copy: The open sketch is not inside a git repository.',
    ]);
  } finally {
    fake.dispose();
  }
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
  const fake = await activateFake(path.join(repo, 'sketch'));
  try {
    fake.changeSettings({ 'editor.fontSize': 20 });
    assert.deepStrictEqual(fake.pollDelays, [5000], "another extension's setting restarted polling");

    git(repo, 'checkout', '-q', '-b', 'feat/2-other');
    fake.changeSettings({ 'gitBranchIndicator.pollIntervalSeconds': 30 });
    assert.deepStrictEqual(fake.pollDelays, [5000, 30000]);
    // The 30 s poll cannot be what shows the new branch within the wait.
    await waitFor(() => fake.item.text.includes('feat/2-other'), 'an immediate refresh');
  } finally {
    fake.dispose();
  }
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
