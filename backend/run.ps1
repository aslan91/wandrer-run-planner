# Start the Wandrer Run Planner backend using the project's virtual environment.
# Avoids accidentally using a global Python where FastAPI/uvicorn aren't installed.
#
# Usage:
#   .\run.ps1            # serve on http://127.0.0.1:8000 with autoreload
#   .\run.ps1 -Port 8080 # custom port
#   .\run.ps1 -NoReload  # disable autoreload

param(
    [int]$Port = 8000,
    [switch]$NoReload
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $here ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "venv not found at $python. Create it first: py -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt"
}

$uvicornArgs = @("-m", "uvicorn", "app.main:app", "--port", $Port)
if (-not $NoReload) {
    $uvicornArgs += @("--reload", "--reload-dir", (Join-Path $here "app"))
}

Push-Location $here
try {
    & $python @uvicornArgs
}
finally {
    Pop-Location
}
