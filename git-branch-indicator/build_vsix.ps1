# Packs the extension into a .vsix and, with -Install, copies it into the
# Arduino IDE 2 user plugins folder. Needs no npm packages: a .vsix is a zip
# holding a manifest, a content-types file and the extension under extension/.
#
#   powershell -ExecutionPolicy Bypass -File git-branch-indicator\build_vsix.ps1 -Install
#
# Restart Arduino IDE afterwards; it loads plugins only at start-up.

param(
    [string]$OutDir = (Join-Path $PSScriptRoot 'dist'),
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = $PSScriptRoot
$package = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $sourceDir 'package.json') | ConvertFrom-Json
$name = $package.name
$version = $package.version
$vsixName = "$name-$version.vsix"

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
'@

$escapedDisplayName = [System.Security.SecurityElement]::Escape($package.displayName)
$escapedDescription = [System.Security.SecurityElement]::Escape($package.description)
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$name" Version="$version" Publisher="$($package.publisher)"/>
    <DisplayName>$escapedDisplayName</DisplayName>
    <Description xml:space="preserve">$escapedDescription</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
"@

# Only the files the IDE needs; the test script and this packer stay out.
$payload = @('package.json', 'extension.js', 'README.md')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$vsixPath = Join-Path $OutDir $vsixName
if (Test-Path $vsixPath) { Remove-Item -Force $vsixPath }

# ZipArchive is used directly because Compress-Archive on Windows PowerShell
# 5.1 writes entry names with backslashes, which zip readers on the IDE side
# do not treat as folders.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$zip = [System.IO.Compression.ZipFile]::Open($vsixPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in @(@('[Content_Types].xml', $contentTypes), @('extension.vsixmanifest', $manifest))) {
        $writer = New-Object System.IO.StreamWriter($zip.CreateEntry($entry[0]).Open(), $utf8NoBom)
        $writer.Write($entry[1])
        $writer.Dispose()
    }
    foreach ($file in $payload) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path $sourceDir $file), "extension/$file") | Out-Null
    }
}
finally {
    $zip.Dispose()
}
Write-Output "Built $vsixPath"

if ($Install) {
    $pluginsDir = Join-Path $env:USERPROFILE '.arduinoIDE\plugins'
    New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
    # An older version left beside the new one would load as a second copy.
    Get-ChildItem -Path $pluginsDir -Filter "$name-*.vsix" | Remove-Item -Force
    # The IDE loads plugins from its unpacked copies in deployedPlugins, not
    # from the .vsix, and keeps loading a copy whose .vsix is gone. Clearing
    # them makes it unpack this build fresh at the next start.
    $deployedDir = Join-Path $env:USERPROFILE '.arduinoIDE\deployedPlugins'
    if (Test-Path $deployedDir) {
        Get-ChildItem -Path $deployedDir -Directory -Filter "$name-*" | Remove-Item -Recurse -Force
    }
    Copy-Item -Path $vsixPath -Destination $pluginsDir
    Write-Output "Installed into $pluginsDir. Restart Arduino IDE to load it."
}
