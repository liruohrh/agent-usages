<#
One-line install for Windows / PowerShell 5.1+:

  irm https://github.com/liruohrh/agent-usages/releases/latest/download/install.ps1 | iex

This file does exactly two things, mirroring install.sh one for one: find a Node
(>= 22.18, and say how to get one instead of installing it), and fetch install.mjs
into a temp directory. Everything else (download, verify, `npm install -g`,
`--version`) happens in install.mjs, which is the same code on every platform.

Why every message here is ASCII: Windows PowerShell 5.1 decodes a .ps1 file with
the machine's ANSI code page unless the file starts with a UTF-8 BOM, and a BOM in
the text piped into `iex` is one more thing that can go wrong. So the wrapper stays
7-bit while install.mjs (always read as UTF-8 by Node) carries the Chinese text.

The URL above is a fixed asset name on `releases/latest/download`, re-uploaded by
every release, so publishing a version never edits this file or the docs that call it.
#>
[CmdletBinding()]
param(
  [string]$Base = $env:AGENT_USAGES_BASE_URL,
  [Alias('h')][switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$PassThru
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw 'install.ps1: PowerShell 5.1 or newer is required.'
}

$DefaultBase = 'https://github.com/liruohrh/agent-usages/releases/latest/download'
$MinNode = 22018  # major * 1000 + minor, so 22.18
$baseGiven = $PSBoundParameters.ContainsKey('Base')

function Show-Usage {
  @'
agent-usages installer (PowerShell 5.1+)

Usage:
  irm https://github.com/liruohrh/agent-usages/releases/latest/download/install.ps1 | iex

  # A specific version. `iex` takes no arguments, so create a script block:
  & ([scriptblock]::Create((irm https://github.com/liruohrh/agent-usages/releases/latest/download/install.ps1))) --version 0.0.3

  # A downloaded copy:
  .\install.ps1 --version 0.0.3

  # Local test / mirror: point the base elsewhere
  .\install.ps1 --base http://127.0.0.1:8931 --prefix "$env:TEMP\prefix"

This script only finds Node (>= 22.18; it tells you how to install one, it never
does) and downloads install.mjs; everything after that is install.mjs, which takes
the same options on every platform:

  --version <v|latest>   which release, default latest
  --tarball <path|url>   install this tarball directly (offline / CI)
  --prefix <dir>         install into <dir> instead of the npm global prefix
  --dry-run              print what would happen, write nothing
  -h, --help             that help, from the installer itself

Environment variables:
  AGENT_USAGES_NODE        which node to use (default: node from PATH)
  AGENT_USAGES_BASE_URL    same as --base; the command line wins
'@
}

function Fail([string]$Message) {
  throw "install.ps1: $Message"
}

function Show-NodeHelp([string]$Reason) {
  Fail @"
$Reason
Node >= 22.18 is required. Pick one way to install it, then reopen the terminal:
  - installer from https://nodejs.org/
  - mise:     mise use -g node@22
  - nvm:      nvm install 22; nvm use 22
  - winget:   winget install OpenJS.NodeJS.LTS
  - scoop:    scoop install nodejs-lts
  - or point the script at an existing node: `$env:AGENT_USAGES_NODE = 'C:\path\to\node.exe'
"@
}

# `exit` inside `iex` would close the user's PowerShell window, so an exit code is
# only returned when this really is a script file (CI does `pwsh -File`); a piped
# one-liner reports the failure instead.
function Exit-With([int]$Code) {
  if ($PSCommandPath) { exit $Code }
  Fail "the installer exited with code $Code"
}

# `-h` is a real parameter (alias) because PowerShell would otherwise read a
# single-dash token as its own parameter; `--help` reaches the pass-through list.
if ($Help) {
  Show-Usage
  if ($PSCommandPath) { exit 0 }
  return
}

# Split our own --base out of the pass-through arguments. PowerShell spells switches
# with a single dash, so `-version` is normalised to `--version` for install.mjs;
# `--version` is not a PowerShell parameter token and arrives here untouched.
$forward = @()
if ($null -ne $PassThru) {
  for ($i = 0; $i -lt $PassThru.Count; $i++) {
    $argument = $PassThru[$i]
    if ($argument -eq '--help' -or $argument -eq '/?') {
      Show-Usage
      if ($PSCommandPath) { exit 0 }
      return
    }
    if ($argument -match '^--base=(.*)$') {
      $Base = $Matches[1]
      $baseGiven = $true
      continue
    }
    if ($argument -eq '--base') {
      if ($i + 1 -ge $PassThru.Count) { Fail '--base needs a value' }
      $i++
      $Base = $PassThru[$i]
      $baseGiven = $true
      continue
    }
    if ($argument -match '^-[A-Za-z][A-Za-z-]*$') { $argument = "--$($argument.Substring(1))" }
    $forward += $argument
  }
}

if (-not $Base) {
  if ($baseGiven) { Fail '--base must not be empty' }
  $Base = $DefaultBase
}
$Base = $Base.TrimEnd('/')

# --- Node ---------------------------------------------------------------------

$node = $env:AGENT_USAGES_NODE
if (-not $node) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $found) { Show-NodeHelp 'node was not found in PATH.' }
  $node = $found.Path
  if (-not $node) { $node = $found.Source }
  if (-not $node) { $node = $found.Definition }
}

$nodeVersion = $null
$nodeOk = $false
try {
  $nodeVersion = (& $node -p 'process.versions.node' 2>$null | Select-Object -First 1)
  $nodeOk = ($LASTEXITCODE -eq 0)
} catch { }
if (-not $nodeOk -or -not $nodeVersion) {
  Show-NodeHelp "cannot run '$node' (it does not look like a usable node)."
}

$parsed = [regex]::Match([string]$nodeVersion, '^(\d+)\.(\d+)')
if (-not $parsed.Success) { Show-NodeHelp "cannot read a version out of '$nodeVersion'." }
$number = ([int]$parsed.Groups[1].Value * 1000) + [int]$parsed.Groups[2].Value
if ($number -lt $MinNode) { Show-NodeHelp "this is Node $nodeVersion." }

# --- install.mjs --------------------------------------------------------------

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('agent-usages-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$code = 0
try {
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
    # .NET on newer PowerShell negotiates TLS itself; nothing to do.
  }

  $url = "$Base/install.mjs"
  $installer = Join-Path $tmp 'install.mjs'
  try {
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
  } catch {
    Fail "download failed: $url`n  $($_.Exception.Message)`n  (no network, or a wrong base? try --base <url> or `$env:AGENT_USAGES_BASE_URL)"
  }
  if (-not (Test-Path -LiteralPath $installer) -or (Get-Item -LiteralPath $installer).Length -eq 0) {
    Fail "downloaded an empty file: $url"
  }

  Write-Host "using $node (Node $nodeVersion), base $Base"
  & $node $installer --base $Base @forward
  $code = $LASTEXITCODE
} finally {
  # The temp copy of the installer never outlives this script, success or not.
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($code -ne 0) { Exit-With $code }
if ($PSCommandPath) { exit $code }
