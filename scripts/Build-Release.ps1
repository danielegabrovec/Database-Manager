param(
    [switch]$PackageOnly,
    [string]$ReportPath = 'docs/REPORT-0.6.0.md'
)
$ErrorActionPreference = 'Stop'
$dbmRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
Push-Location -LiteralPath $dbmRoot
try {
    $dbmVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
    if ($dbmVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Versione non valida.' }
    $dbmArtifacts = Join-Path $dbmRoot ('artifacts/release-v' + $dbmVersion.Replace('.', ''))
    $dbmReport = (Resolve-Path -LiteralPath $ReportPath).Path
    $dbmReportName = Split-Path -Leaf $dbmReport
    $dbmTarget = Join-Path $dbmRoot 'artifacts/public-release-target'
    $dbmCommit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Identificazione del commit non riuscita.' }
    $dbmStamp = Join-Path $dbmTarget 'release/dbm-public-build.json'
    if (-not $PackageOnly) {
        $env:CARGO_TARGET_DIR = $dbmTarget
        $env:CARGO_ENCODED_RUSTFLAGS = '--remap-path-prefix=' + $dbmRoot + '=/source/database-manager' + [char]31 + '--remap-path-prefix=' + [Environment]::GetFolderPath('UserProfile') + '=/build/user'
        & npm.cmd run tauri -- build --ci --bundles nsis -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'Build desktop non riuscita.' }
        @{commit=$dbmCommit;version=$dbmVersion;clean=[bool](-not (git status --porcelain))} | ConvertTo-Json | Set-Content -LiteralPath $dbmStamp -Encoding utf8
    } elseif (-not (Test-Path -LiteralPath $dbmStamp)) {
        throw 'Manca la ricevuta di compilazione del pacchetto.'
    }
    $dbmBuild = Get-Content -LiteralPath $dbmStamp -Raw | ConvertFrom-Json
    if ($dbmBuild.commit -ne $dbmCommit -or $dbmBuild.version -ne $dbmVersion -or -not $dbmBuild.clean -or (git status --porcelain)) { throw 'Compilare da un commit pulito con la versione richiesta.' }
    $dbmRelease = Join-Path $dbmRoot ('releases/' + $dbmVersion)
    $dbmPortable = Join-Path $dbmRelease 'portable/Database Manager'
    New-Item -ItemType Directory -Path (Join-Path $dbmPortable 'legal/licenses') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $dbmTarget 'release/database-manager.exe') -Destination (Join-Path $dbmPortable 'Database Manager.exe')
    $dbmInstallerName = 'Database-Manager_' + $dbmVersion + '_windows-x64-setup.exe'
    Copy-Item -LiteralPath (Join-Path $dbmTarget ('release/bundle/nsis/Database Manager_' + $dbmVersion + '_x64-setup.exe')) -Destination (Join-Path $dbmRelease $dbmInstallerName)
    Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $dbmPortable 'legal/LICENSE.txt')
    Copy-Item -LiteralPath 'LEGAL.md' -Destination (Join-Path $dbmPortable 'legal/NOTE-LEGALI.md')
    Copy-Item -LiteralPath 'PRIVACY.md','THIRD-PARTY-NOTICES.md' -Destination (Join-Path $dbmPortable 'legal')
    Copy-Item -Path 'licenses/*' -Destination (Join-Path $dbmPortable 'legal/licenses') -Recurse -Force
    Copy-Item -LiteralPath 'docs/GUIDA-OPERATIVA-POWERSHELL-QUERY.md' -Destination (Join-Path $dbmPortable 'GUIDA-OPERATIVA.md')
    Copy-Item -LiteralPath 'docs/WORKBENCH-0.6.0.md' -Destination (Join-Path $dbmPortable 'GUIDA-PROGETTI-E-AI.md')
    Copy-Item -LiteralPath 'docs/MATRICE-0.6.0.md','docs/CODEGEN-VERIFICA.md','docs/REPORT-WORKBENCH-20261117.md',$dbmReport -Destination $dbmPortable
    $dbmReadme = @"
Database Manager $dbmVersion - Daniele Gabrovec

Windows x64. Estrarre l'intera cartella prima di avviare Database Manager.exe.
Richiede Microsoft Edge WebView2. Chiudere altre istanze dell'app prima dell'avvio.
Il workspace ordinario e in %LOCALAPPDATA%\DatabaseManager.

La cartella legal contiene licenza, privacy, avvisi e testi dei componenti di terzi.
GUIDA-OPERATIVA.md contiene i comandi PowerShell e le query spiegate.
GUIDA-PROGETTI-E-AI.md descrive progetti multidatabase, integrazione nel codice e Ollama.
Nell'app: Guida nella barra inferiore, Catalogo PowerShell, Designer database.

Installer non firmato digitalmente. Non sono inclusi server, client o runtime dei
programmi generati. Il pacchetto non installa automaticamente tali strumenti.
Repository: https://github.com/danielegabrovec/Database-Manager
"@
    Set-Content -LiteralPath (Join-Path $dbmPortable 'LEGGIMI.txt') -Value $dbmReadme -Encoding utf8
    & python scripts/scan-publication.py --output (Join-Path $dbmArtifacts 'publication-final') --assets (Join-Path $dbmPortable 'Database Manager.exe') (Join-Path $dbmRelease $dbmInstallerName)
    if ($LASTEXITCODE -ne 0) { throw 'Scansione di pubblicazione non riuscita: il pacchetto non va pubblicato.' }
    $dbmZipName = 'Database-Manager_' + $dbmVersion + '_windows-x64-portable.zip'
    Compress-Archive -LiteralPath $dbmPortable -DestinationPath (Join-Path $dbmRelease $dbmZipName) -Force
    Copy-Item -LiteralPath (Join-Path $dbmArtifacts 'third-party-mpl-sources.zip') -Destination $dbmRelease
    Copy-Item -LiteralPath 'docs/GUIDA-OPERATIVA-POWERSHELL-QUERY.md','docs/WORKBENCH-0.6.0.md','docs/MATRICE-0.6.0.md',$dbmReport -Destination $dbmRelease
    $dbmAssetNames = @($dbmInstallerName,$dbmZipName,'third-party-mpl-sources.zip','GUIDA-OPERATIVA-POWERSHELL-QUERY.md','WORKBENCH-0.6.0.md','MATRICE-0.6.0.md',$dbmReportName)
    $dbmAssets = @(foreach ($dbmAsset in $dbmAssetNames) {
        $dbmPath = Join-Path $dbmRelease $dbmAsset
        [ordered]@{name=$dbmAsset;bytes=(Get-Item -LiteralPath $dbmPath).Length;sha256=(Get-FileHash -LiteralPath $dbmPath -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
    [ordered]@{version=$dbmVersion; sourceCommit=$dbmCommit; platform='Windows x64'; codeSigned=$false; assets=$dbmAssets} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $dbmRelease 'manifest.json') -Encoding utf8
    $dbmSums = foreach ($dbmAsset in ($dbmAssetNames + 'manifest.json')) { (Get-FileHash -LiteralPath (Join-Path $dbmRelease $dbmAsset) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $dbmAsset }
    Set-Content -LiteralPath (Join-Path $dbmRelease 'SHA256SUMS.txt') -Value $dbmSums -Encoding ascii
    Write-Output ('Pacchetto pronto: ' + $dbmRelease)
} finally { Pop-Location }
