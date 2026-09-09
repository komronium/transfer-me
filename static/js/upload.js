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

  const finishedSub = document.getElementById("finishedSub");
  const sendAnother = document.getElementById("sendAnother");

  let session = null; // active upload session state
  let pauseButtonMode = "pause"; // "pause" | "resume" | "retry"

  function fmtBytes(n) {
    if (n === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 60) return `${Math.ceil(seconds)}s qoldi`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s qoldi`;
  }

  function fingerprint(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function storageKey(file) {
    return STORAGE_PREFIX + fingerprint(file);
  }

  function setPauseButtonMode(mode) {
    pauseButtonMode = mode;
    pvPauseResume.textContent = mode === "pause" ? "To'xtatish" : mode === "resume" ? "Davom ettirish" : "Qayta urinish";
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
    setPauseButtonMode("pause");
  }

  function showFinished(file) {
    progressView.hidden = true;
    dropzone.hidden = true;
    finishedView.hidden = false;
    finishedSub.textContent = `${file.name} — ${fmtBytes(file.size)}`;
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
      throw new Error(body.detail || `Yuklashni boshlab bo'lmadi (${initRes.status})`);
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

  function currentUploadedBytes(s) {
    let inFlightTotal = 0;
    for (const v of Object.values(s.inFlight)) inFlightTotal += v;
    return s.completedBytes + inFlightTotal;
  }

  function updateProgressUI(s) {
    const now = performance.now();
    const uploaded = currentUploadedBytes(s);
    s.samples.push({ t: now, bytes: uploaded });
    while (s.samples.length > 1 && now - s.samples[0].t > 5000) {
      s.samples.shift();
    }

    const pct = Math.min(100, Math.round((uploaded / s.file.size) * 100));
    pvBar.style.width = `${pct}%`;
    pvPercent.textContent = `${pct}%`;
    pvSize.textContent = `${fmtBytes(uploaded)} / ${fmtBytes(s.file.size)}`;

    if (s.samples.length >= 2) {
      const oldest = s.samples[0];
      const dt = (now - oldest.t) / 1000;
      const db_ = uploaded - oldest.bytes;
      const speed = dt > 0 ? db_ / dt : 0;
      pvSpeed.textContent = speed > 0 ? `${fmtBytes(speed)}/s` : "—";
      const remaining = s.file.size - uploaded;
      pvEta.textContent = speed > 0 ? fmtEta(remaining / speed) : "—";
    }
  }

  function uploadOneChunk(s, index, attempt = 0) {
    if (s.aborted) return Promise.resolve();
    const start = index * s.chunkSize;
    const size = bytesForChunk(s.file, s.chunkSize, s.totalChunks, index);
    const blob = s.file.slice(start, start + size);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/upload/${s.uploadId}/chunk/${index}`);

      xhr.upload.onprogress = (e) => {
        s.inFlight[index] = e.loaded;
        updateProgressUI(s);
      };

      xhr.onload = () => {
        s.activeXhrs.delete(xhr);
        delete s.inFlight[index];
        if (xhr.status >= 200 && xhr.status < 300) {
          s.completedBytes += size;
          s.received.add(index);
          updateProgressUI(s);
          resolve();
        } else {
          let detail = `${index}-bo'lak yuklanmadi (${xhr.status})`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed.detail) detail = parsed.detail;
          } catch {}
          reject(new Error(detail));
        }
      };
      xhr.onerror = () => {
        s.activeXhrs.delete(xhr);
        delete s.inFlight[index];
        reject(new Error("Tarmoq xatosi"));
      };
      xhr.onabort = () => {
        s.activeXhrs.delete(xhr);
        delete s.inFlight[index];
        reject(new Error("Bekor qilindi"));
      };

      s.activeXhrs.add(xhr);
      xhr.send(blob);
    }).catch(async (err) => {
      if (s.aborted) return;
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(8000, 500 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, delay));
        return uploadOneChunk(s, index, attempt + 1);
      }
      throw err;
    });
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
      throw new Error(body.detail || `Yuklashni yakunlab bo'lmadi (${res.status})`);
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
      showError(err.message || "Yuklashni boshlab bo'lmadi");
      return;
    }

    let completedBytes = 0;
    for (const idx of init.received) {
      completedBytes += bytesForChunk(file, init.chunkSize, init.totalChunks, idx);
    }

    session = {
      file,
      uploadId: init.uploadId,
      chunkSize: init.chunkSize,
      totalChunks: init.totalChunks,
      received: init.received,
      completedBytes,
      inFlight: {},
      activeXhrs: new Set(),
      samples: [],
      paused: false,
      aborted: false,
      queue: [],
    };

    updateProgressUI(session);
    await runToCompletion(session);
  }

  async function runToCompletion(s) {
    try {
      await runUploadWorkers(s);
      if (s.aborted) return;
      pvBar.classList.add("done");
      pvBar.style.width = "100%";
      pvPercent.textContent = "100%";
      await completeUpload(s);
      localStorage.removeItem(storageKey(s.file));
      showFinished(s.file);
    } catch (err) {
      if (!s || s.aborted) return;
      showError(err.message || "Yuklash muvaffaqiyatsiz tugadi. Qayta urinib ko'ring.");
      setPauseButtonMode("retry");
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
    if (pauseButtonMode === "retry") {
      setPauseButtonMode("pause");
      pvError.hidden = true;
      pvBar.classList.remove("error");
      runToCompletion(session);
      return;
    }
    session.paused = !session.paused;
    setPauseButtonMode(session.paused ? "resume" : "pause");
  });

  pvCancel.addEventListener("click", () => {
    if (!session) return;
    session.aborted = true;
    for (const xhr of session.activeXhrs) xhr.abort();
    const { uploadId, file } = session;
    localStorage.removeItem(storageKey(file));
    fetch(`/api/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
    resetToDropzone();
  });

  sendAnother.addEventListener("click", resetToDropzone);
})();
