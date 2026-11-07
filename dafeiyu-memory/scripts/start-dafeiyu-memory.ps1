[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-StartupError {
  param([Parameter(Mandatory = $true)][string]$Message)
  [Console]::Error.WriteLine("[ERROR] $Message")
}

function Stop-Startup {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-StartupError $Message
  exit 1
}

function Expand-UserPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
  if ($expanded -eq "~") {
    return [Environment]::GetFolderPath("UserProfile")
  }
  if ($expanded.StartsWith("~\")) {
    $expanded = Join-Path ([Environment]::GetFolderPath("UserProfile")) $expanded.Substring(2)
  } elseif ($expanded.StartsWith("~/")) {
    $expanded = Join-Path ([Environment]::GetFolderPath("UserProfile")) $expanded.Substring(2)
  }
  return $expanded
}

function Invoke-MemoryInstructionsInstaller {
  param(
    [Parameter(Mandatory = $true)][string]$PowerShellPath,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [switch]$Check
  )

  $installerArguments = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $InstallerPath
  )
  if ($Check) {
    $installerArguments += "-Check"
  }

  & $PowerShellPath @installerArguments
  $installerExitCode = $LASTEXITCODE
  if ($installerExitCode -ne 0) {
    $mode = if ($Check) { "verification" } else { "installation" }
    Stop-Startup "Memory AGENTS.md $mode failed with exit code $installerExitCode."
  }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$cliEntry = Join-Path $repoRoot "apps\cli\lib\bin.js"
$overlayPath = Join-Path $pluginRoot "dafeiyu-memory.cordis.yml"
$distEntry = Join-Path $pluginRoot "dist\index.js"
$agentsInstaller = Join-Path $PSScriptRoot "install-agents-instructions.ps1"

if (-not (Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
  Stop-Startup "DSH CLI entry not found: $cliEntry. Build the DSH repository first."
}
if (-not (Test-Path -LiteralPath $overlayPath -PathType Leaf)) {
  Stop-Startup "DSH memory overlay not found: $overlayPath"
}
if (-not (Test-Path -LiteralPath $distEntry -PathType Leaf)) {
  Stop-Startup "Memory MCP build not found: $distEntry. Run 'npm run build' in $pluginRoot."
}
if ((Get-Item -LiteralPath $distEntry).Length -le 0) {
  Stop-Startup "Memory MCP build is empty: $distEntry. Run 'npm run build' in $pluginRoot."
}
if (($env:DAFEIYU_MEMORY_SKIP_AGENTS_INSTALL -ne "1") -and
    (-not (Test-Path -LiteralPath $agentsInstaller -PathType Leaf))) {
  Stop-Startup "Memory AGENTS.md installer not found: $agentsInstaller"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  Stop-Startup "node.exe was not found on PATH."
}
$nodePath = $nodeCommand.Source
$nodeVersion = (& $nodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch "^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)") {
  Stop-Startup "Unable to determine the installed Node.js version."
}
$nodeMajor = [int]$Matches.major
$nodeMinor = [int]$Matches.minor
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 19)) {
  Stop-Startup "Node.js 22.19 or newer is required; found $nodeVersion."
}

& $nodePath --check $distEntry
if ($LASTEXITCODE -ne 0) {
  Stop-Startup "Memory MCP build failed syntax validation: $distEntry"
}

if ($env:DAFEIYU_MEMORY_SKIP_AGENTS_INSTALL -eq "1") {
  Write-Warning "[dafeiyu-memory] WARNING: AGENTS.md install and verification were skipped because DAFEIYU_MEMORY_SKIP_AGENTS_INSTALL=1. The model may not know when to use memory tools."
} else {
  $windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($null -eq $windowsPowerShell) {
    Stop-Startup "Windows PowerShell was not found; unable to install AGENTS.md memory instructions."
  }
  Invoke-MemoryInstructionsInstaller `
    -PowerShellPath $windowsPowerShell.Source `
    -InstallerPath $agentsInstaller
  Invoke-MemoryInstructionsInstaller `
    -PowerShellPath $windowsPowerShell.Source `
    -InstallerPath $agentsInstaller `
    -Check
}

$dumpOutput = & $nodePath $cliEntry `
  --profile web `
  --patch $overlayPath `
  --dump-config 2>&1
if ($LASTEXITCODE -ne 0) {
  $dumpSummary = ($dumpOutput | Select-Object -Last 20) -join [Environment]::NewLine
  Stop-Startup "DSH overlay validation failed for '$overlayPath'.`n$dumpSummary"
}

$portText = $env:DAFEIYU_DSH_PORT
if ([string]::IsNullOrWhiteSpace($portText)) {
  $portText = "31789"
}
$port = 0
if (-not [int]::TryParse($portText.Trim(), [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
  Stop-Startup "DAFEIYU_DSH_PORT must be an integer from 1 to 65535; found '$portText'."
}

$databasePath = $env:DAFEIYU_MEMORY_DB
if ([string]::IsNullOrWhiteSpace($databasePath)) {
  $databasePath = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".dafeiyu-memory\memory.sqlite3"
} else {
  $databasePath = Expand-UserPath $databasePath
  if (-not [IO.Path]::IsPathRooted($databasePath)) {
    Stop-Startup "DAFEIYU_MEMORY_DB must be an absolute path; found '$databasePath'."
  }
}
$databasePath = [IO.Path]::GetFullPath($databasePath)
$databaseDirectory = Split-Path -Parent $databasePath
if ([string]::IsNullOrWhiteSpace($databaseDirectory)) {
  Stop-Startup "DAFEIYU_MEMORY_DB does not resolve to a file path: '$databasePath'."
}
try {
  New-Item -ItemType Directory -Path $databaseDirectory -Force | Out-Null
} catch {
  Stop-Startup "Unable to create the memory database directory '$databaseDirectory': $($_.Exception.Message)"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
try {
  $listener.Start()
} catch {
  Stop-Startup "Port $port is not available on 127.0.0.1: $($_.Exception.Message)"
} finally {
  if ($null -ne $listener) {
    $listener.Stop()
  }
}

$hadDatabaseOverride = Test-Path Env:DAFEIYU_MEMORY_DB
$previousDatabaseOverride = $env:DAFEIYU_MEMORY_DB
$hadServerEntry = Test-Path Env:DAFEIYU_MEMORY_SERVER_ENTRY
$previousServerEntry = $env:DAFEIYU_MEMORY_SERVER_ENTRY
$env:DAFEIYU_MEMORY_DB = $databasePath
$env:DAFEIYU_MEMORY_SERVER_ENTRY = $distEntry

try {
  Write-Host "[dafeiyu-memory] DSH web: http://127.0.0.1:$port"
  Write-Host "[dafeiyu-memory] Memory database: $databasePath"
  Write-Host "[dafeiyu-memory] Press Ctrl+C to stop DSH and the memory MCP server."
  Write-Host "[dafeiyu-memory] Starting DSH web with dafeiyu-memory overlay..."

  Push-Location $repoRoot
  try {
    & $nodePath $cliEntry `
      --profile web `
      --patch $overlayPath `
      --host 127.0.0.1 `
      --port $port `
      --no-open
    $nodeExitCode = $LASTEXITCODE
  } catch [System.Management.Automation.PipelineStoppedException] {
    $nodeExitCode = 130
  } finally {
    Pop-Location
  }
} catch {
  Stop-Startup "DSH web launch failed: $($_.Exception.Message)"
} finally {
  if ($hadDatabaseOverride) {
    $env:DAFEIYU_MEMORY_DB = $previousDatabaseOverride
  } else {
    Remove-Item Env:DAFEIYU_MEMORY_DB -ErrorAction SilentlyContinue
  }
  if ($hadServerEntry) {
    $env:DAFEIYU_MEMORY_SERVER_ENTRY = $previousServerEntry
  } else {
    Remove-Item Env:DAFEIYU_MEMORY_SERVER_ENTRY -ErrorAction SilentlyContinue
  }
}

if ($nodeExitCode -eq 0 -or $nodeExitCode -eq 130 -or $nodeExitCode -eq -1073741510) {
  exit 0
}

Write-StartupError "DSH web exited with code $nodeExitCode."
exit $nodeExitCode
