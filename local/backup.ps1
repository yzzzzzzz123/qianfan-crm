[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskApp=Join-Path $taskProject 'app'
$taskRuntime=Join-Path $taskProject 'runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$env:DB_PATH=Join-Path $taskApp 'data\crm.sqlite'
$taskNode=(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
Push-Location -LiteralPath $taskApp
try {
    $taskResult=& $taskNode '--disable-warning=ExperimentalWarning' 'scripts/backup.mjs' 2>&1
    if($LASTEXITCODE -ne 0){throw 'CRM production database backup failed.'}
    $taskResult | Set-Content -LiteralPath (Join-Path $taskRuntime 'production-backup.log') -Encoding UTF8
} finally { Pop-Location }
