'use strict';

// Arduino IDE 2 status-bar item showing the git branch and commit of the open
// sketch. Arduino IDE 2 ships without git support, so this asks the git CLI
// directly instead of depending on VS Code's built-in git extension.

const { execFile } = require('child_process');
const path = require('path');

const GIT_TIMEOUT_MS = 4000;
const STATUS_BAR_PRIORITY = 100;
const MENU_COMMAND_ID = 'gitBranchIndicator.openMenu';
const DETAILS_COMMAND_ID = 'gitBranchIndicator.showDetails';
const SETTINGS_SECTION = 'gitBranchIndicator';

// A value typed into settings.json is not held to the schema in package.json;
// the editor only underlines it. Out-of-range numbers are clamped and other
// types fall back to the default, so a typo cannot stop polling altogether.
function numberSetting(config, key, fallback, min, max) {
  const value = config.get(key, fallback);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function booleanSetting(config, key, fallback) {
  const value = config.get(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

// Non-string entries are dropped rather than the whole list, so one typo does
// not unprotect every other branch.
function stringArraySetting(config, key, fallback) {
  const value = config.get(key, fallback);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : fallback;
}

// Every setting is read here, one line each, so features read a plain object
// and the defaults and limits sit in one place next to package.json's
// contributes.configuration, which must declare the same ones.
function readSettings(config) {
  return {
    // Polling is what lets the item follow a branch switch made in a
    // terminal; the IDE raises no event for it. Each poll is four short git
    // calls, and a poll still running when the next is due is skipped.
    pollIntervalSeconds: numberSetting(config, 'pollIntervalSeconds', 5, 1, 300),
    showAheadBehind: booleanSetting(config, 'showAheadBehind', true),
    warningColours: booleanSetting(config, 'warningColours', true),
    protectedBranches: stringArraySetting(config, 'protectedBranches', ['main', 'master']),
    followActiveFile: booleanSetting(config, 'followActiveFile', true),
  };
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    // --no-optional-locks stops `git status` refreshing the index in the
    // background: that takes .git/index.lock, which collides with a commit
    // typed in a terminal and is left behind if the timeout kills git.
    execFile(
      'git',
      ['--no-optional-locks', '-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.gitStderr = String(stderr || '').trim();
          reject(err);
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

function describeGitError(err) {
  if (err.code === 'ENOENT') {
    return 'git was not found on the PATH the IDE was started with.';
  }
  if (err.killed) {
    return `git did not answer within ${GIT_TIMEOUT_MS / 1000} s.`;
  }
  if (/not a git repository/i.test(err.gitStderr || '')) {
    return 'The open sketch is not inside a git repository.';
  }
  return err.gitStderr || err.message;
}

async function readGitState(folder) {
  try {
    const root = await runGit(folder, ['rev-parse', '--show-toplevel']);
    // "normal" lists a new folder once instead of every file in it, so an
    // unignored build folder cannot make each poll list thousands of files.
    const status = await runGit(folder, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=normal',
    ]);
    const lines = status ? status.split(/\r?\n/) : [];
    // Porcelain v2 entries: "1"/"2" changed or renamed, with XY = staged and
    // unstaged state ("." for unchanged); "u" unmerged, which still needs
    // resolving in the working tree, so it counts as unstaged; "?" untracked.
    const entries = lines.filter((l) => !l.startsWith('#'));
    const tracked = entries.filter((l) => !l.startsWith('? '));
    const unmerged = (l) => l.startsWith('u ');
    const header = (key) => {
      const line = lines.find((l) => l.startsWith(`# ${key} `));
      return line ? line.slice(key.length + 3) : null;
    };
    if (header('branch.oid') === '(initial)') {
      return { ok: false, folder, reason: 'The repository has no commits yet.' };
    }
    const branch = header('branch.head');
    // "+A -B" against the remote-tracking ref, so as fresh as the last fetch.
    // Missing when there is no upstream, or when its ref is gone.
    const aheadBehind = /^\+(\d+) -(\d+)$/.exec(header('branch.ab') || '');
    // NUL separators, since an author name or subject may hold any other
    // character. --ignore-missing makes "no stash yet" a count of 0, not an error.
    const [last, stashes] = await Promise.all([
      runGit(folder, ['log', '-1', '--format=%h%x00%an%x00%ar%x00%s']),
      runGit(folder, ['rev-list', '--walk-reflogs', '--count', '--ignore-missing', 'refs/stash']),
    ]);
    const [commit, author, age, subject] = last.split('\0');
    return {
      ok: true,
      root,
      branch: branch === '(detached)' ? null : branch,
      commit,
      subject,
      author,
      age,
      changedFiles: tracked.length,
      staged: tracked.filter((l) => !unmerged(l) && l[2] !== '.').length,
      unstaged: tracked.filter((l) => unmerged(l) || l[3] !== '.').length,
      untracked: entries.length - tracked.length,
      stashes: Number(stashes),
      upstream: header('branch.upstream'),
      ahead: aheadBehind ? Number(aheadBehind[1]) : null,
      behind: aheadBehind ? Number(aheadBehind[2]) : null,
    };
  } catch (err) {
    return { ok: false, folder, reason: describeGitError(err) };
  }
}

// Names the repository in the label and the copied text when it is not the
// sketch's, so a library's branch is never mistaken for the sketch's.
function repositoryPrefix(state) {
  return state.repositoryName ? `${state.repositoryName}: ` : '';
}

function followingLines(state) {
  return state.following ? [`Following: ${state.following}`] : [];
}

// Only the non-zero sides, so a branch in step with its upstream (or without
// one) keeps the plain label.
function aheadBehindMark(state) {
  const parts = [];
  if (state.ahead > 0) {
    parts.push(`↑${state.ahead}`);
  }
  if (state.behind > 0) {
    parts.push(`↓${state.behind}`);
  }
  return parts.map((part) => ` ${part}`).join('');
}

// The indicator never fetches, so it cannot trigger a network or credential
// prompt; the counts are only as fresh as the last fetch, pull or push.
function upstreamLine(state) {
  if (!state.upstream) {
    return 'Upstream: none (no upstream set)';
  }
  if (state.ahead === null) {
    return `Upstream: ${state.upstream} not found (deleted on the remote, or not fetched yet)`;
  }
  const counts =
    state.ahead === 0 && state.behind === 0
      ? 'up to date'
      : `${state.ahead} ahead, ${state.behind} behind`;
  return `Upstream: ${state.upstream}, ${counts} (as of the last fetch; this indicator never fetches)`;
}

// Only what needs attention, so a clean branch in step with its upstream
// reads "clean". Changes already explain the warning colour; a protected
// branch is named because nothing else on the label says why it is red.
function attentionParts(state, settings) {
  const parts = [];
  for (const [count, what] of [
    [state.staged, 'staged'],
    [state.unstaged, 'unstaged'],
    [state.untracked, 'untracked'],
  ]) {
    if (count > 0) {
      parts.push(`${count} ${what}`);
    }
  }
  if (parts.length === 0) {
    parts.push('clean');
  }
  if (state.stashes > 0) {
    parts.push(state.stashes === 1 ? '1 stash' : `${state.stashes} stashes`);
  }
  if (state.upstream && state.ahead === null) {
    parts.push(`upstream ${state.upstream} gone`);
  } else if (state.ahead > 0 || state.behind > 0) {
    parts.push(`${aheadBehindMark(state).trim()} vs ${state.upstream}`);
  }
  if (warningColour(state, settings) === 'statusBarItem.errorBackground') {
    parts.push('protected branch');
  }
  return parts;
}

// `tooltip` is the short hover text; `details` is everything, for the Show
// details dialog.
function formatState(state, settings = {}) {
  if (!state.ok) {
    const lines = [state.reason, `Folder: ${state.folder}`];
    return {
      text: '$(git-branch) no git',
      tooltip: lines.join('\n'),
      details: [...lines, ...followingLines(state)].join('\n'),
    };
  }
  const branchLabel = state.branch || 'detached';
  // Untracked files show only in the tooltip, never in the "*": build output
  // and scratch files would otherwise mark every checkout as modified.
  const dirtyMark = state.changedFiles > 0 ? ' *' : '';
  const aheadBehind = settings.showAheadBehind === false ? '' : aheadBehindMark(state);
  const subject = state.subject ? ` · ${state.subject}` : '';
  return {
    text: `$(git-branch) ${repositoryPrefix(state)}${branchLabel} @ ${state.commit}${aheadBehind}${dirtyMark}`,
    tooltip: [
      `${repositoryPrefix(state)}${branchLabel} @ ${state.commit}${subject}`,
      `${state.author}, ${state.age}`,
      attentionParts(state, settings).join(' · '),
    ].join('\n'),
    details: [
      `Branch: ${state.branch || 'detached HEAD'}`,
      `Commit: ${state.commit} ${state.subject}`,
      `Author: ${state.author}, ${state.age}`,
      `Changes: ${state.staged} staged, ${state.unstaged} unstaged, ${state.untracked} untracked`,
      `Stashes: ${state.stashes}`,
      upstreamLine(state),
      `Repository: ${state.root}`,
      ...followingLines(state),
    ].join('\n'),
  };
}

// The theme colour behind the item, or null to leave it uncoloured. Error
// beats warning: committing to a protected branch is the costlier mistake, and
// uncommitted changes there still show as `*`.
function warningColour(state, settings) {
  if (!settings.warningColours || !state.ok) {
    return null;
  }
  if (state.branch && settings.protectedBranches.includes(state.branch)) {
    return 'statusBarItem.errorBackground';
  }
  if (state.changedFiles > 0) {
    return 'statusBarItem.warningBackground';
  }
  return null;
}

// Same branch and commit as the label, as a line to paste into notes and bench
// issues. "(dirty)" rather than the label's "*" so it still reads as a warning
// once pasted out of context.
function branchAtCommit(state) {
  const text = `${repositoryPrefix(state)}${state.branch || 'detached'} @ ${state.commit}`;
  return state.changedFiles > 0 ? `${text} (dirty)` : text;
}

function showDetails(vscode, state) {
  vscode.window.showInformationMessage(formatState(state).details, { modal: true });
}

async function copyBranchAtCommit(vscode, state) {
  if (!state.ok) {
    vscode.window.showWarningMessage(`Nothing to copy: ${state.reason}`);
    return;
  }
  const text = branchAtCommit(state);
  try {
    await vscode.env.clipboard.writeText(text);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not copy to the clipboard: ${err.message}`);
    return;
  }
  vscode.window.showInformationMessage(`Copied: ${text}`);
}

// The forms GitHub offers for cloning, each with or without ".git":
// https://github.com/o/r, git@github.com:o/r and ssh://git@github.com/o/r.
// Returns "o/r", or null for a remote that is not on GitHub.
function githubRepo(remoteUrl) {
  const match =
    /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/]+@)?github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      remoteUrl.trim()
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

// A link the menu cannot open: `description` is the short form shown in the
// menu, `reason` the sentence shown when it is picked anyway.
function unavailable(description, reason) {
  return { description, reason };
}

// The remote branch the local branch pushes to, or null when it has none on a
// remote (a branch never pushed, or one tracking another local branch).
async function readUpstream(root, branch) {
  const out = await runGit(root, [
    'for-each-ref',
    '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track)',
    `refs/heads/${branch}`,
  ]);
  const [remote, ref, track] = out.split('\0');
  if (!remote || remote === '.') {
    return null;
  }
  return { remote, branch: ref.replace(/^refs\/heads\//, ''), gone: track === '[gone]' };
}

async function readRemoteRepo(root, remote) {
  let url;
  try {
    url = await runGit(root, ['remote', 'get-url', remote]);
  } catch (err) {
    if (/no such remote/i.test(err.gitStderr || '')) {
      return unavailable('no remote', `The repository has no remote named ${remote}.`);
    }
    throw err;
  }
  const repo = githubRepo(url);
  return repo
    ? { repo }
    : unavailable('not on GitHub', `Remote ${remote} does not point at github.com.`);
}

// Read when the menu opens rather than on every poll: only these two entries
// need the remote, and a poll stays at three git calls.
async function readGitHubLinks(state) {
  if (!state.ok) {
    const noGit = unavailable('no git', state.reason);
    return { branch: noGit, commit: noGit };
  }
  try {
    const upstream = state.branch ? await readUpstream(state.root, state.branch) : null;
    // A pushed branch names its remote; otherwise, as on a detached HEAD,
    // origin is the one GitHub clones and `git push -u` set up.
    const remote = upstream ? upstream.remote : 'origin';
    const [target, fullCommit, remoteRefWithCommit] = await Promise.all([
      readRemoteRepo(state.root, remote),
      runGit(state.root, ['rev-parse', '--verify', `${state.commit}^{commit}`]),
      runGit(state.root, [
        'for-each-ref',
        '--count=1',
        '--format=%(refname)',
        '--contains',
        state.commit,
        `refs/remotes/${remote}`,
      ]),
    ]);
    const base = target.repo && `https://github.com/${target.repo}`;

    let branch;
    if (!state.branch) {
      branch = unavailable('detached HEAD', 'HEAD is detached, so there is no branch to open.');
    } else if (!base) {
      branch = target;
    } else if (!upstream) {
      branch = unavailable(
        'not pushed',
        `Branch ${state.branch} has no upstream on GitHub yet; push it with "git push -u ${remote} ${state.branch}" first.`
      );
    } else if (upstream.gone) {
      branch = unavailable(
        'upstream gone',
        `The upstream of ${state.branch}, ${remote}/${upstream.branch}, no longer exists as of the last fetch.`
      );
    } else {
      // Slashes in a branch name are path separators in GitHub's /tree/ URLs;
      // every other character is escaped.
      const urlPath = upstream.branch.split('/').map(encodeURIComponent).join('/');
      branch = { url: `${base}/tree/${urlPath}`, description: `${target.repo}: ${upstream.branch}` };
    }

    let commit;
    if (!base) {
      commit = target;
    } else if (!remoteRefWithCommit) {
      // GitHub would answer a commit it has not received with a 404.
      commit = unavailable(
        'not pushed',
        `Commit ${state.commit} is not on ${remote} as of the last fetch or push; push it first.`
      );
    } else {
      commit = { url: `${base}/commit/${fullCommit}`, description: `${target.repo}: ${state.commit}` };
    }
    return { branch, commit };
  } catch (err) {
    const failed = unavailable('git error', describeGitError(err));
    return { branch: failed, commit: failed };
  }
}

async function openOnGitHub(vscode, link) {
  if (!link.url) {
    vscode.window.showWarningMessage(`Cannot open on GitHub: ${link.reason}`);
    return;
  }
  let opened;
  try {
    opened = await vscode.env.openExternal(vscode.Uri.parse(link.url));
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open ${link.url}: ${err.message}`);
    return;
  }
  if (opened === false) {
    vscode.window.showErrorMessage(`The IDE declined to open ${link.url}.`);
  }
}

// The entries of the click menu, in display order. Each acts on the state the
// menu was opened with, so it matches what the label showed when clicked;
// `description` previews the result in the menu itself, or says why an entry
// cannot work, so an entry never just disappears.
function menuEntries(state, links) {
  return [
    { label: 'Show details', run: showDetails },
    {
      label: 'Copy branch @ commit',
      description: state.ok ? branchAtCommit(state) : 'no git',
      run: copyBranchAtCommit,
    },
    {
      label: 'Open branch on GitHub',
      description: links.branch.description,
      run: (vscode) => openOnGitHub(vscode, links.branch),
    },
    {
      label: 'Open commit on GitHub',
      description: links.commit.description,
      run: (vscode) => openOnGitHub(vscode, links.commit),
    },
  ];
}

// Only files on disk have a folder git can read; settings, untitled and other
// virtual documents use other URI schemes.
function activeFileFolder(vscode) {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return path.dirname(editor.document.uri.fsPath);
  }
  return null;
}

function sketchFolder(vscode) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return activeFileFolder(vscode);
}

function isInside(folder, parent) {
  const relative = path.relative(parent, folder);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Null when the folder is in no repository; the reason is not needed, since
// the caller then falls back to the sketch, whose own error is shown.
async function repositoryRoot(folder) {
  try {
    return await runGit(folder, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

// Reads the repository of the active file (a library opened from the sketch,
// say) when it lies outside the sketch folder, and the sketch's otherwise.
// A file in no repository falls back to the sketch rather than showing
// "no git" for, e.g., a board core's header opened by Go to Definition.
async function readFollowedState(vscode, followActiveFile) {
  const sketch = sketchFolder(vscode);
  if (!sketch) {
    return { ok: false, folder: '(none)', reason: 'No sketch folder is open.' };
  }
  const file = followActiveFile ? activeFileFolder(vscode) : null;
  if (!file || isInside(file, sketch)) {
    return { ...(await readGitState(sketch)), following: `${sketch} (sketch)` };
  }
  const [fileRoot, sketchRoot] = await Promise.all([repositoryRoot(file), repositoryRoot(sketch)]);
  if (!fileRoot) {
    return {
      ...(await readGitState(sketch)),
      following: `${sketch} (sketch; the active file is in no git repository)`,
    };
  }
  return {
    ...(await readGitState(file)),
    following: `${file} (active file)`,
    repositoryName: fileRoot === sketchRoot ? null : path.basename(fileRoot),
  };
}

function activate(context) {
  // Required here rather than at the top so the pure helpers above can be
  // exercised by test_extension.js without the IDE's module.
  const vscode = require('vscode');

  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY
  );
  item.command = MENU_COMMAND_ID;
  context.subscriptions.push(item);

  let lastState = null;
  let refreshing = false;
  let refreshAgain = false;
  let settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
  let timer = null;

  // No polling while the IDE is in the background; regaining focus refreshes.
  function startPolling() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (vscode.window.state.focused && !refreshing) {
        refresh();
      }
    }, settings.pollIntervalSeconds * 1000);
  }

  async function refresh() {
    // An event during a refresh (an editor switch, a save) is run after it,
    // so it is not lost until the next poll. Polls skip instead of queueing.
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      lastState = await readFollowedState(vscode, settings.followActiveFile);
    } catch (err) {
      lastState = { ok: false, folder: '(unknown)', reason: `Indicator error: ${err.message}` };
    } finally {
      const view = formatState(lastState, settings);
      const warning = warningColour(lastState, settings);
      item.text = view.text;
      item.tooltip = view.tooltip;
      item.backgroundColor = warning ? new vscode.ThemeColor(warning) : undefined;
      item.show();
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    }
  }

  async function freshState() {
    await refresh();
    if (!lastState) {
      vscode.window.showInformationMessage('Still reading the git state; try again in a moment.');
    }
    return lastState;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(MENU_COMMAND_ID, async () => {
      const state = await freshState();
      if (!state) {
        return;
      }
      const links = await readGitHubLinks(state);
      // Resolves to the picked entry object itself, so its `run` comes along.
      const picked = await vscode.window.showQuickPick(menuEntries(state, links));
      if (picked) {
        await picked.run(vscode, state);
      }
    }),
    vscode.commands.registerCommand(DETAILS_COMMAND_ID, async () => {
      const state = await freshState();
      if (state) {
        showDetails(vscode, state);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    // Theia reports the most recently active visible editor here, so focusing
    // the Serial Monitor, Output or a sidebar view does not change it.
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (settings.followActiveFile) {
        refresh();
      }
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SETTINGS_SECTION)) {
        return;
      }
      const previous = settings;
      settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
      if (settings.pollIntervalSeconds !== previous.pollIntervalSeconds) {
        startPolling();
      }
      refresh();
    }),
    { dispose: () => clearInterval(timer) }
  );

  startPolling();
  refresh();
}

module.exports = {
  activate,
  readGitState,
  formatState,
  readSettings,
  warningColour,
  branchAtCommit,
  menuEntries,
  githubRepo,
  readGitHubLinks,
};
