param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$dbmRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $dbmRoot
try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Test frontend non riusciti.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build frontend non riuscita.' }
    & cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
    if ($LASTEXITCODE -ne 0) { throw 'Test Rust non riusciti.' }
    if ($Desktop) {
        & cargo check --manifest-path src-tauri/Cargo.toml --locked
        if ($LASTEXITCODE -ne 0) { throw 'Verifica desktop non riuscita.' }
    }
} finally { Pop-Location }
