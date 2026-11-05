[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$applicationRoot = Join-Path $projectRoot 'app'
$runtimeRoot = Join-Path $projectRoot 'runtime'
$entryPath = Join-Path $PSScriptRoot 'run.mjs'
$statePath = Join-Path $runtimeRoot 'local-service.json'
$databasePath = Join-Path $applicationRoot 'data\crm.sqlite'
$baseUri = 'http://127.0.0.1:3100'
$servicePort = 3100
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

function Get-OwnedService {
    param([switch]$StrictOwnership)
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    $savedState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $serviceProcessId = [int]$savedState.processId
    if ($serviceProcessId -le 0) { throw 'Invalid local service process ID.' }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $serviceProcessId" -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    $creationTime = $candidate.CreationDate.ToUniversalTime().ToString('o')
    if ($candidate.ExecutablePath -ne $savedState.nodePath -or
        $creationTime -ne $savedState.creationTimeUtc -or
        -not $candidate.CommandLine -or
        $candidate.CommandLine.IndexOf($entryPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        if ($StrictOwnership) { throw 'Process ownership mismatch. No process was stopped or replaced.' }
        return $null
    }
    return $candidate
}

function Get-Health {
    try {
        return Invoke-RestMethod -Uri ($baseUri + '/api/health') -TimeoutSec 2
    } catch {
        return $null
    }
}

function Get-Listeners {
    return @(Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue)
}

function Write-ServiceStatus {
    $ownedService = Get-OwnedService
    $health = Get-Health
    $listeners = @(Get-Listeners)
    $verifiedListeners = @($listeners | Where-Object {
        $ownedService -and $_.OwningProcess -eq $ownedService.ProcessId -and $_.LocalAddress -eq '127.0.0.1'
    })
    $running = [bool]($ownedService -and $verifiedListeners.Count -gt 0 -and
        $health -and $health.ok -eq $true -and $health.demo -eq $false -and $health.version -eq '2.1.0')
    [pscustomobject]@{
        running = $running
        processId = $(if ($ownedService) { $ownedService.ProcessId } else { $null })
        url = $baseUri
        mode = 'local production / DingTalk login'
        database = $databasePath
        databaseExists = Test-Path -LiteralPath $databasePath
        health = $health
    } | ConvertTo-Json -Depth 4
}

if ($Action -eq 'Status') {
    Write-ServiceStatus
    exit 0
}

if ($Action -eq 'Stop') {
    $ownedService = Get-OwnedService -StrictOwnership
    if ($ownedService) {
        Stop-Process -Id $ownedService.ProcessId -ErrorAction Stop
        Wait-Process -Id $ownedService.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        if (Get-OwnedService) { throw 'The local service did not stop.' }
    }
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
    Write-Output 'Qianfan CRM local service stopped. The database is preserved.'
    exit 0
}

$startupLock = $null
try {
    $startupLock = [System.IO.File]::Open(
        (Join-Path $runtimeRoot 'startup.lock'),
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $ownedService = Get-OwnedService
    if ($ownedService) {
        $health = Get-Health
        if (-not $health -or $health.ok -ne $true -or $health.demo -ne $false -or $health.version -ne '2.1.0') {
            throw 'The existing owned process is unhealthy. Inspect runtime logs, then stop this project before restarting.'
        }
        Write-ServiceStatus
        exit 0
    }
    $listeners = @(Get-Listeners)
    if ($listeners.Count -gt 0) { throw 'Port 3100 is already in use. No existing service was changed.' }

    $nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $nodeMajor = [int]((& $nodePath --version).TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutPath = Join-Path $runtimeRoot ("server-$stamp.stdout.log")
    $stderrPath = Join-Path $runtimeRoot ("server-$stamp.stderr.log")
    $serviceProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $entryPath + '"')) `
        -WorkingDirectory $applicationRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $createdProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $serviceProcess.Id)
    if (-not $createdProcess) { throw "The local service exited during startup. Inspect $stderrPath" }
    $healthy = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $serviceProcess.Refresh()
        if ($serviceProcess.HasExited) { break }
        $health = Get-Health
        if ($health -and $health.ok -eq $true -and $health.demo -eq $false -and $health.version -eq '2.1.0') {
            $matchingListeners = @(Get-Listeners | Where-Object {
                $_.OwningProcess -eq $serviceProcess.Id -and $_.LocalAddress -eq '127.0.0.1'
            })
            if ($matchingListeners.Count -gt 0) { $healthy = $true; break }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $healthy) {
        $serviceProcess.Refresh()
        if (-not $serviceProcess.HasExited) { Stop-Process -Id $serviceProcess.Id }
        throw "The local service failed its startup health check. Inspect $stderrPath"
    }
    [pscustomobject]@{
        processId = $serviceProcess.Id
        nodePath = $createdProcess.ExecutablePath
        entryPath = $entryPath
        creationTimeUtc = $createdProcess.CreationDate.ToUniversalTime().ToString('o')
        url = $baseUri
        database = $databasePath
        stdout = $stdoutPath
        stderr = $stderrPath
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-ServiceStatus
} finally {
    if ($startupLock) { $startupLock.Dispose() }
}
