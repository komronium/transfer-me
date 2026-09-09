from __future__ import annotations

import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", BASE_DIR / "storage")).resolve()
UPLOADS_DIR = STORAGE_DIR / "uploads"
FILES_DIR = STORAGE_DIR / "files"

DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
DB_PATH = DATA_DIR / "transfer.db"

STATIC_DIR = BASE_DIR / "static"

# Limits
MAX_FILE_SIZE_BYTES = int(os.environ.get("MAX_FILE_SIZE_GB", "10")) * 1024 ** 3
MAX_CHUNK_SIZE_BYTES = int(os.environ.get("MAX_CHUNK_SIZE_MB", "64")) * 1024 ** 2
DEFAULT_CHUNK_SIZE_BYTES = int(os.environ.get("CHUNK_SIZE_MB", "16")) * 1024 ** 2

# 0 means files are kept forever (until deleted manually via /admin or disk).
DEFAULT_EXPIRY_HOURS = int(os.environ.get("DEFAULT_EXPIRY_HOURS", "0"))
NEVER_EXPIRES_AT = "9999-12-31T00:00:00+00:00"

# Abandoned in-progress uploads older than this are purged
ABANDONED_UPLOAD_HOURS = int(os.environ.get("ABANDONED_UPLOAD_HOURS", "48"))
CLEANUP_INTERVAL_SECONDS = int(os.environ.get("CLEANUP_INTERVAL_SECONDS", "600"))

# Rate limiting (per-IP) on upload initiation
INIT_RATE_LIMIT_PER_MINUTE = int(os.environ.get("INIT_RATE_LIMIT_PER_MINUTE", "10"))

# Admin auth: a shared-secret header token. If not provided via env, one is
# generated at process startup and printed to the console so the operator
# can copy it once. This is intentionally minimal (no user accounts).
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN") or secrets.token_urlsafe(24)
ADMIN_TOKEN_WAS_GENERATED = "ADMIN_TOKEN" not in os.environ

for d in (UPLOADS_DIR, FILES_DIR, DATA_DIR):
    d.mkdir(parents=True, exist_ok=True)
