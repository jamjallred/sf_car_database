// Price check page: upload the daily export, make sure the server has a
// fresh copy of the Avis listings (it downloads them slowly in the
// background), then compare prices VIN by VIN.
document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  const form = document.getElementById("check-form");
  const input = form.querySelector('input[type="file"]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const redownloadBtn = document.getElementById("redownload");
  const status = form.querySelector(".status");
  const info = document.getElementById("avis-info");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const results = document.getElementById("results");
  const tbody = document.querySelector("#compare tbody");
  const headers = [...document.querySelectorAll("#compare th[data-key]")];
  const search = document.getElementById("q");

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const fmtMoney = (n) => (n ? money.format(n) : "—");
  const fmtDiff = (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + money.format(Math.abs(d));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let upload = null;  // server's parse of the sheet
  let rows = [];      // rows merged with Avis prices
  let avisFetchedAt = null;
  let filter = "all";
  let sort = { key: null, dir: 1 };
  let busy = false;

  // ---------- Avis download status ----------

  function describeSnapshot(s) {
    if (!s.fetchedAt) return "Avis prices haven't been downloaded yet.";
    const when = new Date(s.fetchedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `Avis prices from ${when} · ${s.listings.toLocaleString()} cars${s.stale ? " · out of date" : ""}`;
  }

  function showStatus(s) {
    info.textContent = s.running ? "" : describeSnapshot(s);
    progress.hidden = !s.running;
    if (s.running) {
      const total = s.pagesTotal || 0;
      const pct = total ? Math.min(100, Math.round((s.pagesDone / total) * 100)) : 2;
      progressFill.style.width = pct + "%";
      if (total) {
        const mins = Math.max(1, Math.ceil(((total - s.pagesDone) * s.delaySeconds) / 60));
        progressText.textContent = `Downloading Avis listings: page ${s.pagesDone} of ${total} · about ${mins} min left`;
      } else {
        progressText.textContent = "Starting the Avis download…";
      }
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Ask the server to refresh (if needed) and wait until it's done.
  async function ensureAvis(force) {
    let s = await SF.fetchJSON("/api/avis/refresh" + (force ? "?force=1" : ""), { method: "POST" });
    showStatus(s);
    while (s.running) {
      await wait(3000);
      s = await SF.fetchJSON("/api/avis/status");
      showStatus(s);
    }
    if (s.error) {
      if (s.state !== "ready") throw new Error(s.error);
      SF.setStatus(status, "warn", `${s.error}. Showing the earlier download instead.`);
    }
    return s;
  }

  async function lookup() {
    const res = await SF.fetchJSON("/api/avis/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vins: upload.rows.map((r) => r.vin) }),
    });
    avisFetchedAt = res.fetchedAt;
    const found = res.found || {};
    rows = upload.rows.map((r, i) => {
      const a = found[r.vin];
      const avisPrice = a ? a.price : 0;
      const both = r.sheetPrice > 0 && avisPrice > 0;
      return {
        ...r,
        order: i,
        vehicle: [r.year, r.make, r.model, r.trim].filter(Boolean).join(" "),
        location: [r.city, r.state].filter(Boolean).join(", "),
        listed: !!a,
        avisPrice,
        link: a ? a.link : "",
        diff: both ? avisPrice - r.sheetPrice : null,
      };
    });
  }

  // ---------- table ----------

  function category(r) {
    if (!r.listed) return "missing";
    if (r.diff === null) return "missing"; // listed without a price
    return r.diff === 0 ? "same" : "diff";
  }

  function visibleRows() {
    const q = search.value.trim().toLowerCase();
    let out = rows.filter((r) => filter === "all" || category(r) === filter);
    if (q) out = out.filter((r) => `${r.vin} ${r.vehicle} ${r.location}`.toLowerCase().includes(q));
    if (sort.key) {
      const k = sort.key;
      out = [...out].sort((a, b) => {
        let x = a[k], y = b[k];
        if (k === "diff") { x = x === null ? -Infinity : Math.abs(x); y = y === null ? -Infinity : Math.abs(y); }
        if (typeof x === "string") return x.localeCompare(y) * sort.dir;
        return ((x || 0) - (y || 0)) * sort.dir;
      });
    }
    return out;
  }

  function render() {
    const counts = { all: rows.length, diff: 0, same: 0, missing: 0 };
    rows.forEach((r) => counts[category(r)]++);
    for (const k of Object.keys(counts)) document.getElementById("n-" + k).textContent = counts[k].toLocaleString();

    const list = visibleRows();
    if (!list.length) {
      tbody.innerHTML = `<tr><td class="empty" colspan="7">No cars match.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map((r) => {
      let sheetCls = "", avisCls = "";
      if (r.diff > 0) { avisCls = "price-high"; sheetCls = "price-low"; }
      if (r.diff < 0) { avisCls = "price-low"; sheetCls = "price-high"; }
      const vin = r.link
        ? `<a href="${esc(r.link)}" target="_blank" rel="noopener" title="Open the Avis listing">${esc(r.vin)}</a>`
        : esc(r.vin);
      const avis = !r.listed ? `<span class="muted">Not listed</span>` : fmtMoney(r.avisPrice);
      let diff = `<span class="muted">—</span>`;
      if (r.diff !== null) {
        const pct = r.sheetPrice ? ` <span class="muted">(${((r.diff / r.sheetPrice) * 100).toFixed(1)}%)</span>` : "";
        diff = r.diff === 0 ? "$0" : fmtDiff(r.diff) + pct;
      }
      return `<tr>
        <td class="mono">${vin}</td>
        <td>${esc(r.vehicle)}</td>
        <td>${esc(r.location)}</td>
        <td class="num">${r.miles ? r.miles.toLocaleString() : "—"}</td>
        <td class="num ${sheetCls}">${fmtMoney(r.sheetPrice)}</td>
        <td class="num ${avisCls}">${avis}</td>
        <td class="num">${diff}</td>
      </tr>`;
    }).join("");
  }

  function showResults() {
    const parts = [`${upload.file}${upload.sheet ? ` (${upload.sheet})` : ""}`, `prices from “${upload.priceColumn}”`];
    if (upload.duplicates) parts.push(`${upload.duplicates} duplicate VIN${upload.duplicates === 1 ? "" : "s"} skipped`);
    document.getElementById("source-info").textContent = parts.join(" · ");
    results.hidden = false;
    render();
  }

  // ---------- events ----------

  async function compare(force) {
    if (busy) return;
    busy = true;
    SF.setBusy(submitBtn, true, "Comparing…");
    redownloadBtn.disabled = true;
    try {
      if (!force || !upload) {
        if (!input.files.length) throw new Error("Please choose the daily export first.");
        SF.setStatus(status, "info", "Reading the spreadsheet…");
        const body = new FormData();
        body.append("file", input.files[0]);
        upload = await SF.fetchJSON("/api/price_check/upload", { method: "POST", body });
        if (!upload.rows.length) throw new Error("No cars with a VIN were found in that file.");
      }
      SF.setStatus(status, "info", `Read ${upload.rows.length.toLocaleString()} cars. Getting Avis prices — the first download of the day takes several minutes because requests are spaced out.`);
      await ensureAvis(force);
      await lookup();
      const listed = rows.filter((r) => r.listed).length;
      if (status.classList.contains("warn")) {
        // keep the warning from ensureAvis
      } else {
        SF.setStatus(status, "ok", `Compared ${rows.length.toLocaleString()} cars · ${listed.toLocaleString()} found on Avis.`);
      }
      showResults();
    } catch (err) {
      SF.setStatus(status, "err", err.message);
    } finally {
      busy = false;
      SF.setBusy(submitBtn, false);
      redownloadBtn.disabled = false;
      progress.hidden = true;
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); compare(false); });

  redownloadBtn.addEventListener("click", async () => {
    if (upload) return compare(true);
    if (busy) return;
    busy = true;
    SF.setBusy(redownloadBtn, true, "Downloading…");
    submitBtn.disabled = true;
    SF.setStatus(status, "info", "Downloading Avis prices — this takes several minutes because requests are spaced out.");
    try {
      const s = await ensureAvis(true);
      if (!status.classList.contains("warn")) SF.setStatus(status, "ok", `Downloaded ${s.listings.toLocaleString()} Avis listings.`);
    } catch (err) {
      SF.setStatus(status, "err", err.message);
    } finally {
      busy = false;
      SF.setBusy(redownloadBtn, false);
      submitBtn.disabled = false;
      progress.hidden = true;
    }
  });

  document.getElementById("filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    filter = chip.dataset.filter;
    document.querySelectorAll("#filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    render();
  });

  search.addEventListener("input", render);

  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === "diff" ? -1 : 1 };
      headers.forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
      render();
    });
  });

  document.getElementById("export").addEventListener("click", () => {
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["VIN", "Year", "Make", "Model", "Trim", "City", "State", "Miles", "AVIS Direct", "AVIS Retail", "Difference (Retail - Direct)", "Status", "Avis Link"];
    const label = { diff: "Price differs", same: "Same price", missing: "Not on Avis" };
    const lines = [head.join(",")].concat(visibleRows().map((r) => [
      r.vin, r.year, r.make, r.model, r.trim, r.city, r.state, r.miles || "",
      r.sheetPrice || "", r.listed ? r.avisPrice || "" : "", r.diff ?? "", label[category(r)], r.link,
    ].map(cell).join(",")));
    const stamp = (avisFetchedAt ? new Date(avisFetchedAt) : new Date()).toISOString().slice(0, 10);
    SF.download(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }), `avis_price_check_${stamp}.csv`);
  });

  // Show where the Avis snapshot stands when the page opens; if a download
  // is already running (started from another tab), follow it.
  SF.fetchJSON("/api/avis/status").then(async (s) => {
    showStatus(s);
    while (s.running && !busy) {
      await wait(3000);
      s = await SF.fetchJSON("/api/avis/status");
      if (!busy) showStatus(s);
    }
    if (!busy) progress.hidden = true;
  }).catch(() => {});
});
