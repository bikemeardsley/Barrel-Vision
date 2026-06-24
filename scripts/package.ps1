# Package Barrel Vision for store upload.
# Zips the CONTENTS of src/ so manifest.json sits at the zip root (what Edge/Chrome expect).
# Output: barrel-vision-<version>.zip at the repo root (gitignored).
#
#   pwsh scripts/package.ps1

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $repo "src"

$manifest = Get-Content (Join-Path $src "manifest.json") -Raw | ConvertFrom-Json
$version  = $manifest.version
$out      = Join-Path $repo "barrel-vision-$version.zip"

if (Test-Path $out) { Remove-Item $out }

# -Path "src\*" zips the items inside src (manifest.json, *.js, *.css, *.html, shared/, icons/)
# at the archive root, not a nested src/ folder.
Compress-Archive -Path (Join-Path $src "*") -DestinationPath $out

Write-Host "Wrote $out (v$version)"
Write-Host "Sanity check: the first entry in the zip should be manifest.json, not a 'src/' folder."
