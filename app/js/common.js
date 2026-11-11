// Shared front-end code: header/nav, profile picker, drag-and-drop uploads,
// and the generic "upload → download a spreadsheet" form handler.
(() => {
  "use strict";

  const ICONS = {
    logo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h14M6 17l1.5-5h9L18 17M8 12l1.2-3.5h5.6L16 12"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/></svg>',
    file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 17v-6M9 14l3-3 3 3"/></svg>',
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>',
  };

  const NAV = [
    { href: "/app/", label: "Home" },
    { href: "/app/generate_grounded", label: "Grounded" },
    { href: "/app/nationwide", label: "Nationwide" },
    { href: "/app/generate_final_report", label: "Final report" },
    { href: "/app/inventory", label: "Inventory" },
    { href: "/app/price_check", label: "Price check" },
  ];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---------- helpers ----------

  async function errorMessage(resp) {
    try {
      const body = await resp.json();
      if (body && body.error) return body.error;
    } catch { /* not JSON */ }
    return `Request failed (HTTP ${resp.status})`;
  }

  async function fetchJSON(url, opts) {
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(await errorMessage(resp));
    return resp.json();
  }

  function setStatus(el, kind, text) {
    if (!el) return;
    el.className = "status" + (kind ? ` show ${kind}` : "");
    el.textContent = text || "";
  }

  function setBusy(btn, busy, busyLabel) {
    if (!btn) return;
    const label = btn.querySelector(".label");
    if (busy) {
      btn.dataset.idleLabel = label ? label.textContent : "";
      if (label && busyLabel) label.textContent = busyLabel;
    } else if (label && btn.dataset.idleLabel) {
      label.textContent = btn.dataset.idleLabel;
    }
    btn.disabled = busy;
    btn.classList.toggle("busy", busy);
  }

  function filenameFrom(resp, fallback) {
    const cd = resp.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^";]+)"?/i);
    return m ? m[1] : fallback;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- header ----------

  function renderHeader() {
    const host = document.getElementById("topbar");
    if (!host) return;
    const path = location.pathname.replace(/\/+$/, "") || "/app";
    const links = NAV.map(({ href, label }) => {
      const active = (href.replace(/\/+$/, "") === path) ? ' class="active" aria-current="page"' : "";
      return `<a href="${href}"${active}>${label}</a>`;
    }).join("");

    host.className = "topbar";
    host.innerHTML = `
      <div class="topbar-inner">
        <a class="brand" href="/app/"><span class="brand-mark">${ICONS.logo}</span><span class="brand-name">SF Car Database</span></a>
        <nav class="nav">${links}</nav>
        <div class="profile">
          <label for="profile-select">Profile</label>
          <select id="profile-select"><option value="">Choose…</option></select>
        </div>
      </div>`;
    initProfile(host.querySelector("#profile-select"));
  }

  async function initProfile(select) {
    const saved = store.get("username") || "";
    let team = [];
    try {
      team = (await fetchJSON("/api/team")).team || [];
    } catch { /* leave empty */ }
    if (saved && !team.includes(saved)) team.push(saved);
    for (const name of team) select.add(new Option(name, name));
    select.value = saved;
    select.addEventListener("change", () => store.set("username", select.value));
  }

  // ---------- dropzones ----------

  function initDropzone(zone) {
    const input = zone.querySelector('input[type="file"]');
    const title = zone.querySelector(".dz-title");
    const icon = zone.querySelector(".dz-icon");
    const emptyTitle = title.textContent;
    const exts = (input.accept || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    icon.innerHTML = ICONS.file;

    const refresh = () => {
      const f = input.files[0];
      zone.classList.toggle("has-file", !!f);
      title.textContent = f ? f.name : emptyTitle;
      icon.innerHTML = f ? ICONS.check : ICONS.file;
      zone.dispatchEvent(new CustomEvent("sf:file", { bubbles: true }));
    };

    input.addEventListener("change", refresh);
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const ok = !exts.length || exts.some((x) => file.name.toLowerCase().endsWith(x));
      const status = zone.closest("form")?.querySelector(".status");
      if (!ok) {
        setStatus(status, "err", `${file.name} isn't a ${exts.join(" / ")} file.`);
        return;
      }
      setStatus(status, "", "");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      refresh();
    });
    zone.reset = () => { input.value = ""; refresh(); };
  }

  // ---------- generic "upload → download workbook" forms ----------
  // <form data-endpoint="/api/..." data-busy="Generating…"> with dropzones,
  // a .status element and a submit button. Fires "sf:generated" with
  // { blob, filename, summary } on success.

  function initGenerateForm(form) {
    const status = form.querySelector(".status");
    const btn = form.querySelector('button[type="submit"]');

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      for (const input of form.querySelectorAll('input[type="file"][required]')) {
        if (!input.files.length) {
          const label = input.closest(".dropzone")?.dataset.label || "a file";
          setStatus(status, "err", `Please choose ${label} first.`);
          return;
        }
      }

      setBusy(btn, true, form.dataset.busy || "Working…");
      setStatus(status, "info", "Uploading and processing — large files can take a minute.");
      const started = performance.now();

      try {
        const resp = await fetch(form.dataset.endpoint, { method: "POST", body: new FormData(form) });
        if (!resp.ok) throw new Error(await errorMessage(resp));

        const blob = await resp.blob();
        const filename = filenameFrom(resp, form.dataset.fallbackName || "report.xlsx");
        const summary = resp.headers.get("X-Sheet-Summary");
        download(blob, filename);

        const secs = ((performance.now() - started) / 1000).toFixed(1);
        setStatus(status, "ok", `Downloaded ${filename} (${secs}s).${summary ? " " + summary + "." : ""}`);
        form.dispatchEvent(new CustomEvent("sf:generated", { detail: { blob, filename, summary } }));
      } catch (err) {
        setStatus(status, "err", err.message);
      } finally {
        setBusy(btn, false);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderHeader();
    document.querySelectorAll(".dropzone").forEach(initDropzone);
    document.querySelectorAll("form[data-endpoint]").forEach(initGenerateForm);
  });

  window.SF = { fetchJSON, errorMessage, setStatus, setBusy, download, store };
})();
