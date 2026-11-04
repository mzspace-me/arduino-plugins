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

const {
  readGitState,
  formatState,
  readSettings,
  warningColour,
  branchAtCommit,
  menuEntries,
  githubRepo,
  readGitHubLinks,
} = require('./extension');

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

// Stands in for `git push -u origin <branch>` without a network: the remote
// URL points at GitHub and the remote-tracking ref is written directly.
function pushToFakeGitHub(repo, branch, remoteBranch = branch) {
  git(repo, 'remote', 'add', 'origin', 'git@github.com:octo/blink.git');
  git(repo, 'update-ref', `refs/remotes/origin/${remoteBranch}`, 'HEAD');
  git(repo, 'branch', '-q', '-u', `origin/${remoteBranch}`, branch);
}

function fullCommit(repo) {
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
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
  assert.match(formatState(state).details, /\nChanges: 0 staged, 1 unstaged, 1 untracked\n/);
  assert.strictEqual(formatState(state).tooltip.split('\n')[2], '1 unstaged · 1 untracked');
});

test('details count staged, unstaged, untracked and stashes; the tooltip only what is non-zero', async () => {
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
  assert.deepStrictEqual(formatState(state).tooltip.split('\n'), [
    `feat/1-example @ ${state.commit} · first commit`,
    `test, ${state.age}`,
    '1 staged · 1 unstaged · 2 untracked · 2 stashes',
  ]);
  const lines = formatState(state).details.split('\n');
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

test('no upstream: plain label, "no upstream" in the details', async () => {
  const state = await readGitState(makeRepo());
  assert.strictEqual(state.upstream, null);
  assert.strictEqual(state.ahead, null);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit}`);
  assert.match(formatState(state).details, /\nUpstream: none \(no upstream set\)\n/);
  assert.strictEqual(formatState(state).tooltip.split('\n')[2], 'clean');
});

test('ahead/behind counts against the upstream, as of the last fetch', async () => {
  const { repo, other } = makeRepoWithUpstream();
  let state = await readGitState(repo);
  assert.deepStrictEqual([state.upstream, state.ahead, state.behind], ['origin/feat/1-example', 0, 0]);
  assert.strictEqual(formatState(state).text, `$(git-branch) feat/1-example @ ${state.commit}`);
  assert.match(formatState(state).details, /\nUpstream: origin\/feat\/1-example, up to date \(as of the last fetch; this indicator never fetches\)\n/);
  assert.strictEqual(formatState(state).tooltip.split('\n')[2], 'clean');

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
  assert.match(formatState(state).details, /\nUpstream: origin\/feat\/1-example, 2 ahead, 1 behind \(as of the last fetch/);
  assert.strictEqual(
    formatState(state).tooltip.split('\n')[2],
    '1 unstaged · ↑2 ↓1 vs origin/feat/1-example'
  );
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
  assert.match(formatState(state).details, /\nUpstream: origin\/feat\/1-example not found \(deleted on the remote, or not fetched yet\)\n/);
  assert.strictEqual(formatState(state).tooltip.split('\n')[2], 'clean · upstream origin/feat/1-example gone');
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
// `changeSettings` edits user settings and fires the change event;
// `openEditor(fsPath, scheme)` makes that document the active editor (null for
// none) and fires the active-editor change event.
async function activateFake(folder) {
  // `texts` keeps every label shown, in order.
  const item = {
    shown: false,
    texts: [],
    get text() {
      return this.texts[this.texts.length - 1];
    },
    set text(value) {
      this.texts.push(value);
    },
    show() { this.shown = true; },
    dispose() {},
  };
  const fake = {
    item,
    registered: new Map(),
    messages: [],
    warnings: [],
    menus: [],
    clipboard: [],
    opened: [],
    pollDelays: [],
    pickLabel: undefined,
  };
  const settings = {};
  const configListeners = [];
  const editorListeners = [];
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
      onDidChangeActiveTextEditor: (listener) => {
        editorListeners.push(listener);
        return { dispose() {} };
      },
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
      openExternal: async (uri) => {
        fake.opened.push(uri.toString());
        return true;
      },
    },
    Uri: { parse: (text) => ({ toString: () => text }) },
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
  fake.openEditor = (fsPath, scheme = 'file') => {
    const editor = fsPath === null ? undefined : { document: { uri: { scheme, fsPath } } };
    fakeVscode.window.activeTextEditor = editor;
    editorListeners.forEach((listener) => listener(editor));
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

test('menu entries preview the copy text and links, or say there is no git', async () => {
  const ok = { ok: true, branch: 'test', commit: 'af3346a', changedFiles: 1 };
  const links = {
    branch: { url: 'https://github.com/o/r/tree/test', description: 'o/r: test' },
    commit: { description: 'not pushed', reason: 'Commit af3346a is not on origin.' },
  };
  assert.deepStrictEqual(
    menuEntries(ok, links).map((e) => [e.label, e.description]),
    [
      ['Show details', undefined],
      ['Copy branch @ commit', 'test @ af3346a (dirty)'],
      ['Open branch on GitHub', 'o/r: test'],
      ['Open commit on GitHub', 'not pushed'],
    ]
  );
  const noGit = { ok: false, folder: '/x', reason: 'No sketch folder is open.' };
  const noGitLinks = await readGitHubLinks(noGit);
  assert.deepStrictEqual(
    menuEntries(noGit, noGitLinks).slice(1).map((e) => e.description),
    ['no git', 'no git', 'no git']
  );
  assert.strictEqual(noGitLinks.commit.reason, 'No sketch folder is open.');
});

test('GitHub owner/repo from each remote URL form; other hosts give null', () => {
  for (const url of [
    'https://github.com/octo/blink',
    'https://github.com/octo/blink.git',
    'https://github.com/octo/blink/',
    'https://user@github.com/octo/blink.git',
    'http://github.com/octo/blink.git',
    'git@github.com:octo/blink',
    'git@github.com:octo/blink.git',
    'ssh://git@github.com/octo/blink',
    'ssh://git@github.com/octo/blink.git',
    'ssh://git@github.com:22/octo/blink.git',
    'git://github.com/octo/blink.git',
    'https://GitHub.com/octo/blink.git\n',
  ]) {
    assert.strictEqual(githubRepo(url), 'octo/blink', url);
  }
  assert.strictEqual(githubRepo('git@github.com:octo/my.repo.git'), 'octo/my.repo');
  for (const url of [
    'https://gitlab.com/octo/blink.git',
    'git@gitlab.com:octo/blink.git',
    'https://github.com.evil.example/octo/blink',
    'https://example.com/github.com/octo/blink',
    'https://github.com/octo',
    'https://github.com/octo/blink/tree/main',
    'C:/repos/blink.git',
    '../blink.git',
  ]) {
    assert.strictEqual(githubRepo(url), null, url);
  }
});

test('GitHub links say why they cannot open', async () => {
  const repo = makeRepo();
  let links = await readGitHubLinks(await readGitState(repo));
  assert.deepStrictEqual(links.branch, {
    description: 'no remote',
    reason: 'The repository has no remote named origin.',
  });
  assert.deepStrictEqual(links.commit, links.branch);

  git(repo, 'remote', 'add', 'origin', 'https://gitlab.com/octo/blink.git');
  links = await readGitHubLinks(await readGitState(repo));
  assert.strictEqual(links.branch.description, 'not on GitHub');
  assert.strictEqual(links.commit.reason, 'Remote origin does not point at github.com.');

  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:octo/blink.git');
  links = await readGitHubLinks(await readGitState(repo));
  assert.strictEqual(links.branch.description, 'not pushed');
  assert.match(links.branch.reason, /git push -u origin feat\/1-example/);
  assert.strictEqual(links.commit.description, 'not pushed');

  // Pushed under another name: the link follows the upstream, not the local name.
  git(repo, 'update-ref', 'refs/remotes/origin/renamed', 'HEAD');
  git(repo, 'branch', '-q', '-u', 'origin/renamed');
  links = await readGitHubLinks(await readGitState(repo));
  assert.strictEqual(links.branch.url, 'https://github.com/octo/blink/tree/renamed');

  git(repo, 'update-ref', '-d', 'refs/remotes/origin/renamed');
  links = await readGitHubLinks(await readGitState(repo));
  assert.strictEqual(links.branch.description, 'upstream gone');

  git(repo, 'checkout', '-q', '--detach');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  links = await readGitHubLinks(await readGitState(repo));
  assert.strictEqual(links.branch.description, 'detached HEAD');
  assert.strictEqual(links.commit.url, `https://github.com/octo/blink/commit/${fullCommit(repo)}`);
});

test('Open branch / commit on GitHub open the pushed branch and commit', async () => {
  const repo = makeRepo();
  pushToFakeGitHub(repo, 'feat/1-example');
  const fake = await activateFake(path.join(repo, 'sketch'));
  try {
    const pushed = fullCommit(repo);
    await fake.click('Open branch on GitHub');
    await fake.click('Open commit on GitHub');
    assert.deepStrictEqual(fake.opened, [
      'https://github.com/octo/blink/tree/feat/1-example',
      `https://github.com/octo/blink/commit/${pushed}`,
    ]);
    assert.deepStrictEqual(
      fake.menus[0].slice(2).map((e) => e.description),
      ['octo/blink: feat/1-example', `octo/blink: ${pushed.slice(0, 7)}`]
    );

    git(repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    await fake.click('Open commit on GitHub');
    await fake.click('Open branch on GitHub');
    assert.strictEqual(fake.opened.length, 3, 'the unpushed commit was opened');
    assert.strictEqual(fake.opened[2], 'https://github.com/octo/blink/tree/feat/1-example');
    assert.strictEqual(fake.warnings.length, 1);
    assert.match(
      fake.warnings[0],
      /^Cannot open on GitHub: Commit [0-9a-f]+ is not on origin as of the last fetch or push; push it first\.$/
    );
  } finally {
    fake.dispose();
  }
});

test('Open on GitHub without a remote warns with the reason', async () => {
  const fake = await activateFake(makeRepo());
  try {
    await fake.click('Open branch on GitHub');
    await fake.click('Open commit on GitHub');
    assert.deepStrictEqual(fake.opened, []);
    assert.deepStrictEqual(
      fake.menus[0].slice(2).map((e) => e.description),
      ['no remote', 'no remote']
    );
    assert.deepStrictEqual(fake.warnings, [
      'Cannot open on GitHub: The repository has no remote named origin.',
      'Cannot open on GitHub: The repository has no remote named origin.',
    ]);
  } finally {
    fake.dispose();
  }
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
  assert.strictEqual(readSettings(config({})).followActiveFile, true);
  assert.strictEqual(readSettings(config({ followActiveFile: false })).followActiveFile, false);
  assert.strictEqual(readSettings(config({ followActiveFile: 'false' })).followActiveFile, true);
  assert.strictEqual(readSettings(config({ followActiveFile: 0 })).followActiveFile, true);
});

test('showAheadBehind toggles the counts on the label at once', async () => {
  const { repo } = makeRepoWithUpstream();
  emptyCommit(repo, 'local one');
  const fake = await activateFake(repo);
  try {
    assert.match(fake.item.text, / ↑1$/);
    fake.changeSettings({ 'gitBranchIndicator.showAheadBehind': false });
    await waitFor(() => !fake.item.text.includes('↑'), 'the counts to disappear');
    assert.match(fake.item.tooltip, /\nclean · ↑1 vs origin\/feat\/1-example$/, 'the tooltip keeps them');
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
  const colour = (state, settings = on) => warningColour(state, settings);
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

});

test('the item is coloured, the tooltip names a protected branch; settings toggle it', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'main');
  const fake = await activateFake(repo);
  const colour = () => fake.item.backgroundColor && fake.item.backgroundColor.id;
  try {
    assert.strictEqual(colour(), 'statusBarItem.errorBackground');
    assert.match(fake.item.tooltip, /\nclean · protected branch$/);

    fs.appendFileSync(path.join(repo, 'sketch', 'sketch.ino'), 'void loop() {}\n');
    fake.changeSettings({ 'gitBranchIndicator.protectedBranches': ['master'] });
    await waitFor(() => colour() === 'statusBarItem.warningBackground', 'the warning colour');
    assert.match(fake.item.tooltip, /\n1 unstaged$/);

    fake.changeSettings({ 'gitBranchIndicator.warningColours': false });
    await waitFor(() => colour() === undefined, 'the colour to clear');
    assert.match(fake.item.tooltip, /^main @ /);
  } finally {
    fake.dispose();
  }
});

// A sketch repository and a library repository on a different branch, so the
// label shows at a glance which one is read.
function makeSketchAndLibrary() {
  const sketchRepo = makeRepo();
  const libraryRepo = makeRepo();
  git(libraryRepo, 'checkout', '-q', '-b', 'lib/main');
  return {
    sketch: path.join(sketchRepo, 'sketch'),
    sketchFile: path.join(sketchRepo, 'sketch', 'sketch.ino'),
    sketchRepoFile: path.join(sketchRepo, 'README.md'),
    libraryFile: path.join(libraryRepo, 'sketch', 'sketch.ino'),
    libraryName: path.basename(libraryRepo),
  };
}

test('follows the active file into another repository and back', async () => {
  const { sketch, sketchFile, sketchRepoFile, libraryFile, libraryName } = makeSketchAndLibrary();
  const fake = await activateFake(sketch);
  const details = async () => {
    await fake.click('Show details');
    return fake.messages[fake.messages.length - 1].text;
  };
  try {
    assert.match(fake.item.text, /^\$\(git-branch\) feat\/1-example @ /);
    assert.ok((await details()).includes(`Following: ${sketch} (sketch)`));

    fake.openEditor(libraryFile);
    const libraryLabel = `$(git-branch) ${libraryName}: lib/main @ `;
    await waitFor(() => fake.item.text.startsWith(libraryLabel), 'the library repository');
    assert.ok((await details()).includes(`Following: ${path.dirname(libraryFile)} (active file)`));
    assert.ok(fake.item.tooltip.startsWith(`${libraryName}: lib/main @ `));
    await fake.click('Copy branch @ commit');
    assert.match(fake.clipboard[0], new RegExp(`^${libraryName}: lib/main @ [0-9a-f]+$`));

    fake.openEditor(sketchFile);
    await waitFor(() => fake.item.text.includes(' feat/1-example @ '), 'the sketch repository');
    assert.ok(!fake.item.text.includes(':'), 'no prefix for the sketch repository');

    // Outside the sketch folder but in the sketch's repository: no prefix.
    fake.openEditor(libraryFile);
    await waitFor(() => fake.item.text.startsWith(libraryLabel), 'the library repository');
    fake.openEditor(sketchRepoFile);
    await waitFor(() => fake.item.text.includes(' feat/1-example @ '), 'the sketch repository');
    assert.ok(!fake.item.text.includes(':'), 'no prefix within the sketch repository');
    assert.ok((await details()).includes(`(active file)`));
  } finally {
    fake.dispose();
  }
});

test('non-file editors, no editor and files in no repository show the sketch', async () => {
  const { sketch, libraryFile } = makeSketchAndLibrary();
  const outsideFile = path.join(tempDir('git-indicator-no-repo-'), 'core.h');
  const fake = await activateFake(sketch);
  const showsLibrary = () => fake.item.text.includes(' lib/main @ ');
  const showsSketch = () => fake.item.text.includes(' feat/1-example @ ');
  const details = async () => {
    await fake.click('Show details');
    return fake.messages[fake.messages.length - 1].text;
  };
  try {
    for (const [fsPath, scheme] of [
      ['/user/settings.json', 'user-storage'],
      ['Untitled-1', 'untitled'],
      [null],
      [outsideFile, 'file'],
    ]) {
      fake.openEditor(libraryFile);
      await waitFor(showsLibrary, 'the library repository');
      fake.openEditor(fsPath, scheme);
      await waitFor(showsSketch, `the sketch for ${scheme || 'no'} editor`);
    }
    assert.ok(
      (await details()).includes(`Following: ${sketch} (sketch; the active file is in no git repository)`)
    );
  } finally {
    fake.dispose();
  }
});

test('followActiveFile off keeps the sketch; on again follows at once', async () => {
  const { sketch, libraryFile } = makeSketchAndLibrary();
  const fake = await activateFake(sketch);
  const showsLibrary = () => fake.item.text.includes(' lib/main @ ');
  try {
    fake.openEditor(libraryFile);
    await waitFor(showsLibrary, 'the library repository');

    fake.changeSettings({ 'gitBranchIndicator.followActiveFile': false });
    await waitFor(() => !showsLibrary(), 'the sketch once following is off');
    assert.match(fake.item.text, /^\$\(git-branch\) feat\/1-example @ /);

    fake.changeSettings({ 'gitBranchIndicator.followActiveFile': true });
    await waitFor(showsLibrary, 'the library repository once following is on');
  } finally {
    fake.dispose();
  }
});

test('an editor switch while a refresh runs is shown when it ends', async () => {
  const { sketch, sketchFile, libraryFile } = makeSketchAndLibrary();
  const fake = await activateFake(sketch);
  try {
    // Polling cannot then be what shows the second switch within the wait.
    fake.changeSettings({ 'gitBranchIndicator.pollIntervalSeconds': 300 });
    const sketchLabel = fake.item.text;
    await waitFor(() => fake.item.texts.length === 2, 'the refresh after the settings change');

    fake.openEditor(libraryFile);
    fake.openEditor(sketchFile);
    await waitFor(() => fake.item.texts.length === 4, 'a refresh per switch');
    assert.match(fake.item.texts[2], / lib\/main @ /);
    assert.strictEqual(fake.item.texts[3], sketchLabel);
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
