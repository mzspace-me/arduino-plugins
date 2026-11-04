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
const CLICK_HINT = 'Click for details and copy.';
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

function formatState(state, { showAheadBehind = true } = {}) {
  if (!state.ok) {
    return {
      text: '$(git-branch) no git',
      tooltip: `${state.reason}\nFolder: ${state.folder}\n${CLICK_HINT}`,
    };
  }
  const branchLabel = state.branch || 'detached';
  // Untracked files show only here, never in the "*": build output and
  // scratch files would otherwise mark every checkout as modified.
  const dirtyMark = state.changedFiles > 0 ? ' *' : '';
  const aheadBehind = showAheadBehind ? aheadBehindMark(state) : '';
  return {
    text: `$(git-branch) ${branchLabel} @ ${state.commit}${aheadBehind}${dirtyMark}`,
    tooltip: [
      `Branch: ${state.branch || 'detached HEAD'}`,
      `Commit: ${state.commit} ${state.subject}`,
      `Author: ${state.author}, ${state.age}`,
      `Changes: ${state.staged} staged, ${state.unstaged} unstaged, ${state.untracked} untracked`,
      `Stashes: ${state.stashes}`,
      upstreamLine(state),
      `Repository: ${state.root}`,
      CLICK_HINT,
    ].join('\n'),
  };
}

// The theme colour behind the item and the tooltip line saying why, or null to
// leave it uncoloured. Error beats warning: committing to a protected branch is
// the costlier mistake, and uncommitted changes there still show as `*`.
function warningColour(state, settings) {
  if (!settings.warningColours || !state.ok) {
    return null;
  }
  if (state.branch && settings.protectedBranches.includes(state.branch)) {
    return {
      themeColor: 'statusBarItem.errorBackground',
      reason: `Coloured: ${state.branch} is a protected branch (gitBranchIndicator.protectedBranches).`,
    };
  }
  if (state.changedFiles > 0) {
    return {
      themeColor: 'statusBarItem.warningBackground',
      reason: 'Coloured: tracked files have uncommitted changes.',
    };
  }
  return null;
}

// Same branch and commit as the label, as a line to paste into notes and bench
// issues. "(dirty)" rather than the label's "*" so it still reads as a warning
// once pasted out of context.
function branchAtCommit(state) {
  const text = `${state.branch || 'detached'} @ ${state.commit}`;
  return state.changedFiles > 0 ? `${text} (dirty)` : text;
}

function showDetails(vscode, state) {
  const view = formatState(state);
  vscode.window.showInformationMessage(view.tooltip.slice(0, -`\n${CLICK_HINT}`.length), {
    modal: true,
  });
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

// The entries of the click menu, in display order. Each acts on the state the
// menu was opened with, so it matches what the label showed when clicked;
// `description` previews the result in the menu itself.
function menuEntries(state) {
  return [
    { label: 'Show details', run: showDetails },
    {
      label: 'Copy branch @ commit',
      description: state.ok ? branchAtCommit(state) : 'no git',
      run: copyBranchAtCommit,
    },
  ];
}

function sketchFolder(vscode) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return path.dirname(editor.document.uri.fsPath);
  }
  return null;
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
  let settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
  let timer = null;

  // No polling while the IDE is in the background; regaining focus refreshes.
  function startPolling() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (vscode.window.state.focused) {
        refresh();
      }
    }, settings.pollIntervalSeconds * 1000);
  }

  async function refresh() {
    if (refreshing) {
      return;
    }
    refreshing = true;
    try {
      const folder = sketchFolder(vscode);
      lastState = folder
        ? await readGitState(folder)
        : { ok: false, folder: '(none)', reason: 'No sketch folder is open.' };
    } catch (err) {
      lastState = { ok: false, folder: '(unknown)', reason: `Indicator error: ${err.message}` };
    } finally {
      const view = formatState(lastState, settings);
      const warning = warningColour(lastState, settings);
      item.text = view.text;
      item.tooltip = warning ? `${warning.reason}\n${view.tooltip}` : view.tooltip;
      item.backgroundColor = warning ? new vscode.ThemeColor(warning.themeColor) : undefined;
      item.show();
      refreshing = false;
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
      // Resolves to the picked entry object itself, so its `run` comes along.
      const picked = await vscode.window.showQuickPick(menuEntries(state));
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

module.exports = { activate, readGitState, formatState, readSettings, warningColour, branchAtCommit, menuEntries };
