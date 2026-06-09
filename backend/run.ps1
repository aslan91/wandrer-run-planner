# Start the Wandrer Run Planner backend using the project's virtual environment.
# Avoids accidentally using a global Python where FastAPI/uvicorn aren't installed.
#
# Usage:
#   .\run.ps1            # serve on http://127.0.0.1:8000 (no autoreload)
#   .\run.ps1 -Port 8080 # custom port
#   .\run.ps1 -Reload    # enable autoreload (dev only)
#
# Autoreload is OFF by default on purpose: a plan request can take 10-30s
# (Overpass is often slow / returns 504 and we fall back to another mirror),
# and any file change while a request is in flight makes uvicorn restart the
# worker and drop the connection -> the userscript reports "Backend unreachable".

param(
    [int]$Port = 8000,
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $here ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "venv not found at $python. Create it first: py -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt"
}

$uvicornArgs = @("-m", "uvicorn", "app.main:app", "--port", $Port)
if ($Reload) {
    $uvicornArgs += @("--reload", "--reload-dir", (Join-Path $here "app"))
}

Push-Location $here
try {
    & $python @uvicornArgs
}
finally {
    Pop-Location
}
