# Git Branch Indicator

An Arduino IDE 2 extension that shows the git branch and commit of the open sketch in the status bar, for example:

```
⎇ dev @ af3346a *
```

| Shown | Meaning |
|---|---|
| `dev @ af3346a` | Branch `dev`, commit `af3346a`, no uncommitted changes to tracked files |
| `↑2 ↓1` after the commit | The branch has 2 commits its upstream lacks and lacks 1 commit the upstream has. Only non-zero sides are shown; nothing is shown in step with the upstream or without one |
| `*` at the end | One or more tracked files have uncommitted changes (untracked files are ignored) |
| `detached @ af3346a` | HEAD is on a commit, not a branch |
| `MyLib: main @ 1b2c3d4` | The active editor's file is in another repository, folder `MyLib` (see [Follow the active file](#follow-the-active-file)) |
| `no git` | git is not on the IDE's PATH, the sketch is not in a repository, or the repository has no commits. Hover for the reason |

The item's background also warns, in the colours of the IDE's theme:

| Colour | When |
|---|---|
| Error (red in most themes) | On a protected branch, `main` or `master` unless changed in [Settings](#settings), with or without uncommitted changes |
| Warning (yellow or orange in most themes) | On any other branch, or a detached HEAD, with uncommitted changes to tracked files |
| None | Otherwise, or with `no git` |

A protected branch takes the error colour even when clean: committing there by mistake is the costlier slip, and uncommitted changes on it still show as `*`. On a protected branch the tooltip also says `protected branch`. Both can be turned off or changed in [Settings](#settings).

Hover for a short summary, with only what needs attention on the last line:

```
dev @ af3346a · Fix servo jitter
Mz, 2 hours ago
1 staged · 2 unstaged · 3 untracked · 1 stash · ↑2 ↓1 vs origin/dev
```

A clean branch in step with its upstream reads `clean` on the last line. **Show details** in the click menu gives everything, zeros included:

```
Branch: dev
Commit: af3346a Fix servo jitter
Author: Mz, 2 hours ago
Changes: 1 staged, 2 unstaged, 3 untracked
Stashes: 1
Upstream: origin/dev, 2 ahead, 1 behind
Repository: C:/Users/me/Arduino/robot
```

- **Author** and age are of the last commit, the age as git words it ("2 hours ago").
- **Changes** counts files: staged (added to the index), unstaged (changed in the working tree, including files with merge conflicts) and untracked (not ignored by `.gitignore`). A file staged and then edited again counts in both staged and unstaged. A new folder holding only untracked files counts once, so an unignored build folder stays cheap to check. Untracked files never count towards the `*`.
- **Stashes** is the number of entries in `git stash list`.
- **Upstream** is the branch it tracks, or "no upstream". The ahead/behind counts are as fresh as the last fetch, pull or push: the indicator never fetches, so it never touches the network or prompts for credentials. Fetch yourself to update them.

Click for a menu:

- **Show details**: the full details above, in a dialog.
- **Copy branch @ commit**: copies the exact build source for notes and bench issues, for example `dev @ af3346a`, or `dev @ af3346a (dirty)` when tracked files have uncommitted changes. On a detached HEAD it copies `detached @ af3346a`; with `no git` it copies nothing and shows the reason.
- **Open branch on GitHub** / **Open commit on GitHub**: opens the branch (`/tree/<branch>`) or the commit (`/commit/<hash>`) in the browser. The repository comes from the branch's upstream remote, or `origin` when there is none; `https://github.com/o/r`, `git@github.com:o/r` and `ssh://git@github.com/o/r` remotes all work, with or without `.git`. The menu shows `owner/repo: <branch or commit>` next to each entry, or why it cannot open:

  | Shown in the menu | Why |
  |---|---|
  | `no remote` | The repository has no `origin` remote |
  | `not on GitHub` | The remote points somewhere other than github.com |
  | `detached HEAD` | (branch only) HEAD is on a commit, not a branch |
  | `not pushed` | The branch has no upstream yet, or the commit is on no branch of the remote as of the last fetch or push, so GitHub would show a 404 |
  | `upstream gone` | (branch only) The upstream branch was deleted from the remote |

  Picking an entry that cannot open shows the full reason instead. A private repository only loads when the browser is signed in to GitHub.

The item refreshes every 5 s (see [Settings](#settings)) while the IDE has focus, on save, when the IDE window regains focus, and when another editor tab becomes active, so a branch switch made in a terminal appears within a few seconds.

### Follow the active file

When the file in the active editor tab lies outside the sketch folder, such as a library opened with **Go to Definition**, the item shows that file's repository instead of the sketch's. The label is prefixed with the repository's folder name when it is not the sketch's repository, and **Copy branch @ commit** copies the prefix too, for example `MyLib: main @ 1b2c3d4`. The `Following:` line in **Show details** names the folder being read and whether it is the active file's or the sketch's.

It shows the sketch's repository again when the active file is in the sketch folder, in no git repository (a board core's header, say), or not a file on disk (such as `settings.json` opened from the settings editor). Focusing the Serial Monitor, Output or a sidebar view keeps the last editor tab followed. Turn it off with `gitBranchIndicator.followActiveFile`.

The background check runs git with `--no-optional-locks`, so it never takes `.git/index.lock` and cannot get in the way of a commit or checkout made elsewhere.

## Settings

Press `Ctrl+Shift+P`, run **Preferences: Open Settings (UI)** and search for `Git Branch Indicator` (Arduino's own **File > Preferences** dialog does not list extension settings), or add the keys to `%USERPROFILE%\.arduinoIDE\settings.json`:

```json
{
  "gitBranchIndicator.pollIntervalSeconds": 5,
  "gitBranchIndicator.showAheadBehind": true,
  "gitBranchIndicator.warningColours": true,
  "gitBranchIndicator.protectedBranches": ["main", "master"],
  "gitBranchIndicator.followActiveFile": true
}
```

| Setting | Default | Meaning |
|---|---|---|
| `gitBranchIndicator.pollIntervalSeconds` | `5` | Seconds between checks for a branch switch or commit made outside the IDE, from 1 to 300. Checks pause while the IDE is in the background |
| `gitBranchIndicator.showAheadBehind` | `true` | Show the `↑`/`↓` counts against the upstream on the label. The tooltip shows them either way |
| `gitBranchIndicator.warningColours` | `true` | Colour the item's background as described above; `false` leaves it uncoloured |
| `gitBranchIndicator.protectedBranches` | `["main", "master"]` | Branch names that get the error colour, matched exactly and case-sensitively. `[]` protects none |
| `gitBranchIndicator.followActiveFile` | `true` | Show the repository of the active editor's file when it lies outside the sketch folder (see [Follow the active file](#follow-the-active-file)). `false` always shows the sketch's |

Changes apply at once, without restarting the IDE. A value outside 1 to 300 is clamped to that range, and a value of the wrong type (such as `"false"` in quotes, or a single branch name not in a list) is ignored in favour of the default. Entries of `protectedBranches` that are not strings are skipped.

## Install

On a PC without this repository, take the `.vsix` from the latest `git-branch-indicator-v*` [release](https://github.com/mzspace-me/arduino-plugins/releases), or with the GitHub CLI:

```
gh release download git-branch-indicator-v<version> --repo mzspace-me/arduino-plugins --pattern *.vsix
```

Put it in `%USERPROFILE%\.arduinoIDE\plugins\`, delete any older `arduino-git-branch-indicator-*.vsix` there and the `arduino-git-branch-indicator-*` folders in `%USERPROFILE%\.arduinoIDE\deployedPlugins\`, then restart Arduino IDE.

To build and install from this repository instead, from the `Arduino Plugins` folder, in PowerShell or `cmd`:

```
powershell -ExecutionPolicy Bypass -File git-branch-indicator\build_vsix.ps1 -Install
```

This builds `arduino-git-branch-indicator-<version>.vsix` into `git-branch-indicator\dist\`, copies it into `%USERPROFILE%\.arduinoIDE\plugins\` replacing any older version, and clears the IDE's unpacked copies so the new build is the one loaded. Restart Arduino IDE to load it. Without `-Install` it only builds.

To remove it, delete `arduino-git-branch-indicator-*.vsix` from `%USERPROFILE%\.arduinoIDE\plugins\` **and** the `arduino-git-branch-indicator-*` folders from `%USERPROFILE%\.arduinoIDE\deployedPlugins\`, then restart the IDE. The IDE runs plugins from those unpacked folders and keeps loading one whose `.vsix` is gone.

Requires git on the PATH the IDE starts with. Tested with Arduino IDE 2.3.4.

## Change it

`extension.js` is the whole extension. Bump `version` in `package.json` with each change, then rebuild and reinstall with `-Install`, which also clears the IDE's unpacked copy of the previous build.

`node git-branch-indicator\test_extension.js` checks the git reading, the status-bar text and colours, activation, the click menu and its GitHub links, settings and the extension id without the IDE (needs Node.js). `node git-branch-indicator\test_release.js` checks `release.ps1` against throwaway repositories and a stand-in `gh`, so it never touches GitHub.

## Release

With the version bumped, committed and pushed, from a clean `main` in sync with `origin/main`:

```
powershell -ExecutionPolicy Bypass -File git-branch-indicator\release.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File git-branch-indicator\release.ps1
```

It builds the `.vsix` with `build_vsix.ps1` into `dist\release\`, tags the commit `git-branch-indicator-v<version>` (plugin-prefixed, because the repository holds several plugins), pushes the tag, and creates a GitHub release with the `.vsix` attached. The release notes list the commits that touched `git-branch-indicator/` since the previous `git-branch-indicator-v*` tag, followed by install steps. It refuses, and changes nothing, when not on `main`, when tracked files have uncommitted changes, when `main` differs from `origin/main`, when the tag already exists locally or on `origin`, or when `gh` is not signed in. `-DryRun` runs all of that and the build, then prints the tag, the target repository and the notes instead of publishing. Needs git and the [GitHub CLI](https://cli.github.com) (`gh auth login`).

## Author

Made by [Mz](https://mzspace.me). Extension id `mzspace.arduino-git-branch-indicator`.
