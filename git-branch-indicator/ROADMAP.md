# Git Branch Indicator: roadmap

Curated 2026-11-04. Publisher: **Mz** ([mzspace.me](https://mzspace.me)), Open VSX namespace `mzspace`, extension id `mzspace.arduino-git-branch-indicator`. The name stays `arduino-git-branch-indicator` so installed copies do not need another rename.

What the IDE allows, checked against Arduino IDE 2.3.4 (Theia 1.41): status-bar items with background colours, quick-pick menus, clipboard, opening URLs, settings, and an event when a Verify finishes (from the bundled Arduino API extension). There is no upload event and no built-in git view.

## v0.2.0: label, click menu, settings

**Label**

| Feature | How |
|---|---|
| Ahead/behind remote | `git status --porcelain=v2 --branch` already returns `# branch.ab +N -M`; show `↑N ↓M` only when non-zero. No upstream: nothing on the label, "no upstream" in the tooltip. Counts are as fresh as the last fetch; the plugin does not fetch by itself, so it never triggers a network or credential prompt. |
| Warning colours | `statusBarItem.warningBackground` when tracked files are modified; `statusBarItem.errorBackground` on a protected branch (setting, default `main`, `master`). Protected wins when both apply. |
| Richer tooltip | Staged, unstaged and untracked counts (untracked appear in the tooltip only, never in the `*`), stash count, last commit author and relative age ("2 hours ago"), ahead/behind with the upstream name. |
| Follow the active file | Read the repository of the file in the active editor (a library tab from another repo, for example), falling back to the sketch folder. When it differs from the sketch's repository, the label is prefixed with that repository's folder name. Refreshes on editor switch. |

**Click menu** (replaces the details dialog; the dialog stays as the first entry)

| Entry | Behaviour |
|---|---|
| Show details | Today's dialog, with the richer content above. |
| Copy branch @ commit | Copies `test @ af3346a` or `test @ af3346a (dirty)`, for notes and bench issues. |
| Open branch on GitHub | URL from `remote get-url origin`, SSH and HTTPS forms both handled. Hidden with a reason for a non-GitHub remote or no remote. |
| Open commit on GitHub | As above; warns first when the commit is not pushed yet (ahead > 0), since GitHub would show a 404. |

**Settings** (`gitBranchIndicator.*`, editable from the IDE's settings or `%USERPROFILE%\.arduinoIDE\settings.json`)

`pollIntervalSeconds` (5), `protectedBranches` (`["main", "master"]`), `showAheadBehind` (on), `warningColours` (on), `followActiveFile` (on).

**Author.** `publisher: mzspace`, `author: { name: "Mz", url: "https://mzspace.me" }`, and a credit line in the README.

**Tests.** Each feature gets a case in `test_extension.js` against a throwaway repository: an upstream with ahead/behind commits, a stash, staged/unstaged/untracked files, SSH and HTTPS remote URLs, and a protected branch.

## v0.3.0: release and public listing

| Step | Who |
|---|---|
| Add `LICENSE` (choice pending), a 128×128 PNG icon, `CHANGELOG.md`, and `repository` / `homepage` / `bugs` / `categories` / `keywords` in `package.json` | Agent |
| `release.ps1`: build, tag `git-branch-indicator-v<version>` (plugin-prefixed, since the repo holds several plugins), create a GitHub release with the `.vsix` attached | Agent |
| Make `MotazBanyAmer/arduino-plugins` public, so the listing's source and issue links work | Agent, on confirmation at release time |
| Sign in to [open-vsx.org](https://open-vsx.org) with GitHub, sign the Eclipse publisher agreement, create an access token | Owner (accounts and tokens are not something the agent handles) |
| `npx ovsx create-namespace mzspace -p <token>`, then `npx ovsx publish <vsix> -p <token>` | Owner, with the exact commands prepared by the agent |
| Confirm the hand-built `.vsix` passes Open VSX validation; if not, package the public build with `@vscode/vsce` instead | Agent, at the first publish |

## Not planned

Branch switching, fetch/pull, build-safety features on Verify (dirty-build warning, build log, `git_info.h`, protected-branch notice), and a changed-files diff view were offered and left out on 2026-11-04.

## Open decision

- **License** for the public listing: MIT or Apache-2.0.
