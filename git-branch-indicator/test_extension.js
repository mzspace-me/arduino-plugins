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

const { readGitState, formatState, readSettings, warningColour, branchAtCommit, menuEntries } = require('./extension');

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

// A repository from makeRepo whose branch tracks a local bare "remote", plus a
// second clone that can push commits the first one only sees after a fetch.
function makeRepoWithUpstream() {
  const repo = makeRepo();
  const remote = tempDir('git-indicator-remote-');
  git(remote, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'feat/1-example');
  const other = tempDir('git-indicator-other-');
  git(other, 'clone', '-q', '-b', 'feat/1-example', remote, '.');
  git(other, 'config', 'user.email', 'test@example.invalid');
  git(other, 'config', 'user.name', 'test');
  return { repo, other };
}

function emptyCommit(cwd, message) {
  git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
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
  assert.match(formatState(state).tooltip, /\nChanges: 0 staged, 1 unstaged, 1 untracked\n/);
});

test('tooltip counts staged, unstaged, untracked and stashes, and names the author and age', async () => {
  const repo = makeRepo();
  let state = await readGitState(repo);
  assert.strictEqual(state.author, 'test');
  assert.match(state.age, / ago$/);
  assert.deepStrictEqual(
    [state.staged, state.unstaged, state.untracked, state.stashes],
    [0, 0, 0, 0],
    'no stash yet reads as 0, not an error'
  );

  fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'void loop() {}\n');
  git(repo, 'stash', '-q');
  fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'int a;\n');
  git(repo, 'stash', '-q');
  // Staged then edited again: one file counted as both staged and unstaged.
  fs.writeFileSync(path.join(repo, 'sketch', 'config.h'), '#define A 1\n');
  git(repo, 'add', 'sketch/config.h');
  fs.appendFileSync(path.join(repo, 'sketch', 'config.h'), '#define B 2\n');
  fs.writeFileSync(path.join(repo, 'sketch', 'notes.txt'), 'scratch\n');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'a.bin'), '');
  fs.writeFileSync(path.join(repo, 'build', 'b.bin'), '');

  state = await readGitState(repo);
  assert.deepStrictEqual(
    [state.changedFiles, state.staged, state.unstaged, state.untracked, state.stashes],
    [1, 1, 1, 2, 2],
    'a new folder counts as one untracked entry'
  );
  const lines = formatState(state).tooltip.split('\n');
  assert.deepStrictEqual(lines.slice(2, 5), [
    `Author: test, ${state.age}`,
    'Changes: 1 staged, 1 unstaged, 2 untracked',
    'Stashes: 2',
  ]);
});

test('a merge conflict counts as unstaged', async () => {
  const repo = makeRepo();
  const ino = path.join(repo, 'sketch', 'sketch.ino');
  git(repo, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(ino, 'void setup() { other(); }\n');
  git(repo, 'commit', '-q', '-am', 'other');
  git(repo, 'checkout', '-q', 'feat/1-example');
  fs.writeFileSync(ino, 'void setup() { mine(); }\n');
  git(repo, 'commit', '-q', '-am', 'mine');
  assert.throws(() => git(repo, 'merge', '-q', 'other'));
  const state = await readGitState(repo);
  assert.deepStrictEqual([state.changedFiles, state.staged, state.unstaged], [1, 0, 1]);
});

test('detached HEAD', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '--detach');
  const state = await readGitState(repo);
  assert.strictEqual(state.branch, null);
  assert.match(formatState(state).text, /^\$\(git-branch\) detached @ /);
});

test('no upstream: plain label, "no upstream" in the tooltip', async () => {
  const state = await readGitState(makeRepo());
  assert.strictEqual(state.upstream, null);
  assert.strictEqual(state.ahead, null);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit}`);
  assert.match(formatState(state).tooltip, /\nUpstream: none \(no upstream set\)\n/);
});

test('ahead/behind counts against the upstream, as of the last fetch', async () => {
  const { repo, other } = makeRepoWithUpstream();
  let state = await readGitState(repo);
  assert.deepStrictEqual([state.upstream, state.ahead, state.behind], ['origin/feat/1-example', 0, 0]);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit}`);
  assert.match(formatState(state).tooltip, /\nUpstream: origin\/feat\/1-example, up to date \(as of the last fetch; this indicator never fetches\)\n/);

  emptyCommit(other, 'pushed elsewhere');
  git(other, 'push', '-q');
  state = await readGitState(repo);
  assert.strictEqual(state.behind, 0, 'the indicator must not fetch');

  git(repo, 'fetch', '-q');
  state = await readGitState(repo);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit} ↓1`);

  emptyCommit(repo, 'local one');
  emptyCommit(repo, 'local two');
  fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'void loop() {}\n');
  state = await readGitState(repo);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit} ↑2 ↓1 *`);
  assert.match(formatState(state).tooltip, /\nUpstream: origin\/feat\/1-example, 2 ahead, 1 behind \(as of the last fetch/);
  assert.strictEqual(
    formatState(state, { showAheadBehind: false }).text,
    `$(git-branch) feat/1-example @ ${state.commit} *`
  );
});

test('upstream whose remote branch is gone', async () => {
  const { repo, other } = makeRepoWithUpstream();
  git(other, 'push', '-q', 'origin', '--delete', 'feat/1-example');
  git(repo, 'fetch', '-q', '--prune');
  const state = await readGitState(repo);
  assert.strictEqual(state.upstream, 'origin/feat/1-example');
  assert.strictEqual(state.ahead, null);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit}`);
  assert.match(formatState(state).tooltip, /\nUpstream: origin\/feat\/1-example not found \(deleted on the remote, or not fetched yet\)\n/);
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
    ThemeColor: class ThemeColor {
      constructor(id) {
        this.id = id;
      }
    },
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
    assert.match(
      fake.messages[0].text,
      /^Branch: feat\/1-example\nCommit: [0-9a-f]+ first commit\nAuthor: test, .+ ago\nChanges: 0 staged, 0 unstaged, 0 untracked\nStashes: 0\n/
    );
    assert.ok(!fake.messages[0].text.includes('Click for'));
    assert.deepStrictEqual(fake.messages[0].options, { modal: true });

    await fake.registered.get('gitBranchIndicator.showDetails')();
    // The commit age can tick over between the two dialogs ("0 seconds ago",
    // "1 second ago"), so it is masked before comparing.
    const withoutAge = (text) => text.replace(/^(Author: .+), .+ ago$/m, '$1');
    assert.strictEqual(withoutAge(fake.messages[1].text), withoutAge(fake.messages[0].text));
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
  assert.strictEqual(readSettings(config({})).showAheadBehind, true);
  assert.strictEqual(readSettings(config({ showAheadBehind: false })).showAheadBehind, false);
  assert.strictEqual(readSettings(config({ showAheadBehind: 'false' })).showAheadBehind, true);
  assert.strictEqual(readSettings(config({ showAheadBehind: 0 })).showAheadBehind, true);
});

test('showAheadBehind toggles the counts on the label at once', async () => {
  const { repo } = makeRepoWithUpstream();
  emptyCommit(repo, 'local one');
  const fake = await activateFake(repo);
  try {
    assert.match(fake.item.text, / ↑1$/);
    fake.changeSettings({ 'gitBranchIndicator.showAheadBehind': false });
    await waitFor(() => !fake.item.text.includes('↑'), 'the counts to disappear');
    assert.match(fake.item.tooltip, /, 1 ahead, 0 behind \(as of the last fetch/, 'the tooltip keeps them');
    fake.changeSettings({ 'gitBranchIndicator.showAheadBehind': true });
    await waitFor(() => fake.item.text.endsWith(' ↑1'), 'the counts to return');
  } finally {
    fake.dispose();
  }
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

test('colour settings fall back to defaults; non-string branches are dropped', () => {
  const config = (values) => ({
    get: (key, fallback) => (key in values ? values[key] : fallback),
  });
  const defaults = readSettings(config({}));
  assert.strictEqual(defaults.warningColours, true);
  assert.deepStrictEqual(defaults.protectedBranches, ['main', 'master']);
  assert.strictEqual(readSettings(config({ warningColours: false })).warningColours, false);
  assert.strictEqual(readSettings(config({ warningColours: 'false' })).warningColours, true);
  assert.deepStrictEqual(readSettings(config({ protectedBranches: [] })).protectedBranches, []);
  assert.deepStrictEqual(
    readSettings(config({ protectedBranches: ['release', 7, null, 'main'] })).protectedBranches,
    ['release', 'main']
  );
  assert.deepStrictEqual(
    readSettings(config({ protectedBranches: 'release' })).protectedBranches,
    ['main', 'master']
  );
});

test('warning colour per state; protected branch wins over uncommitted changes', () => {
  const on = { warningColours: true, protectedBranches: ['main', 'master'] };
  const clean = { ok: true, branch: 'feat/x', commit: 'af3346a', changedFiles: 0 };
  const colour = (state, settings = on) => {
    const warning = warningColour(state, settings);
    return warning && warning.themeColor;
  };
  assert.strictEqual(colour(clean), null);
  assert.strictEqual(colour({ ...clean, changedFiles: 1 }), 'statusBarItem.warningBackground');
  assert.strictEqual(colour({ ...clean, branch: 'main' }), 'statusBarItem.errorBackground');
  assert.strictEqual(colour({ ...clean, branch: 'master', changedFiles: 3 }), 'statusBarItem.errorBackground');
  assert.strictEqual(colour({ ...clean, branch: null }), null, 'detached HEAD is not a protected branch');
  assert.strictEqual(colour({ ...clean, branch: null, changedFiles: 1 }), 'statusBarItem.warningBackground');
  assert.strictEqual(colour({ ok: false, folder: '/x', reason: 'r' }), null);

  // Exact names only: no prefix or case-insensitive match.
  assert.strictEqual(colour({ ...clean, branch: 'Main' }), null);
  assert.strictEqual(colour({ ...clean, branch: 'main-fix' }), null);
  const custom = { warningColours: true, protectedBranches: ['release/1.0'] };
  assert.strictEqual(colour({ ...clean, branch: 'release/1.0' }, custom), 'statusBarItem.errorBackground');
  assert.strictEqual(colour({ ...clean, branch: 'main' }, custom), null);

  const off = { ...on, warningColours: false };
  assert.strictEqual(colour({ ...clean, branch: 'main', changedFiles: 1 }, off), null);

  assert.strictEqual(
    warningColour({ ...clean, branch: 'main' }, on).reason,
    'Coloured: main is a protected branch (gitBranchIndicator.protectedBranches).'
  );
  assert.strictEqual(
    warningColour({ ...clean, changedFiles: 1 }, on).reason,
    'Coloured: tracked files have uncommitted changes.'
  );
});

test('the item is coloured with the reason first in the tooltip; settings toggle it', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'main');
  const fake = await activateFake(repo);
  const colour = () => fake.item.backgroundColor && fake.item.backgroundColor.id;
  try {
    assert.strictEqual(colour(), 'statusBarItem.errorBackground');
    assert.match(fake.item.tooltip, /^Coloured: main is a protected branch .*\nBranch: main\n/);

    fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'void loop() {}\n');
    fake.changeSettings({ 'gitBranchIndicator.protectedBranches': ['master'] });
    await waitFor(() => colour() === 'statusBarItem.warningBackground', 'the warning colour');
    assert.match(fake.item.tooltip, /^Coloured: tracked files have uncommitted changes\.\nBranch: main\n/);

    fake.changeSettings({ 'gitBranchIndicator.warningColours': false });
    await waitFor(() => colour() === undefined, 'the colour to clear');
    assert.match(fake.item.tooltip, /^Branch: main\n/);
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
