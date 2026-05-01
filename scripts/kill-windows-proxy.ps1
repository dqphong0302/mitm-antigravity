#Requires -Version 5.1

[CmdletBinding()]
param(
    [int]$Port = 443,
    [switch]$ForcePortOwner,
    [switch]$NoElevate,
    [string]$TaskName = "MITM Antigravity Proxy"
)

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Write-Error "This script is Windows-only."
    exit 1
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $NoElevate -and -not (Test-IsAdministrator)) {
    $argsList = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-Port", "$Port"
    )
    if ($ForcePortOwner) {
        $argsList += "-ForcePortOwner"
    }
    if ($TaskName -ne "MITM Antigravity Proxy") {
        $argsList += @("-TaskName", "`"$TaskName`"")
    }

    try {
        $child = Start-Process -FilePath "powershell.exe" -ArgumentList $argsList -Verb RunAs -Wait -PassThru
        exit $child.ExitCode
    } catch {
        Write-Error "Failed to relaunch as Administrator: $($_.Exception.Message)"
        exit 1
    }
}

function Get-PortOwnerIds {
    param([int]$ListenPort)

    try {
        $ids = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -and $_ -gt 0 }
        return @($ids | Sort-Object -Unique)
    } catch {
        return @()
    }
}

function Get-ProcessRows {
    param([int[]]$Ids)

    $rows = @()
    foreach ($itemId in @($Ids | Sort-Object -Unique)) {
        try {
            $row = Get-CimInstance Win32_Process -Filter "ProcessId = $itemId" -ErrorAction SilentlyContinue
            if ($null -ne $row) {
                $rows += $row
            }
        } catch {
        }
    }
    return @($rows)
}

function Test-KnownMitmExecutable {
    param($ProcessRow)

    $name = [string]$ProcessRow.Name
    $cmd = [string]$ProcessRow.CommandLine
    return "$name $cmd" -match "(?i)(mitm-ag-backend|mitm-antigravity|MITM AG)"
}

function Test-MitmProxyProcess {
    param(
        $ProcessRow,
        [int]$ListenPort
    )

    $name = [string]$ProcessRow.Name
    $cmd = [string]$ProcessRow.CommandLine
    $haystack = "$name $cmd"

    if ($haystack -notmatch "(?i)(mitm-ag-backend|mitm-antigravity|MITM AG|index\.js)") {
        return $false
    }
    if ($cmd -notmatch "(?i)(^|\s)start(\s|$)" -and $cmd -notmatch "(?i)\sstart\s+--skip-setup") {
        return $false
    }
    if ($cmd -match "(?i)(^|\s)gui(\s|$)") {
        return $false
    }

    if ($cmd -notmatch "(?i)--port") {
        return ($ListenPort -eq 443)
    }

    $portPattern = '(?i)--port(?:=|\s+)' + [regex]::Escape([string]$ListenPort) + '(\s|"|$)'
    return ($cmd -match $portPattern)
}

function Get-MitmProxyRows {
    param([int]$ListenPort)

    try {
        $rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { Test-MitmProxyProcess -ProcessRow $_ -ListenPort $ListenPort }
        return @($rows)
    } catch {
        return @()
    }
}

function Format-ProcessRow {
    param($ProcessRow)

    $name = [string]$ProcessRow.Name
    if (-not $name) {
        $name = "unknown"
    }
    return "$name#$($ProcessRow.ProcessId)"
}

function Stop-ProcessTree {
    param(
        [int]$TargetId,
        [string]$Reason
    )

    if ($TargetId -eq $PID) {
        return
    }

    Write-Host "Killing PID $TargetId ($Reason)"
    & taskkill.exe /PID $TargetId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Process -Id $TargetId -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Stopping scheduled task: $TaskName"
try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
} catch {
    Write-Warning "Could not stop scheduled task '$TaskName': $($_.Exception.Message)"
}

$targetIds = New-Object "System.Collections.Generic.HashSet[int]"

$knownRows = @(Get-MitmProxyRows -ListenPort $Port)
foreach ($row in $knownRows) {
    [void]$targetIds.Add([int]$row.ProcessId)
}

$portOwnerIds = @(Get-PortOwnerIds -ListenPort $Port)
$portRows = @(Get-ProcessRows -Ids $portOwnerIds)
foreach ($row in $portRows) {
    $isMitm = Test-MitmProxyProcess -ProcessRow $row -ListenPort $Port
    $isKnownExe = Test-KnownMitmExecutable -ProcessRow $row
    if ($ForcePortOwner -or $isMitm -or $isKnownExe) {
        [void]$targetIds.Add([int]$row.ProcessId)
    }
}

if ($targetIds.Count -eq 0) {
    if ($portRows.Count -gt 0) {
        $owners = ($portRows | ForEach-Object { Format-ProcessRow -ProcessRow $_ }) -join ", "
        Write-Warning "Port $Port is still owned by non-MITM process(es): $owners"
        Write-Warning "Run with -ForcePortOwner only if you want to kill those process(es)."
        exit 2
    }

    Write-Host "No MITM proxy process found on port $Port."
    exit 0
}

foreach ($targetId in @($targetIds | Sort-Object)) {
    Stop-ProcessTree -TargetId $targetId -Reason "MITM proxy"
}

for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 300
    $remainingIds = @(Get-PortOwnerIds -ListenPort $Port)
    if ($remainingIds.Count -eq 0) {
        Write-Host "Port $Port is free."
        exit 0
    }
}

$remainingRows = @(Get-ProcessRows -Ids (Get-PortOwnerIds -ListenPort $Port))
$remaining = ($remainingRows | ForEach-Object { Format-ProcessRow -ProcessRow $_ }) -join ", "
if (-not $remaining) {
    $remaining = "unknown"
}
Write-Warning "Port $Port is still busy: $remaining"
exit 2
