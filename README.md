# transfer-me

A minimal, no-login WeTransfer-style file drop: drag in a file, get a share
link, the recipient downloads it, the file expires automatically.

- **Backend:** FastAPI, stdlib `sqlite3` for metadata, files on local disk.
- **Frontend:** plain HTML/CSS/JS, no build step.
- **Upload:** chunked and resumable — the browser uploads in ~16MB pieces and
  can pause/resume or survive a dropped connection/reload without restarting
  from zero. The server never buffers a whole large file in memory; only one
  chunk (bounded by `MAX_CHUNK_SIZE_MB`) is in RAM at a time, and the final
  merge streams chunk-to-file.
- **Links:** `/d/<random-128-bit-token>`, not the original filename or path.
- **Expiry:** files auto-delete after `DEFAULT_EXPIRY_HOURS` (default 24h); a
  background task sweeps expired files and abandoned in-progress uploads.
- **Admin:** `/admin` lists/deletes files, gated by a shared-secret header
  token (`X-Admin-Token`) — no user accounts.

## Run locally (Windows)

```powershell
.\run.ps1
```

Then open http://127.0.0.1:8000

On first run with no `ADMIN_TOKEN` set, a one-time token is generated and
printed to the console — copy it into the `/admin` page's token field.

## Run locally (any OS)

```bash
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `STORAGE_DIR` | `./storage` | Where uploaded files live |
| `DATA_DIR` | `./data` | Where the SQLite DB lives |
| `MAX_FILE_SIZE_GB` | `10` | Max accepted upload size |
| `MAX_CHUNK_SIZE_MB` | `64` | Hard cap on a single chunk request |
| `CHUNK_SIZE_MB` | `16` | Chunk size the server hands the client at init |
| `DEFAULT_EXPIRY_HOURS` | `24` | How long a link stays valid |
| `ABANDONED_UPLOAD_HOURS` | `48` | Purge stale in-progress uploads after this |
| `CLEANUP_INTERVAL_SECONDS` | `600` | How often the sweep runs |
| `INIT_RATE_LIMIT_PER_MINUTE` | `10` | Per-IP limit on starting new uploads |
| `ADMIN_TOKEN` | *(random, printed on startup)* | Shared secret for `/admin` |

## Deploying (VPS + Nginx)

Run the app with uvicorn/gunicorn bound to `127.0.0.1:8000`, put Nginx in
front as a TLS-terminating reverse proxy. See `deploy/nginx.conf.example`
and `deploy/transfer-me.service.example` (systemd unit).

Because uploads are chunked (~16MB pieces, capped at `MAX_CHUNK_SIZE_MB`),
Nginx's `client_max_body_size` only needs to cover one chunk, not the whole
file — see the example config.

## API summary

- `POST /api/upload/init` `{filename, size}` → `{upload_id, chunk_size, total_chunks}`
- `GET /api/upload/{id}` → upload meta + list of received chunk indices (used to resume)
- `PUT /api/upload/{id}/chunk/{index}` (raw bytes body) → ack
- `POST /api/upload/{id}/complete` → `{token, url, expires_at}`
- `DELETE /api/upload/{id}` → cancel/abort
- `GET /api/files/{token}/info` → filename, size, expiry, download count
- `GET /api/files/{token}/download` → streams the file
- `GET /api/admin/files` / `DELETE /api/admin/files/{token}` (header `X-Admin-Token`)

## Known MVP limitations

- Single-node only: uploads/DB live on local disk, so this doesn't horizontally scale as-is (swap `storage.py` for S3/MinIO-backed storage to change that).
- Admin auth is a single shared token, not per-user accounts.
- No virus scanning or content inspection of uploaded files.
