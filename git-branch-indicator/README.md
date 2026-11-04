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

Hover for the repository root and the last commit subject. Click for the same details in a dialog. The item refreshes every 5 s while the IDE has focus, on save, and when the IDE window regains focus, so a branch switch made in a terminal appears within a few seconds.

The background check runs git with `--no-optional-locks`, so it never takes `.git/index.lock` and cannot get in the way of a commit or checkout made elsewhere.

## Install

From the `Arduino Plugins` folder, in PowerShell or `cmd`:

```
powershell -ExecutionPolicy Bypass -File git-branch-indicator\build_vsix.ps1 -Install
```

This builds `arduino-git-branch-indicator-<version>.vsix` into `git-branch-indicator\dist\` and copies it into `%USERPROFILE%\.arduinoIDE\plugins\`, replacing any older version. Restart Arduino IDE to load it. Without `-Install` it only builds.

To remove it, delete `arduino-git-branch-indicator-*.vsix` from `%USERPROFILE%\.arduinoIDE\plugins\` and restart the IDE.

Requires git on the PATH the IDE starts with. Tested with Arduino IDE 2.3.4.

## Change it

`extension.js` is the whole extension. Bump `version` in `package.json` with each change: the IDE caches an unpacked copy by file name and would otherwise keep running the old one. Then rebuild and reinstall.

`node git-branch-indicator\test_extension.js` checks the git reading, the status-bar text and activation without the IDE (needs Node.js).
