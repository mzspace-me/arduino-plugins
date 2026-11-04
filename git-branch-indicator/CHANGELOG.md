# Changelog

## 0.2.0

First public release, on Open VSX as `mzspace.arduino-git-branch-indicator`.

- **Ahead/behind:** `↑2 ↓1` on the label against the upstream, as of the last fetch. The indicator never fetches. Setting `showAheadBehind`.
- **Warning colours:** the theme's error colour on a protected branch (`main`, `master` by default), its warning colour with uncommitted changes. Settings `warningColours` and `protectedBranches`.
- **Tooltip:** three short lines (branch and commit, last author and age, what needs attention); the full list is in Show details.
- **Click menu:** Show details, Copy branch @ commit (`main @ af3346a (dirty)`), Open branch on GitHub, Open commit on GitHub.
- **Follow the active file:** shows the repository of a file opened from outside the sketch, such as a library in its own repository. Setting `followActiveFile`.
- **Settings** apply without restarting the IDE, including `pollIntervalSeconds`.
- Publisher `mzspace`, author Mz, MIT licence.

## 0.1.0

- The branch and short commit of the open sketch in the status bar, `*` with uncommitted changes to tracked files, `detached` on a detached HEAD, and `no git` with the reason.
