from __future__ import annotations

import json
import math
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import config

COPY_BUFFER_SIZE = 1024 * 1024  # 1 MB, used only for streaming the final merge


@dataclass
class UploadMeta:
    upload_id: str
    filename: str
    size: int
    chunk_size: int
    total_chunks: int
    created_at: float

    def to_dict(self) -> dict:
        return {
            "upload_id": self.upload_id,
            "filename": self.filename,
            "size": self.size,
            "chunk_size": self.chunk_size,
            "total_chunks": self.total_chunks,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "UploadMeta":
        return cls(
            upload_id=d["upload_id"],
            filename=d["filename"],
            size=d["size"],
            chunk_size=d["chunk_size"],
            total_chunks=d["total_chunks"],
            created_at=d["created_at"],
        )


def upload_dir(upload_id: str) -> Path:
    return config.UPLOADS_DIR / upload_id


def chunks_dir(upload_id: str) -> Path:
    return upload_dir(upload_id) / "chunks"


def meta_path(upload_id: str) -> Path:
    return upload_dir(upload_id) / "meta.json"


def create_upload(filename: str, size: int, chunk_size: int) -> UploadMeta:
    import uuid

    upload_id = uuid.uuid4().hex
    total_chunks = max(1, math.ceil(size / chunk_size))
    meta = UploadMeta(
        upload_id=upload_id,
        filename=filename,
        size=size,
        chunk_size=chunk_size,
        total_chunks=total_chunks,
        created_at=time.time(),
    )
    chunks_dir(upload_id).mkdir(parents=True, exist_ok=True)
    meta_path(upload_id).write_text(json.dumps(meta.to_dict()), encoding="utf-8")
    return meta


def load_upload(upload_id: str) -> Optional[UploadMeta]:
    p = meta_path(upload_id)
    if not p.exists():
        return None
    return UploadMeta.from_dict(json.loads(p.read_text(encoding="utf-8")))


def expected_chunk_size(meta: UploadMeta, index: int) -> int:
    if index == meta.total_chunks - 1:
        remainder = meta.size - meta.chunk_size * (meta.total_chunks - 1)
        return remainder if remainder > 0 else meta.size
    return meta.chunk_size


def chunk_file_path(upload_id: str, index: int) -> Path:
    return chunks_dir(upload_id) / f"{index}.part"


def received_chunks(upload_id: str) -> list[int]:
    d = chunks_dir(upload_id)
    if not d.exists():
        return []
    indices = []
    for p in d.iterdir():
        if p.suffix == ".part":
            try:
                indices.append(int(p.stem))
            except ValueError:
                continue
    return sorted(indices)


def write_chunk(upload_id: str, index: int, data: bytes) -> None:
    path = chunk_file_path(upload_id, index)
    tmp_path = path.with_suffix(".part.tmp")
    tmp_path.write_bytes(data)
    tmp_path.replace(path)


def all_chunks_present(meta: UploadMeta) -> bool:
    received = set(received_chunks(meta.upload_id))
    if len(received) != meta.total_chunks:
        return False
    for i in range(meta.total_chunks):
        if i not in received:
            return False
        expected = expected_chunk_size(meta, i)
        actual = chunk_file_path(meta.upload_id, i).stat().st_size
        if actual != expected:
            return False
    return True


def merge_chunks(meta: UploadMeta, dest_path: Path) -> None:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_dest = dest_path.with_suffix(dest_path.suffix + ".merging")
    with open(tmp_dest, "wb") as out:
        for i in range(meta.total_chunks):
            with open(chunk_file_path(meta.upload_id, i), "rb") as chunk_f:
                shutil.copyfileobj(chunk_f, out, COPY_BUFFER_SIZE)
    tmp_dest.replace(dest_path)


def purge_upload(upload_id: str) -> None:
    d = upload_dir(upload_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


def purge_file(token: str) -> None:
    d = config.FILES_DIR / token
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


def file_dest_path(token: str, filename: str) -> Path:
    return config.FILES_DIR / token / filename


def sweep_abandoned_uploads(max_age_seconds: float) -> int:
    """Delete in-progress upload dirs older than max_age_seconds. Returns count removed."""
    if not config.UPLOADS_DIR.exists():
        return 0
    removed = 0
    now = time.time()
    for d in config.UPLOADS_DIR.iterdir():
        if not d.is_dir():
            continue
        m = meta_path(d.name)
        try:
            created_at = json.loads(m.read_text(encoding="utf-8"))["created_at"] if m.exists() else d.stat().st_mtime
        except Exception:
            created_at = d.stat().st_mtime
        if now - created_at > max_age_seconds:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed
