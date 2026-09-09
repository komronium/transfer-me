from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException, Request

from . import config

_hits: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce_init_rate_limit(request: Request) -> None:
    ip = client_ip(request)
    window = 60.0
    limit = config.INIT_RATE_LIMIT_PER_MINUTE
    now = time.time()
    with _lock:
        dq = _hits[ip]
        while dq and now - dq[0] > window:
            dq.popleft()
        if len(dq) >= limit:
            raise HTTPException(status_code=429, detail="Juda ko'p yuklash boshlandi. Birozdan so'ng qayta urinib ko'ring.")
        dq.append(now)
