'use strict';

// Arduino IDE 2 status-bar item showing the git branch and commit of the open
// sketch. Arduino IDE 2 ships without git support, so this asks the git CLI
// directly instead of depending on VS Code's built-in git extension.

const { execFile } = require('child_process');
const path = require('path');

const GIT_TIMEOUT_MS = 4000;
const STATUS_BAR_PRIORITY = 100;
const COMMAND_ID = 'gitBranchIndicator.showDetails';
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

// Every setting is read here, one line each, so features read a plain object
// and the defaults and limits sit in one place next to package.json's
// contributes.configuration, which must declare the same ones.
function readSettings(config) {
  return {
    // Polling is what lets the item follow a branch switch made in a
    // terminal; the IDE raises no event for it. Each poll is three short git
    // calls, and a poll still running when the next is due is skipped.
    pollIntervalSeconds: numberSetting(config, 'pollIntervalSeconds', 5, 1, 300),
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
    // Untracked files are left out on purpose: build output and scratch files
    // would otherwise mark every checkout as modified.
    const status = await runGit(folder, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=no',
    ]);
    const lines = status ? status.split(/\r?\n/) : [];
    const header = (key) => {
      const line = lines.find((l) => l.startsWith(`# ${key} `));
      return line ? line.slice(key.length + 3) : null;
    };
    if (header('branch.oid') === '(initial)') {
      return { ok: false, folder, reason: 'The repository has no commits yet.' };
    }
    const branch = header('branch.head');
    const last = await runGit(folder, ['log', '-1', '--format=%h %s']);
    const space = last.indexOf(' ');
    return {
      ok: true,
      root,
      branch: branch === '(detached)' ? null : branch,
      commit: space < 0 ? last : last.slice(0, space),
      subject: space < 0 ? '' : last.slice(space + 1),
      changedFiles: lines.filter((l) => !l.startsWith('#')).length,
    };
  } catch (err) {
    return { ok: false, folder, reason: describeGitError(err) };
  }
}

function formatState(state) {
  if (!state.ok) {
    return {
      text: '$(git-branch) no git',
      tooltip: `${state.reason}\nFolder: ${state.folder}\nClick for details.`,
    };
  }
  const branchLabel = state.branch || 'detached';
  const dirtyMark = state.changedFiles > 0 ? ' *' : '';
  const changesLine =
    state.changedFiles > 0
      ? `Uncommitted changes: ${state.changedFiles} tracked file(s)`
      : 'No uncommitted changes to tracked files';
  return {
    text: `$(git-branch) ${branchLabel} @ ${state.commit}${dirtyMark}`,
    tooltip: [
      `Branch: ${state.branch || 'detached HEAD'}`,
      `Commit: ${state.commit} ${state.subject}`,
      changesLine,
      `Repository: ${state.root}`,
      'Click for details.',
    ].join('\n'),
  };
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
  item.command = COMMAND_ID;
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
      const view = formatState(lastState);
      item.text = view.text;
      item.tooltip = view.tooltip;
      item.show();
      refreshing = false;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      await refresh();
      if (!lastState) {
        vscode.window.showInformationMessage('Still reading the git state; try again in a moment.');
        return;
      }
      const view = formatState(lastState);
      vscode.window.showInformationMessage(view.tooltip.replace(/\nClick for details\.$/, ''), {
        modal: true,
      });
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

module.exports = { activate, readGitState, formatState, readSettings };
