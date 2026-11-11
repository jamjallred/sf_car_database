// Inventory page: server-side search + paging, client-side sort of the page.
document.addEventListener("DOMContentLoaded", () => {
  const COLUMNS = [
    { key: "state", label: "State" },
    { key: "city", label: "City" },
    { key: "year", label: "Year", num: true },
    { key: "make", label: "Make" },
    { key: "model", label: "Model" },
    { key: "trim", label: "Trim" },
    { key: "drive", label: "Drive" },
    { key: "vin", label: "VIN", mono: true },
    { key: "color", label: "Color" },
    { key: "miles", label: "Miles", num: true, fmt: (v) => v.toLocaleString() },
    { key: "price", label: "Price", num: true, fmt: money },
    { key: "msrp", label: "MSRP", num: true, fmt: money },
  ];

  const $ = (id) => document.getElementById(id);
  const q = $("q"), stateSel = $("state"), limitSel = $("limit");
  const thead = document.querySelector("#cars thead tr");
  const tbody = document.querySelector("#cars tbody");
  const count = $("count"), pageInfo = $("page-info"), prev = $("prev"), next = $("next");
  const status = $("inv-status");

  let offset = 0, total = 0, rows = [], sort = { key: null, dir: 1 }, reqId = 0;

  function money(v) {
    return v ? "$" + v.toLocaleString() : "n/a";
  }

  // Restore filters from the URL so searches can be bookmarked and shared.
  const params = new URLSearchParams(location.search);
  q.value = params.get("q") || "";
  limitSel.value = params.get("limit") || "50";
  offset = Number(params.get("offset")) || 0;

  for (const col of COLUMNS) {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.scope = "col";
    th.addEventListener("click", () => {
      sort = { key: col.key, dir: sort.key === col.key ? -sort.dir : 1 };
      render();
    });
    col.th = th;
    thead.appendChild(th);
  }

  function render() {
    for (const col of COLUMNS) {
      col.th.setAttribute("aria-sort", sort.key === col.key ? (sort.dir > 0 ? "ascending" : "descending") : "none");
    }

    let view = rows;
    if (sort.key) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      view = [...rows].sort((a, b) => {
        const x = a[col.key], y = b[col.key];
        const cmp = col.num ? Number(x) - Number(y) : String(x).localeCompare(String(y));
        return cmp * sort.dir;
      });
    }

    tbody.replaceChildren();
    if (!view.length) {
      const td = document.createElement("td");
      td.className = "empty";
      td.colSpan = COLUMNS.length;
      td.textContent = q.value || stateSel.value ? "No cars match those filters." : "No cars in the database yet.";
      tbody.appendChild(document.createElement("tr")).appendChild(td);
    }
    for (const car of view) {
      const tr = document.createElement("tr");
      for (const col of COLUMNS) {
        const td = document.createElement("td");
        const v = car[col.key] ?? "";
        td.textContent = col.fmt ? col.fmt(v) : v;
        if (col.num) td.className = "num";
        if (col.mono) td.className = "mono";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    const limit = Number(limitSel.value);
    const from = total ? offset + 1 : 0;
    const to = Math.min(offset + rows.length, total);
    count.textContent = `${total.toLocaleString()} car${total === 1 ? "" : "s"}`;
    pageInfo.textContent = total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : "";
    prev.disabled = offset === 0;
    next.disabled = offset + limit >= total;
  }

  async function load() {
    const id = ++reqId;
    const p = new URLSearchParams();
    if (q.value.trim()) p.set("q", q.value.trim());
    if (stateSel.value) p.set("state", stateSel.value);
    p.set("limit", limitSel.value);
    if (offset) p.set("offset", offset);
    history.replaceState(null, "", "?" + p.toString());

    try {
      const page = await SF.fetchJSON("/api/cars?" + p.toString());
      if (id !== reqId) return; // a newer search already started
      rows = page.cars;
      total = page.total;
      SF.setStatus(status, "", "");
      render();
    } catch (err) {
      if (id !== reqId) return;
      SF.setStatus(status, "err", err.message);
    }
  }

  let debounce;
  q.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { offset = 0; load(); }, 250);
  });
  stateSel.addEventListener("change", () => { offset = 0; load(); });
  limitSel.addEventListener("change", () => { offset = 0; load(); });
  prev.addEventListener("click", () => { offset = Math.max(0, offset - Number(limitSel.value)); load(); });
  next.addEventListener("click", () => { offset += Number(limitSel.value); load(); });

  SF.fetchJSON("/api/cars/states")
    .then(({ states }) => {
      for (const s of states) stateSel.add(new Option(s, s));
      stateSel.value = params.get("state") || "";
    })
    .catch(() => { /* filter just stays at "All states" */ })
    .finally(load);
});
