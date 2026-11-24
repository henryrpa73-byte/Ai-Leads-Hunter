"""Configuration loader for Construction Lead Hunter AI.

Reads settings from environment variables and an optional local `.env` file
without requiring external dependencies.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent


def load_dotenv_file(env_path: Path) -> None:
    """Load key=value pairs from a .env file into os.environ if not already set."""
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


load_dotenv_file(BASE_DIR / ".env")


def _resolve_path(env_key: str, default_rel: str) -> Path:
    raw = os.environ.get(env_key, default_rel).strip() or default_rel
    p = Path(raw)
    return p if p.is_absolute() else (BASE_DIR / p)


@dataclass(frozen=True)
class Settings:
    base_dir: Path
    db_path: Path
    imports_dir: Path
    exports_dir: Path
    reports_dir: Path
    logs_dir: Path
    ollama_base_url: str
    ollama_model: str
    ollama_timeout_seconds: int
    sam_gov_api_key: str
    socrata_app_token: str
    http_user_agent: str
    request_delay_seconds: float

    def ensure_directories(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.imports_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)


def get_settings() -> Settings:
    settings = Settings(
        base_dir=BASE_DIR,
        db_path=_resolve_path("DB_PATH", "data/db/leads.db"),
        imports_dir=_resolve_path("IMPORTS_DIR", "data/imports"),
        exports_dir=_resolve_path("EXPORTS_DIR", "data/exports"),
        reports_dir=_resolve_path("REPORTS_DIR", "data/reports"),
        logs_dir=_resolve_path("LOGS_DIR", "data/logs"),
        ollama_base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/"),
        ollama_model=os.environ.get("OLLAMA_MODEL", "qwen2.5:3b"),
        ollama_timeout_seconds=int(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "60")),
        sam_gov_api_key=os.environ.get("SAM_GOV_API_KEY", "").strip(),
        socrata_app_token=os.environ.get("SOCRATA_APP_TOKEN", "").strip(),
        http_user_agent=os.environ.get("HTTP_USER_AGENT", "ConstructionLeadHunter/1.0 (+local-research)"),
        request_delay_seconds=float(os.environ.get("REQUEST_DELAY_SECONDS", "0.5")),
    )
    settings.ensure_directories()
    return settings
