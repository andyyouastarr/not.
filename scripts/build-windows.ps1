param([ValidateSet('test','dev','bundle','build-debug','build-smoke','check')][string]$Mode='bundle')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$nativePerl=Join-Path $projectRoot '.tools\native-perl\perl\bin'
if (Test-Path -LiteralPath (Join-Path $nativePerl 'perl.exe')) { $env:PATH=$nativePerl+';'+$env:PATH }
$env:LANG='C'
$env:LC_ALL='C'
$env:LC_CTYPE='C'
# MSVC preprocessing emits legacy-encoded paths. An ASCII alias prevents
# openssl-sys from rejecting paths containing a Cyrillic Windows username.
$shortRoot=(cmd /c "for %I in (`"$projectRoot`") do @echo %~sI").Trim()
$cachedOpenSsl=Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src-tauri\target\debug\build') -Directory -Filter 'openssl-sys-*' -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'out\openssl-build\install\lib\libcrypto.lib') } | Select-Object -First 1
if ($cachedOpenSsl) {
 $relativeOpenSsl=$cachedOpenSsl.FullName.Substring($projectRoot.Length)
 $env:OPENSSL_DIR=$shortRoot+$relativeOpenSsl+'\out\openssl-build\install'
 $env:OPENSSL_NO_VENDOR='1'
 $env:OPENSSL_STATIC='1'
}
elseif ($shortRoot -notmatch '[^\x00-\x7F]') {
 $env:CARGO_TARGET_DIR=Join-Path $shortRoot 'src-tauri\target'
}
if (-not (Get-Command perl -ErrorAction SilentlyContinue)) { throw 'Install native Strawberry Perl, or run python scripts/perl-runtime.py. Git MSYS Perl cannot build MSVC OpenSSL.' }
switch($Mode) {
 'test' { cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib -- --nocapture }
 'dev' { npm run tauri -- dev }
 'build-debug' { cargo build --locked --offline --manifest-path src-tauri/Cargo.toml }
 'build-smoke' {
   npm run build
   if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
   cargo build --locked --offline --manifest-path src-tauri/Cargo.toml --features custom-protocol
 }
 'check' { cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings }
 'bundle' {
   npm run tauri -- build -- --offline
   if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
   & (Join-Path $PSScriptRoot 'prepare-release.ps1')
 }
}
exit $LASTEXITCODE
