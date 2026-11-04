# Git Branch Indicator

An Arduino IDE 2 extension that shows the git branch and commit of the open sketch in the status bar, for example:

```
⎇ dev @ af3346a *
```

| Shown | Meaning |
|---|---|
| `dev @ af3346a` | Branch `dev`, commit `af3346a`, no uncommitted changes to tracked files |
| `*` after the commit | One or more tracked files have uncommitted changes (untracked files are ignored) |
| `detached @ af3346a` | HEAD is on a commit, not a branch |
| `no git` | git is not on the IDE's PATH, the sketch is not in a repository, or the repository has no commits. Hover for the reason |

Hover for the repository root and the last commit subject. Click for a menu:

- **Show details**: the same details in a dialog.
- **Copy branch @ commit**: copies the exact build source for notes and bench issues, for example `dev @ af3346a`, or `dev @ af3346a (dirty)` when tracked files have uncommitted changes. On a detached HEAD it copies `detached @ af3346a`; with `no git` it copies nothing and shows the reason.

The item refreshes every 5 s (see [Settings](#settings)) while the IDE has focus, on save, and when the IDE window regains focus, so a branch switch made in a terminal appears within a few seconds.

The background check runs git with `--no-optional-locks`, so it never takes `.git/index.lock` and cannot get in the way of a commit or checkout made elsewhere.

## Settings

Press `Ctrl+Shift+P`, run **Preferences: Open Settings (UI)** and search for `Git Branch Indicator` (Arduino's own **File > Preferences** dialog does not list extension settings), or add the keys to `%USERPROFILE%\.arduinoIDE\settings.json`:

```json
{
  "gitBranchIndicator.pollIntervalSeconds": 5
}
```

| Setting | Default | Meaning |
|---|---|---|
| `gitBranchIndicator.pollIntervalSeconds` | `5` | Seconds between checks for a branch switch or commit made outside the IDE, from 1 to 300. Checks pause while the IDE is in the background |

Changes apply at once, without restarting the IDE. A value outside 1 to 300 is clamped to that range, and a value that is not a number is ignored in favour of the default.

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

`node git-branch-indicator\test_extension.js` checks the git reading, the status-bar text, activation, the click menu, settings and the extension id without the IDE (needs Node.js). `node git-branch-indicator\test_release.js` checks `release.ps1` against throwaway repositories and a stand-in `gh`, so it never touches GitHub.

## Release

With the version bumped, committed and pushed, from a clean `main` in sync with `origin/main`:

```
powershell -ExecutionPolicy Bypass -File git-branch-indicator\release.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File git-branch-indicator\release.ps1
```

It builds the `.vsix` with `build_vsix.ps1` into `dist\release\`, tags the commit `git-branch-indicator-v<version>` (plugin-prefixed, because the repository holds several plugins), pushes the tag, and creates a GitHub release with the `.vsix` attached. The release notes list the commits that touched `git-branch-indicator/` since the previous `git-branch-indicator-v*` tag, followed by install steps. It refuses, and changes nothing, when not on `main`, when tracked files have uncommitted changes, when `main` differs from `origin/main`, when the tag already exists locally or on `origin`, or when `gh` is not signed in. `-DryRun` runs all of that and the build, then prints the tag, the target repository and the notes instead of publishing. Needs git and the [GitHub CLI](https://cli.github.com) (`gh auth login`).

## Author

Made by [Mz](https://mzspace.me). Extension id `mzspace.arduino-git-branch-indicator`.
