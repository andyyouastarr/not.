$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseVersion = [string]$config.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable x.y.z release version.' }
$sourcePath = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis\not. studio_${releaseVersion}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'Build the Windows installer before preparing a release.' }
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'releases'))
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$destination = Join-Path $releaseRoot "not-studio-${releaseVersion}-windows-x64-setup.exe"
Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Installer checksum mismatch. Previous installers were retained.' }
$installers = @(Get-ChildItem -LiteralPath $releaseRoot -File | Where-Object {
    $_.Name -match '^not-studio-\d+\.\d+\.\d+-windows-x64-setup\.exe$'
} | Sort-Object { [version]($_.Name -replace '^not-studio-','' -replace '-windows-x64-setup\.exe$','') } -Descending)
# Delete only recognized installer files directly inside this repository's
# releases directory. Never traverse folders or remove diaries/backups.
foreach ($old in ($installers | Select-Object -Skip 2)) {
    $resolved = [IO.Path]::GetFullPath($old.FullName)
    if ([IO.Path]::GetDirectoryName($resolved) -ne $releaseRoot) { throw 'Installer cleanup escaped the releases directory.' }
    Remove-Item -LiteralPath $resolved
    Write-Output "Removed old local installer: $($old.Name)"
}
$lines = @($installers | Select-Object -First 2 | ForEach-Object {
    "$( (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() )  $($_.Name)"
})
[IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'), ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
Write-Output "Local installers retained: $([Math]::Min(2, $installers.Count)); SHA256SUMS.txt updated."
