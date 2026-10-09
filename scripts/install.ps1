# The `plip` command on Windows, for people who'd rather not touch a terminal twice:
#   irm https://raw.githubusercontent.com/hussainn7/plip-oss/main/scripts/install.ps1 | iex
#
# There is no signed Windows installer yet (see docs/WINDOWS.md); this is the supported way in.
# It installs uv, pins Python 3.12, and puts `plip` on PATH as a tool.
$ErrorActionPreference = 'Stop'

$repo   = if ($env:PLIP_REPO)   { $env:PLIP_REPO }   else { 'https://github.com/hussainn7/plip-oss.git' }
$python = if ($env:PLIP_PYTHON) { $env:PLIP_PYTHON } else { '3.12' }
$local  = Join-Path $env:USERPROFILE '.local\bin'
$env:PATH = "$local;$env:LOCALAPPDATA\Programs\uv;$env:PATH"

function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

if (-not (Have 'uv')) {
    Write-Host '==> installing uv'
    try {
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    } catch {
        Write-Host "Couldn't install uv: $_"
        Write-Host 'Install Python 3.12 from python.org (keep the tcl/tk option), then:'
        Write-Host "  py -3.12 -m pip install `"git+$repo`""
        exit 1
    }
    $env:PATH = "$local;$env:LOCALAPPDATA\Programs\uv;$env:PATH"
}

Write-Host "==> Python $python"
uv python install $python | Out-Null
Write-Host '==> installing plip'
uv tool install --force --python $python "git+$repo"

Write-Host ''
Write-Host 'Done.'
if (-not (Have 'plip')) {
    Write-Host 'Open a new terminal, or add this to PATH:'
    Write-Host "  $local"
}
Write-Host '  plip                 # the strip appears at the top of your screen'
Write-Host '  plip doctor          # checks the brain, the voice and the window'
Write-Host '  plip capabilities    # what this machine can and cannot do, and why'
Write-Host ''
Write-Host 'Then hold Ctrl+Alt and talk, or just type in the box.'
Write-Host 'Tkinter missing? Reinstall Python from python.org with the tcl/tk option ticked.'
