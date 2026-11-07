[CmdletBinding(DefaultParameterSetName = "Install")]
param(
  [Parameter(ParameterSetName = "Check")]
  [switch]$Check,

  [Parameter(ParameterSetName = "Remove")]
  [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:BeginMarker = "<!-- BEGIN DAFEIYU-MEMORY MANAGED BLOCK -->"
$script:EndMarker = "<!-- END DAFEIYU-MEMORY MANAGED BLOCK -->"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)

function Get-DshHome {
  $configuredHome = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($configuredHome)) {
    $userProfile = [Environment]::GetFolderPath("UserProfile")
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
      throw "Unable to resolve the user profile for the default DSH_HOME."
    }
    $configuredHome = Join-Path $userProfile ".dsh"
  }

  $expandedHome = [Environment]::ExpandEnvironmentVariables($configuredHome.Trim())
  if ($expandedHome -eq "~") {
    $expandedHome = [Environment]::GetFolderPath("UserProfile")
  } elseif ($expandedHome.StartsWith("~\")) {
    $expandedHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) $expandedHome.Substring(2)
  } elseif ($expandedHome.StartsWith("~/")) {
    $expandedHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) $expandedHome.Substring(2)
  }

  if (-not [IO.Path]::IsPathRooted($expandedHome)) {
    throw "DSH_HOME must resolve to an absolute path; found '$expandedHome'."
  }

  return [IO.Path]::GetFullPath($expandedHome)
}

function Read-Utf8Text {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [IO.File]::ReadAllText($Path, $script:Utf8NoBom)
}

function Normalize-LineEndings {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

  return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Get-ManagedMatch {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

  $escapedBegin = [regex]::Escape($script:BeginMarker)
  $escapedEnd = [regex]::Escape($script:EndMarker)
  $beginCount = [regex]::Matches($Text, "(?m)^$escapedBegin[ \t]*\r?$").Count
  $endCount = [regex]::Matches($Text, "(?m)^$escapedEnd[ \t]*\r?$").Count

  if ($beginCount -ne $endCount) {
    throw "Managed block markers are unbalanced: $beginCount begin marker(s), $endCount end marker(s)."
  }
  if ($beginCount -gt 1) {
    throw "Managed block is duplicated ($beginCount copies). Refusing to modify an ambiguous file."
  }
  if ($beginCount -eq 0) {
    return $null
  }

  $pattern = "(?ms)^$escapedBegin\r?\n(?<body>.*?)\r?\n$escapedEnd(?:\r?\n|\z)"
  $match = [regex]::Match($Text, $pattern)
  if (-not $match.Success) {
    throw "Managed block markers exist but the block is malformed."
  }

  return $match
}

function Get-TemplateBlock {
  $templatePath = Join-Path (Split-Path -Parent $PSScriptRoot) "dafeiyu-memory.AGENTS.md"
  if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw "Instruction template not found: $templatePath"
  }

  $templateText = Normalize-LineEndings (Read-Utf8Text $templatePath)
  $templateWithoutTrailingNewline = $templateText.TrimEnd("`n")
  if (-not $templateWithoutTrailingNewline.StartsWith("$($script:BeginMarker)`n")) {
    throw "Instruction template must begin with the managed begin marker: $templatePath"
  }
  if (-not $templateWithoutTrailingNewline.EndsWith("`n$($script:EndMarker)")) {
    throw "Instruction template must end with the managed end marker: $templatePath"
  }

  $managedBlock = "$templateWithoutTrailingNewline`n"
  $match = Get-ManagedMatch $managedBlock
  if ($null -eq $match -or $match.Index -ne 0 -or $match.Length -ne $managedBlock.Length) {
    throw "Instruction template contains malformed or extra content outside the managed block: $templatePath"
  }

  return $managedBlock
}

function Add-ManagedBlock {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExistingText,
    [Parameter(Mandatory = $true)][string]$ManagedBlock
  )

  if ($ExistingText.Length -eq 0) {
    return $ManagedBlock
  }

  $newline = if ($ExistingText.Contains("`r`n")) { "`r`n" } else { "`n" }
  $fileBlock = $ManagedBlock.Replace("`n", $newline)
  if ($ExistingText.EndsWith("$newline$newline")) {
    return "$ExistingText$fileBlock"
  }
  if ($ExistingText.EndsWith($newline)) {
    return "$ExistingText$newline$fileBlock"
  }
  return "$ExistingText$newline$newline$fileBlock"
}

function Write-Utf8Atomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
  )

  $directory = [IO.Path]::GetDirectoryName($Path)
  if ([string]::IsNullOrWhiteSpace($directory)) {
    throw "Target path has no parent directory: $Path"
  }
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $suffix = [Guid]::NewGuid().ToString("N")
  $tempPath = Join-Path $directory ".AGENTS.md.$suffix.tmp"
  $backupPath = Join-Path $directory ".AGENTS.md.$suffix.bak"
  try {
    [IO.File]::WriteAllText($tempPath, $Text, $script:Utf8NoBom)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
    } else {
      [IO.File]::Move($tempPath, $Path)
    }
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  $dshHome = Get-DshHome
  $agentsPath = [IO.Path]::GetFullPath((Join-Path $dshHome "AGENTS.md"))
  Write-Host "[dafeiyu-memory] AGENTS.md: $agentsPath"

  $managedBlock = Get-TemplateBlock
  $exists = Test-Path -LiteralPath $agentsPath -PathType Leaf
  if ((Test-Path -LiteralPath $agentsPath) -and -not $exists) {
    throw "Target exists but is not a file: $agentsPath"
  }
  $existingText = if ($exists) { Read-Utf8Text $agentsPath } else { "" }
  $match = Get-ManagedMatch $existingText
  $installedBlock = if ($null -ne $match) { Normalize-LineEndings $match.Value } else { "" }

  if ($Check) {
    if (-not $exists -or $null -eq $match) {
      throw "Memory instructions are not installed in $agentsPath"
    }
    if ($installedBlock -cne $managedBlock) {
      throw "Memory instructions are installed but out of date in $agentsPath"
    }
    Write-Host "[dafeiyu-memory] Check passed: managed block is installed and current."
    exit 0
  }

  if ($Remove) {
    if ($null -eq $match) {
      Write-Host "[dafeiyu-memory] Managed block is not installed; nothing to remove."
      exit 0
    }

    $updatedText = $existingText.Remove($match.Index, $match.Length)
    Write-Utf8Atomically $agentsPath $updatedText
    Write-Host "[dafeiyu-memory] Removed managed block."
    exit 0
  }

  if ($null -eq $match) {
    Write-Utf8Atomically $agentsPath (Add-ManagedBlock $existingText $managedBlock)
    Write-Host "[dafeiyu-memory] Installed managed block."
    exit 0
  }

  if ($installedBlock -ceq $managedBlock) {
    Write-Host "[dafeiyu-memory] Managed block is already current; no changes written."
    exit 0
  }

  $newline = if ($existingText.Contains("`r`n")) { "`r`n" } else { "`n" }
  $fileBlock = $managedBlock.Replace("`n", $newline)
  $updatedText = $existingText.Remove($match.Index, $match.Length).Insert($match.Index, $fileBlock)
  Write-Utf8Atomically $agentsPath $updatedText
  Write-Host "[dafeiyu-memory] Updated managed block."
  exit 0
} catch {
  [Console]::Error.WriteLine("[dafeiyu-memory] ERROR: $($_.Exception.Message)")
  exit 1
}
