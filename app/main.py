from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, db, storage
from .ratelimit import enforce_init_rate_limit

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("transfer-me")

app = FastAPI(title="transfer-me")


# ---------------------------------------------------------------------------
# Startup / background cleanup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def on_startup() -> None:
    db.init_db()
    if config.ADMIN_TOKEN_WAS_GENERATED:
        log.warning("No ADMIN_TOKEN set. Generated one-time admin token: %s", config.ADMIN_TOKEN)
        log.warning("Set ADMIN_TOKEN env var to keep a stable token across restarts.")
    app.state.cleanup_task = asyncio.create_task(_cleanup_loop())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    task = getattr(app.state, "cleanup_task", None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def _cleanup_loop() -> None:
    while True:
        try:
            _run_cleanup_once()
        except Exception:
            log.exception("cleanup pass failed")
        await asyncio.sleep(config.CLEANUP_INTERVAL_SECONDS)


def _run_cleanup_once() -> None:
    now_iso = db.now_iso()
    expired = db.list_expired(now_iso)
    for row in expired:
        storage.purge_file(row["token"])
        db.delete_file(row["token"])
    if expired:
        log.info("expired %d file(s)", len(expired))

    removed = storage.sweep_abandoned_uploads(config.ABANDONED_UPLOAD_HOURS * 3600)
    if removed:
        log.info("purged %d abandoned upload(s)", removed)


# ---------------------------------------------------------------------------
# Admin auth
# ---------------------------------------------------------------------------

def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    if not x_admin_token or not secrets.compare_digest(x_admin_token, config.ADMIN_TOKEN):
        raise HTTPException(status_code=403, detail="Noto'g'ri admin token")


# ---------------------------------------------------------------------------
# Upload API
# ---------------------------------------------------------------------------

class InitUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=512)
    size: int = Field(gt=0)
    chunk_size: int | None = None


class InitUploadResponse(BaseModel):
    upload_id: str
    chunk_size: int
    total_chunks: int


@app.post("/api/upload/init", response_model=InitUploadResponse)
async def init_upload(body: InitUploadRequest, request: Request, _rl: None = Depends(enforce_init_rate_limit)):
    if body.size > config.MAX_FILE_SIZE_BYTES:
        max_gb = config.MAX_FILE_SIZE_BYTES / 1024 ** 3
        raise HTTPException(status_code=413, detail=f"Fayl hajmi {max_gb:.0f} GB dan katta")

    chunk_size = body.chunk_size or config.DEFAULT_CHUNK_SIZE_BYTES
    chunk_size = max(1024 * 1024, min(chunk_size, config.MAX_CHUNK_SIZE_BYTES))

    filename = body.filename.strip().replace("/", "_").replace("\\", "_")
    if not filename:
        raise HTTPException(status_code=400, detail="Fayl nomi noto'g'ri")

    meta = storage.create_upload(filename=filename, size=body.size, chunk_size=chunk_size)
    return InitUploadResponse(upload_id=meta.upload_id, chunk_size=meta.chunk_size, total_chunks=meta.total_chunks)


@app.get("/api/upload/{upload_id}")
async def get_upload(upload_id: str):
    meta = storage.load_upload(upload_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Yuklash topilmadi (yakunlangan yoki bekor qilingan bo'lishi mumkin)")
    return {**meta.to_dict(), "received": storage.received_chunks(upload_id)}


@app.put("/api/upload/{upload_id}/chunk/{index}")
async def upload_chunk(upload_id: str, index: int, request: Request):
    meta = storage.load_upload(upload_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Yuklash topilmadi (yakunlangan yoki bekor qilingan bo'lishi mumkin)")
    if index < 0 or index >= meta.total_chunks:
        raise HTTPException(status_code=400, detail="Bo'lak raqami chegaradan tashqarida")

    body = await request.body()
    expected = storage.expected_chunk_size(meta, index)
    if len(body) != expected:
        raise HTTPException(
            status_code=400,
            detail=f"{index}-bo'lak hajmi mos kelmadi: kutilgan {expected} bayt, kelgan {len(body)} bayt",
        )

    await asyncio.to_thread(storage.write_chunk, upload_id, index, body)
    return {"ok": True, "index": index, "received_bytes": len(body)}


class CompleteUploadResponse(BaseModel):
    token: str
    url: str
    expires_at: str


@app.post("/api/upload/{upload_id}/complete", response_model=CompleteUploadResponse)
async def complete_upload(upload_id: str, request: Request):
    meta = storage.load_upload(upload_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Yuklash topilmadi (yakunlangan yoki bekor qilingan bo'lishi mumkin)")

    if not await asyncio.to_thread(storage.all_chunks_present, meta):
        raise HTTPException(status_code=409, detail="Hali barcha bo'laklar qabul qilinmagan")

    token = secrets.token_urlsafe(16)
    dest = storage.file_dest_path(token, meta.filename)
    await asyncio.to_thread(storage.merge_chunks, meta, dest)

    if config.DEFAULT_EXPIRY_HOURS > 0:
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=config.DEFAULT_EXPIRY_HOURS)).isoformat()
    else:
        expires_at = config.NEVER_EXPIRES_AT
    db.insert_file(token=token, filename=meta.filename, size=meta.size, stored_path=str(dest), expires_at=expires_at)

    await asyncio.to_thread(storage.purge_upload, upload_id)

    base_url = str(request.base_url).rstrip("/")
    return CompleteUploadResponse(token=token, url=f"{base_url}/d/{token}", expires_at=expires_at)


@app.delete("/api/upload/{upload_id}")
async def abort_upload(upload_id: str):
    await asyncio.to_thread(storage.purge_upload, upload_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Download API
# ---------------------------------------------------------------------------

def _get_active_file_or_404(token: str) -> db.sqlite3.Row:
    row = db.get_file(token)
    if row is None:
        raise HTTPException(status_code=404, detail="Fayl topilmadi")
    if row["expires_at"] < db.now_iso():
        storage.purge_file(token)
        db.delete_file(token)
        raise HTTPException(status_code=404, detail="Faylning muddati tugagan")
    return row


@app.get("/api/files/{token}/info")
async def file_info(token: str):
    row = _get_active_file_or_404(token)
    return {
        "filename": row["filename"],
        "size": row["size"],
        "uploaded_at": row["uploaded_at"],
        "expires_at": row["expires_at"],
        "download_count": row["download_count"],
    }


@app.get("/api/files/{token}/download")
async def download_file(token: str):
    row = _get_active_file_or_404(token)
    path = row["stored_path"]
    db.increment_download_count(token)
    return FileResponse(
        path,
        filename=row["filename"],
        media_type="application/octet-stream",
    )


# ---------------------------------------------------------------------------
# Admin API
# ---------------------------------------------------------------------------

@app.get("/api/admin/files", dependencies=[Depends(require_admin)])
async def admin_list_files():
    rows = db.list_files()
    return [
        {
            "token": r["token"],
            "filename": r["filename"],
            "size": r["size"],
            "uploaded_at": r["uploaded_at"],
            "download_count": r["download_count"],
            "path": r["stored_path"],
        }
        for r in rows
    ]


@app.delete("/api/admin/files/{token}", dependencies=[Depends(require_admin)])
async def admin_delete_file(token: str):
    row = db.get_file(token)
    if row is None:
        raise HTTPException(status_code=404, detail="Fayl topilmadi")
    storage.purge_file(token)
    db.delete_file(token)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Frontend pages
# ---------------------------------------------------------------------------

@app.get("/")
async def index_page():
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/d/{token}")
async def download_page(token: str):
    return FileResponse(config.STATIC_DIR / "download.html")


@app.get("/admin")
async def admin_page():
    return FileResponse(config.STATIC_DIR / "admin.html")


app.mount("/assets", StaticFiles(directory=config.STATIC_DIR), name="assets")


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    return FileResponse(config.STATIC_DIR / "index.html", status_code=404)
