(() => {
  "use strict";

  const TOKEN_KEY = "transfer-me:admin-token";

  const tokenInput = document.getElementById("tokenInput");
  const statusEl = document.getElementById("status");
  const table = document.getElementById("filesTable");
  const body = document.getElementById("filesBody");
  const refreshBtn = document.getElementById("refreshBtn");

  function fmtBytes(n) {
    if (n === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  tokenInput.value = localStorage.getItem(TOKEN_KEY) || "";

  async function loadFiles() {
    const token = tokenInput.value.trim();
    if (!token) {
      statusEl.textContent = "Enter the admin token to view files.";
      table.hidden = true;
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    statusEl.textContent = "Loading…";

    const res = await fetch("/api/admin/files", { headers: { "X-Admin-Token": token } });
    if (res.status === 403) {
      statusEl.textContent = "Invalid admin token.";
      table.hidden = true;
      return;
    }
    if (!res.ok) {
      statusEl.textContent = `Error loading files (${res.status})`;
      table.hidden = true;
      return;
    }

    const files = await res.json();
    if (files.length === 0) {
      statusEl.textContent = "No files uploaded yet.";
      table.hidden = true;
      return;
    }

    statusEl.textContent = "";
    table.hidden = false;
    body.innerHTML = "";
    for (const f of files) {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.className = "filename";
      tdName.textContent = f.filename;
      tdName.title = f.filename;

      const tdSize = document.createElement("td");
      tdSize.textContent = fmtBytes(f.size);

      const tdUploaded = document.createElement("td");
      tdUploaded.textContent = new Date(f.uploaded_at).toLocaleString();

      const tdExpires = document.createElement("td");
      tdExpires.textContent = new Date(f.expires_at).toLocaleString();

      const tdDownloads = document.createElement("td");
      tdDownloads.textContent = f.download_count;

      const tdActions = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteFile(f.token));
      tdActions.appendChild(delBtn);

      tr.append(tdName, tdSize, tdUploaded, tdExpires, tdDownloads, tdActions);
      body.appendChild(tr);
    }
  }

  async function deleteFile(token) {
    if (!confirm("Delete this file? This cannot be undone.")) return;
    const adminToken = tokenInput.value.trim();
    const res = await fetch(`/api/admin/files/${token}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": adminToken },
    });
    if (res.ok) {
      loadFiles();
    } else {
      alert(`Failed to delete (${res.status})`);
    }
  }

  refreshBtn.addEventListener("click", loadFiles);
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadFiles();
  });

  if (tokenInput.value) loadFiles();
})();
