# Copilot Instructions — wandrer-run-planner

Read and strictly follow the authoritative architecture, domain invariants, and verification commands in [AGENTS.md](../AGENTS.md).

## Verification & Operational Commands
All backend commands run from `backend/`:
- **Linting:** `ruff check app tests`
- **Type checking:** `mypy`
- **Testing:** `.\.venv\Scripts\python.exe -m pytest -p no:logfire --basetemp=.pytest_temp`
- **Run API:** `uvicorn app.main:app --reload --port 8000` (or `.\run.ps1`)
- **Run CLI:** `python -m app.cli --lat 49.83 --lng 10.88 --km 6 --out run.gpx`
