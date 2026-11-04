# Publishes the plugin as a GitHub release with the .vsix attached, so another
# PC installs it without building. Run it from a clean main that matches
# origin/main, after bumping version in package.json:
#
#   powershell -ExecutionPolicy Bypass -File git-branch-indicator\release.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File git-branch-indicator\release.ps1
#
# The tag is <plugin folder>-v<version>, for example git-branch-indicator-v0.2.0:
# the repository holds several plugins, so a bare v0.2.0 would not say which
# one it releases. -DryRun runs every check and the build, then prints what it
# would tag, push and release without doing any of it.

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    [Console]::Error.WriteLine("release.ps1: $Message")
    exit 1
}

# Runs a native tool and returns its exit code and output lines, stderr merged
# in as plain text. Under 'Stop', Windows PowerShell 5.1 turns a tool's stderr
# into a terminating error whenever its own stderr is redirected, even when
# the tool succeeded, so stderr is captured here and the exit code decides.
function Invoke-Tool([string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
    }
    finally {
        $ErrorActionPreference = $saved
    }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
}

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    $result = Invoke-Tool $Exe $Arguments
    if ($result.ExitCode -ne 0) {
        Fail "'$Exe $($Arguments -join ' ')' failed with exit code $($result.ExitCode):`n$($result.Output -join "`n")"
    }
    $result.Output
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'git is not on PATH.'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail 'gh (GitHub CLI) is not on PATH. Install it from https://cli.github.com and run gh auth login.'
}

$pluginDir = $PSScriptRoot
$pluginName = Split-Path -Leaf $pluginDir
$package = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $pluginDir 'package.json') | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "package.json version '$version' is not MAJOR.MINOR.PATCH, so it cannot name a release tag."
}
$tag = "$pluginName-v$version"
$title = "$($package.displayName) v$version"

$auth = Invoke-Tool gh @('auth', 'status', '--hostname', 'github.com')
if ($auth.ExitCode -ne 0) {
    Fail "gh is not signed in to github.com. Run gh auth login first.`n$($auth.Output -join "`n")"
}

$repoRoot = @(Invoke-Checked git @('-C', $pluginDir, 'rev-parse', '--show-toplevel'))[0]

$branch = Invoke-Tool git @('-C', $repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD')
if ($branch.ExitCode -ne 0) {
    Fail 'HEAD is detached. Releases are made from main: git checkout main'
}
if ($branch.Output[0] -ne 'main') {
    Fail "On branch '$($branch.Output[0])'. Releases are made from main: git checkout main"
}

# Untracked files do not matter: the build packs only tracked files. A changed
# tracked file would ship code that no commit, and so no tag, records.
$changes = Invoke-Checked git @('-C', $repoRoot, 'status', '--porcelain', '--untracked-files=no')
if ($changes) {
    Fail "The working tree has uncommitted changes. Commit or discard them first:`n$($changes -join "`n")"
}

Invoke-Checked git @('-C', $repoRoot, 'fetch', '--quiet', 'origin', 'main') | Out-Null
$head = @(Invoke-Checked git @('-C', $repoRoot, 'rev-parse', 'HEAD'))[0]
$remoteHead = @(Invoke-Checked git @('-C', $repoRoot, 'rev-parse', 'refs/remotes/origin/main'))[0]
if ($head -ne $remoteHead) {
    Fail ("main ($($head.Substring(0, 7))) is not in sync with origin/main ($($remoteHead.Substring(0, 7))). " +
        'Pull or push first, so the tag lands on a commit GitHub has.')
}

$localTag = Invoke-Tool git @('-C', $repoRoot, 'rev-parse', '--verify', '--quiet', "refs/tags/$tag")
if ($localTag.ExitCode -eq 0) {
    Fail "Tag $tag already exists locally. Bump version in package.json for a new release."
}
if (Invoke-Checked git @('-C', $repoRoot, 'ls-remote', '--tags', 'origin', "refs/tags/$tag")) {
    Fail "Tag $tag already exists on origin. Bump version in package.json for a new release."
}

Push-Location $repoRoot
try {
    # Resolved from the origin remote, and shown by -DryRun, so the release
    # goes to the repository the tag is pushed to.
    $ghRepo = @(Invoke-Checked gh @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'))[0]
}
finally {
    Pop-Location
}

$previousTag = (Invoke-Checked git @('-C', $repoRoot, 'tag', '--list', "$pluginName-v*", '--merged', 'HEAD', '--sort=-v:refname')) |
    Select-Object -First 1
$range = if ($previousTag) { "$previousTag..HEAD" } else { 'HEAD' }
# Run from the plugin folder so the pathspec '.' keeps only this plugin's commits.
$commits = Invoke-Checked git @('-C', $pluginDir, 'log', '--no-merges', '--format=- %s (%h)', $range, '--', '.')
if (-not $commits) {
    Fail "No commits touch $pluginName/ since $previousTag, so there is nothing to release."
}

$releaseDir = Join-Path $pluginDir 'dist\release'
if (Test-Path $releaseDir) { Remove-Item -Recurse -Force $releaseDir }
& (Join-Path $pluginDir 'build_vsix.ps1') -OutDir $releaseDir
$vsix = @(Get-ChildItem -Path $releaseDir -Filter '*.vsix')
if ($vsix.Count -ne 1) {
    Fail "Expected build_vsix.ps1 to write one .vsix into $releaseDir, found $($vsix.Count)."
}
$vsix = $vsix[0]

$since = if ($previousTag) { "Changes since $($previousTag):" } else { 'Changes:' }
$install = @'
## Install

Download `{0}` below and put it in `%USERPROFILE%\.arduinoIDE\plugins\`. Delete any older `{1}-*.vsix` there and the `{1}-*` folders in `%USERPROFILE%\.arduinoIDE\deployedPlugins\`, then restart Arduino IDE.
'@ -f $vsix.Name, $package.name
$notes = (@($since, '') + $commits + @('', $install)) -join "`n"
$notesPath = Join-Path $releaseDir 'release-notes.md'
[System.IO.File]::WriteAllText($notesPath, $notes, (New-Object System.Text.UTF8Encoding($false)))

if ($DryRun) {
    Write-Output ''
    Write-Output 'Dry run: every check passed and the .vsix is built. Without -DryRun this would:'
    Write-Output "  1. Create annotated tag $tag on $($head.Substring(0, 7)) (main) and push it to origin"
    Write-Output "  2. Create GitHub release '$title' for $tag on $ghRepo with $($vsix.Name) attached"
    Write-Output ''
    Write-Output "Release notes ($notesPath):"
    Write-Output $notes
    exit 0
}

Invoke-Checked git @('-C', $repoRoot, 'tag', '--annotate', '--message', $title, $tag, $head) | Out-Null
$push = Invoke-Tool git @('-C', $repoRoot, 'push', '--quiet', 'origin', "refs/tags/$tag")
if ($push.ExitCode -ne 0) {
    Fail ("Pushing tag $tag failed, so it exists only locally. Remove it with git tag -d $tag, fix the cause and run again:`n" +
        ($push.Output -join "`n"))
}
Write-Output "Pushed tag $tag."

$create = Invoke-Tool gh @('release', 'create', $tag, $vsix.FullName, '--repo', $ghRepo,
    '--title', $title, '--notes-file', $notesPath, '--verify-tag')
if ($create.ExitCode -ne 0) {
    Fail ("Tag $tag is pushed, but creating the release failed. Fix the cause, then finish with:`n" +
        "  gh release create $tag `"$($vsix.FullName)`" --repo $ghRepo --title `"$title`" --notes-file `"$notesPath`" --verify-tag`n" +
        ($create.Output -join "`n"))
}
Write-Output "Released ${title}: $($create.Output -join ' ')"
