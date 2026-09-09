(() => {
  "use strict";

  const CONCURRENCY = 3;
  const MAX_RETRIES = 5;
  const STORAGE_PREFIX = "transfer-me:upload:";

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const progressView = document.getElementById("progressView");
  const finishedView = document.getElementById("finishedView");

  const pvName = document.getElementById("pvName");
  const pvSize = document.getElementById("pvSize");
  const pvBar = document.getElementById("pvBar");
  const pvPercent = document.getElementById("pvPercent");
  const pvSpeed = document.getElementById("pvSpeed");
  const pvEta = document.getElementById("pvEta");
  const pvError = document.getElementById("pvError");
  const pvCancel = document.getElementById("pvCancel");
  const pvPauseResume = document.getElementById("pvPauseResume");

  const shareLink = document.getElementById("shareLink");
  const copyBtn = document.getElementById("copyBtn");
  const expiryNote = document.getElementById("expiryNote");
  const sendAnother = document.getElementById("sendAnother");

  let session = null; // active upload session state

  function fmtBytes(n) {
    if (n === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s remaining`;
  }

  function fingerprint(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function storageKey(file) {
    return STORAGE_PREFIX + fingerprint(file);
  }

  function resetToDropzone() {
    session = null;
    progressView.hidden = true;
    finishedView.hidden = true;
    dropzone.hidden = false;
    pvError.hidden = true;
    fileInput.value = "";
  }

  function showProgress() {
    dropzone.hidden = true;
    finishedView.hidden = true;
    progressView.hidden = false;
    pvError.hidden = true;
    pvBar.classList.remove("done", "error");
  }

  function showFinished(url, expiresAt) {
    progressView.hidden = true;
    dropzone.hidden = true;
    finishedView.hidden = false;
    shareLink.value = url;
    const d = new Date(expiresAt);
    expiryNote.textContent = `Expires ${d.toLocaleString()}`;
  }

  function showError(message) {
    pvError.textContent = message;
    pvError.hidden = false;
    pvBar.classList.add("error");
  }

  async function initOrResumeUpload(file) {
    const key = storageKey(file);
    const storedId = localStorage.getItem(key);

    if (storedId) {
      const res = await fetch(`/api/upload/${storedId}`);
      if (res.ok) {
        const meta = await res.json();
        return {
          uploadId: storedId,
          chunkSize: meta.chunk_size,
          totalChunks: meta.total_chunks,
          received: new Set(meta.received),
        };
      }
      localStorage.removeItem(key);
    }

    const initRes = await fetch("/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, size: file.size }),
    });
    if (!initRes.ok) {
      const body = await initRes.json().catch(() => ({}));
      throw new Error(body.detail || `Could not start upload (${initRes.status})`);
    }
    const init = await initRes.json();
    localStorage.setItem(key, init.upload_id);
    return {
      uploadId: init.upload_id,
      chunkSize: init.chunk_size,
      totalChunks: init.total_chunks,
      received: new Set(),
    };
  }

  function bytesForChunk(file, chunkSize, totalChunks, index) {
    if (index === totalChunks - 1) {
      const remainder = file.size - chunkSize * (totalChunks - 1);
      return remainder > 0 ? remainder : file.size;
    }
    return chunkSize;
  }

  async function uploadOneChunk(s, index, attempt = 0) {
    if (s.aborted) return;
    const start = index * s.chunkSize;
    const size = bytesForChunk(s.file, s.chunkSize, s.totalChunks, index);
    const blob = s.file.slice(start, start + size);

    try {
      const res = await fetch(`/api/upload/${s.uploadId}/chunk/${index}`, {
        method: "PUT",
        body: blob,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Chunk ${index} failed (${res.status})`);
      }
      s.received.add(index);
      s.bytesUploaded += size;
      updateProgressUI(s);
    } catch (err) {
      if (s.aborted) return;
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(8000, 500 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, delay));
        return uploadOneChunk(s, index, attempt + 1);
      }
      throw err;
    }
  }

  function updateProgressUI(s) {
    const now = performance.now();
    s.samples.push({ t: now, bytes: s.bytesUploaded });
    while (s.samples.length > 1 && now - s.samples[0].t > 5000) {
      s.samples.shift();
    }

    const pct = Math.min(100, Math.round((s.bytesUploaded / s.file.size) * 100));
    pvBar.style.width = `${pct}%`;
    pvPercent.textContent = `${pct}%`;
    pvSize.textContent = `${fmtBytes(s.bytesUploaded)} / ${fmtBytes(s.file.size)}`;

    if (s.samples.length >= 2) {
      const oldest = s.samples[0];
      const dt = (now - oldest.t) / 1000;
      const db_ = s.bytesUploaded - oldest.bytes;
      const speed = dt > 0 ? db_ / dt : 0;
      pvSpeed.textContent = speed > 0 ? `${fmtBytes(speed)}/s` : "—";
      const remaining = s.file.size - s.bytesUploaded;
      pvEta.textContent = speed > 0 ? fmtEta(remaining / speed) : "—";
    }
  }

  async function runUploadWorkers(s) {
    const pending = [];
    for (let i = 0; i < s.totalChunks; i++) {
      if (!s.received.has(i)) pending.push(i);
    }
    s.queue = pending;

    async function worker() {
      while (true) {
        if (s.aborted) return;
        while (s.paused && !s.aborted) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (s.aborted) return;
        const index = s.queue.shift();
        if (index === undefined) return;
        await uploadOneChunk(s, index);
      }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  async function completeUpload(s) {
    const res = await fetch(`/api/upload/${s.uploadId}/complete`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Could not finalize upload (${res.status})`);
    }
    return res.json();
  }

  async function startUpload(file) {
    showProgress();
    pvName.textContent = file.name;
    pvSize.textContent = `0 B / ${fmtBytes(file.size)}`;
    pvBar.style.width = "0%";
    pvPercent.textContent = "0%";

    let init;
    try {
      init = await initOrResumeUpload(file);
    } catch (err) {
      showError(err.message || "Could not start upload");
      return;
    }

    let bytesUploaded = 0;
    for (const idx of init.received) {
      bytesUploaded += bytesForChunk(file, init.chunkSize, init.totalChunks, idx);
    }

    session = {
      file,
      uploadId: init.uploadId,
      chunkSize: init.chunkSize,
      totalChunks: init.totalChunks,
      received: init.received,
      bytesUploaded,
      samples: [],
      paused: false,
      aborted: false,
      queue: [],
    };

    updateProgressUI(session);

    try {
      await runUploadWorkers(session);
      if (session.aborted) return;
      pvBar.classList.add("done");
      pvBar.style.width = "100%";
      pvPercent.textContent = "100%";
      const result = await completeUpload(session);
      localStorage.removeItem(storageKey(file));
      showFinished(result.url, result.expires_at);
    } catch (err) {
      if (!session || session.aborted) return;
      showError(err.message || "Upload failed. You can try resuming.");
      pvPauseResume.textContent = "Retry";
    }
  }

  // --- UI wiring ---

  dropzone.addEventListener("click", () => fileInput.click());

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) startUpload(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) startUpload(file);
  });

  pvPauseResume.addEventListener("click", () => {
    if (!session) return;
    if (pvPauseResume.textContent === "Retry") {
      pvPauseResume.textContent = "Pause";
      pvError.hidden = true;
      pvBar.classList.remove("error");
      runUploadWorkers(session)
        .then(async () => {
          if (session.aborted) return;
          pvBar.classList.add("done");
          const result = await completeUpload(session);
          localStorage.removeItem(storageKey(session.file));
          showFinished(result.url, result.expires_at);
        })
        .catch((err) => {
          if (session && !session.aborted) {
            showError(err.message || "Upload failed. You can try resuming.");
            pvPauseResume.textContent = "Retry";
          }
        });
      return;
    }
    session.paused = !session.paused;
    pvPauseResume.textContent = session.paused ? "Resume" : "Pause";
  });

  pvCancel.addEventListener("click", async () => {
    if (!session) return;
    session.aborted = true;
    const { uploadId, file } = session;
    localStorage.removeItem(storageKey(file));
    fetch(`/api/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
    resetToDropzone();
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareLink.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } catch {
      shareLink.select();
      document.execCommand("copy");
    }
  });

  sendAnother.addEventListener("click", resetToDropzone);
})();
