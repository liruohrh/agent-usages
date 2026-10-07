<#
One-line install for Windows / PowerShell 5.1+:

  irm https://raw.githubusercontent.com/liruohrh/agent-usages/refs/heads/master/scripts/install.ps1 | iex

Three steps and nothing else, mirroring install.sh one for one: find a Node (>= 22.18;
it says how to get one, it never installs one), download install.mjs, and run it with
**your arguments passed through untouched**. There is deliberately no `param()` block -
`$args` forwards whatever came in, so `--version 0.0.3`, `--prefix D:\somewhere` and
`--help` all reach install.mjs exactly as written, and PowerShell cannot mistake
`-version` for one of its own parameters. Which also means this file is optional:

  irm https://raw.githubusercontent.com/liruohrh/agent-usages/refs/heads/master/scripts/install.mjs -OutFile install.mjs
  node install.mjs --help

Two different defaults, deliberately: **this script comes from `master`** (an installer
fix ships as soon as it is pushed, no release needed), while the package it installs
comes from the **latest release** (built, tested, carrying `dist/` and `web/dist/`).
That second default lives in install.mjs. `$env:AGENT_USAGES_BASE_URL` overrides both
halves at once, which is what a mirror or a local test server sets.

Why every message here is ASCII: Windows PowerShell 5.1 decodes a .ps1 file with the
machine's ANSI code page unless the file starts with a UTF-8 BOM, and a BOM in the text
piped into `iex` is one more thing that can go wrong. So the wrapper stays 7-bit while
install.mjs (always read as UTF-8 by Node) carries the Chinese text.
#>

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw 'install.ps1: PowerShell 5.1 or newer is required.'
}

$DefaultBase = 'https://raw.githubusercontent.com/liruohrh/agent-usages/refs/heads/master/scripts'
$MinNode = 22018

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

# `exit` inside `iex` would close the user's PowerShell window, so an exit code is only
# returned when this really is a script file (CI does `pwsh -File`); a piped one-liner
# reports the failure instead.
function Exit-With([int]$Code) {
  if ($PSCommandPath) { exit $Code }
  Fail "the installer exited with code $Code"
}

$Base = $env:AGENT_USAGES_BASE_URL
if (-not $Base) { $Base = $DefaultBase }
$Base = $Base.TrimEnd('/')
if (-not $Base) { Fail 'AGENT_USAGES_BASE_URL must not be empty.' }

# --- Node ---------------------------------------------------------------------

$node = $env:AGENT_USAGES_NODE
if (-not $node) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $found) { Show-NodeHelp 'node was not found in PATH.' }
  $node = $found.Path
  if (-not $node) { $node = $found.Source }
  if (-not $node) { $node = $found.Definition }
}

# "We got a version string" is the sign that this node works - deliberately not
# `$LASTEXITCODE`: capturing a native command through `Select-Object -First 1` stops the
# pipeline, and the exit code came back empty in a pwsh 7.6 + Node 22 container while
# node was working fine (2026-10-07). `@(...)` collects the output without a pipeline.
$probe = @()
try { $probe = @(& $node -p 'process.versions.node' 2>$null) } catch { }
$nodeVersion = ''
if ($probe.Count -gt 0) { $nodeVersion = ([string]$probe[0]).Trim() }
if (-not $nodeVersion) { Show-NodeHelp "cannot run '$node' (it does not look like a usable node)." }

$parsed = [regex]::Match($nodeVersion, '^(\d+)\.(\d+)')
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
    Fail "download failed: $url`n  $($_.Exception.Message)`n  (no network, or a wrong mirror? set `$env:AGENT_USAGES_BASE_URL)"
  }
  if (-not (Test-Path -LiteralPath $installer) -or (Get-Item -LiteralPath $installer).Length -eq 0) {
    Fail "downloaded an empty file: $url"
  }

  Write-Host "using $node (Node $nodeVersion), base $Base"
  # `@args` is every argument this script received, untouched.
  & $node $installer @args
  $succeeded = $?
  # A native command's code is `$LASTEXITCODE`, but it can be empty (see the probe
  # above), so fall back to `$?` rather than reporting success for a failure.
  if ($LASTEXITCODE) { $code = [int]$LASTEXITCODE } elseif (-not $succeeded) { $code = 1 }
} finally {
  # The temp copy of the installer never outlives this script, success or not.
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($code -ne 0) { Exit-With $code }
if ($PSCommandPath) { exit $code }
