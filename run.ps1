# Dev launcher for transfer-me on Windows.
# Creates a venv on first run, installs deps, then starts the server.

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv")) {
    python -m venv .venv
}

& .\.venv\Scripts\pip.exe install -q -r requirements.txt

Write-Host "Starting transfer-me on http://127.0.0.1:8000"
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
