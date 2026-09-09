(() => {
  "use strict";

  function fmtBytes(n) {
    if (n === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function tokenFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1];
  }

  async function main() {
    const token = tokenFromPath();
    const loading = document.getElementById("loading");
    const notFound = document.getElementById("notFound");
    const found = document.getElementById("found");

    let info;
    try {
      const res = await fetch(`/api/files/${token}/info`);
      if (!res.ok) throw new Error("not found");
      info = await res.json();
    } catch {
      loading.hidden = true;
      notFound.hidden = false;
      return;
    }

    loading.hidden = true;
    found.hidden = false;
    document.getElementById("dlName").textContent = info.filename;
    document.getElementById("dlMeta").textContent =
      `${fmtBytes(info.size)} · ${info.download_count} marta yuklab olingan`;

    document.getElementById("dlBtn").addEventListener("click", () => {
      window.location.href = `/api/files/${token}/download`;
    });
  }

  main();
})();
