$ErrorActionPreference = 'Stop'
$dbmRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$dbmVersion = (Get-Content -Raw -LiteralPath (Join-Path $dbmRoot 'package.json') | ConvertFrom-Json).version
foreach ($dbmRelative in @("releases/$dbmVersion/portable/Database Manager/Database Manager.exe", 'src-tauri/target/release/database-manager.exe')) {
    $dbmFile = Join-Path $dbmRoot $dbmRelative
    if ((Test-Path -LiteralPath $dbmFile -PathType Leaf) -and (Get-Item -LiteralPath $dbmFile).VersionInfo.ProductVersion -eq $dbmVersion) {
        Start-Process -FilePath $dbmFile -WorkingDirectory $dbmRoot
        exit 0
    }
}
Write-Output "Compilazione $dbmVersion necessaria. Avvio ambiente di sviluppo."
exit 3
