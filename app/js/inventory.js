// Inventory page: server-side search + paging, client-side sort, a pasted-VIN
// filter, dibs checkboxes saved with the "Call Dibs" button, and per-person
// notes that save on their own.
//
// Only the rows in view (plus a margin) are in the DOM; spacer rows above and
// below stand in for the rest. Selections and fills are kept as index ranges
// over `view` (the sorted cars), so they cover rows that aren't drawn.
document.addEventListener("DOMContentLoaded", () => {
  // Same order and headings as the nationwide sheet (/api/create_sheet).
  const COLUMNS = [
    // w is the default width in pixels; people can drag to resize.
    { key: "state", label: "State", w: 76 },
    { key: "city", label: "City", w: 150 },
    { key: "year", label: "Yr", num: true, w: 66 },
    { key: "make", label: "Make", w: 110 },
    { key: "model", label: "Model", w: 220 },
    { key: "trim", label: "Trim", w: 200 },
    { key: "drive", label: "Drive", w: 76 },
    { key: "vin", label: "Vin", mono: true, w: 190 },
    { key: "color", label: "Color", w: 100 },
    { key: "miles", label: "Miles", num: true, fmt: (v) => v.toLocaleString(), w: 90 },
    { key: "price", label: "Price", num: true, fmt: money, w: 100 },
    { key: "msrp", label: "MSRP", num: true, fmt: money, w: 100 },
  ];
  const DIB_WIDTH = 76, NOTE_WIDTH = 130, MIN_WIDTH = 44, WAVE_WIDTH = 96;
  // The "2nd Wave" checkbox column, after MSRP. It works like a dibs column
  // (saved with Call Dibs, range selection, Space) but has no order colours
  // and isn't pinned. Its width and Columns-menu key is "wave".
  const WAVE = "2nd Wave";
  const dibKey = (name) => (name === WAVE ? "wave" : "dib:" + name);
  const WIDTHS_KEY = "inventory.colWidths"; // localStorage, so widths outlive the tab
  const FILTERS_KEY = "inventory.filters"; // sessionStorage, so filters survive a refresh
  const NOTES_OPEN_KEY = "inventory.notesOpen"; // localStorage: is the notes panel out?
  const HIDDEN_KEY = "inventory.hiddenColumns"; // localStorage: columns turned off in the Columns menu
  const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
  const OVERSCAN = 15; // rows drawn above and below the visible ones

  const $ = (id) => document.getElementById(id);
  const q = $("q"), limitSel = $("limit");
  const vinBox = $("vins"), vinBadge = $("vin-badge"), vinSummary = $("vin-summary");
  const table = $("cars");
  const wrap = table.parentElement;
  const theadEl = table.tHead;
  const thead = theadEl.rows[0];
  const tbody = table.tBodies[0];
  const count = $("count"), pager = $("pager"), pageInfo = $("page-info"), prev = $("prev"), next = $("next");
  const status = $("inv-status");
  const saveBtn = $("dibs-save"), discardBtn = $("dibs-discard"), pendingNote = $("pending-note");
  const notesState = $("notes-state"), notesUndo = $("notes-undo"), rangeHint = $("range-hint");
  const resetBtn = $("reset-filters");
  const includeOld = $("include-old"), includeOldLabel = $("include-old-label");
  const notesFlag = $("notes-flag");
  const notesPanel = $("notes-panel"), notesHead = $("notes-head"), notesBody = $("notes-body"), notesRows = $("notes-rows");
  const colMenuBtn = $("col-menu-btn"), colMenuPanel = $("col-menu-panel");

  let offset = 0, total = 0, rows = [], sort = { key: null, dir: 1 }, reqId = 0;
  let dibsNames = null; // from the server, e.g. ["Mike", "Stan", "Jaxon", "Gregg"]
  let latestImport = null; // {id, at, cars}: the most recent nationwide sheet saved
  let scope = "latest"; // "latest": only that sheet's cars; "all": older cars too
  let byVIN = new Map(); // vin → car on the current page
  let view = []; // rows in display order
  let idxOf = new Map(); // vin → index in view
  // Unsaved checkbox changes, in the order they were made: "vin\tname" → {vin, name, claim}.
  const pending = new Map();
  const keyOf = (vin, name) => vin + "\t" + name;
  const collator = new Intl.Collator();

  function money(v) {
    return v ? "$" + v.toLocaleString() : "n/a";
  }

  // Splits a pasted VIN list on whitespace, newlines, commas or semicolons.
  function parseVINs(text) {
    const seen = new Set();
    for (const raw of text.split(/[\s,;]+/)) {
      const v = raw.replace(/^["']+|["']+$/g, "").toUpperCase();
      if (v) seen.add(v);
    }
    return [...seen];
  }

  // Runs fn once input has paused for ms. .flush() runs a waiting call now.
  function debounced(fn, ms) {
    let t = null;
    const d = () => { clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
    d.flush = () => { if (t !== null) { clearTimeout(t); t = null; fn(); } };
    d.cancel = () => { clearTimeout(t); t = null; };
    return d;
  }

  // Runs fn at most once per animation frame.
  function perFrame(fn) {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(); });
    };
  }

  // ---------- searchable multi-select dropdowns (States, Cities) ----------
  // A button that opens a panel with a search box and a ticked list. Nothing
  // ticked means "all". Arrow keys move through the list, Enter or Space
  // ticks, Esc closes. onChange runs after every tick.

  function multiSelect(root, { noun, plural, onChange }) {
    root.classList.add("ms");
    root.innerHTML = `
      <button type="button" class="ms-btn" aria-haspopup="listbox" aria-expanded="false">
        <span class="ms-text"></span><span class="ms-caret" aria-hidden="true">▾</span>
      </button>
      <div class="ms-panel" hidden>
        <input type="search" class="ms-search" autocomplete="off" spellcheck="false">
        <div class="ms-list" role="listbox" aria-multiselectable="true"></div>
        <div class="ms-foot"><span class="ms-count"></span><button type="button" class="link-btn ms-clear">Clear</button></div>
      </div>`;
    const btn = root.querySelector(".ms-btn"), text = root.querySelector(".ms-text");
    const panel = root.querySelector(".ms-panel"), search = root.querySelector(".ms-search");
    const list = root.querySelector(".ms-list"), countEl = root.querySelector(".ms-count");
    const clearBtn = root.querySelector(".ms-clear");
    search.placeholder = `Search ${plural}…`;
    search.setAttribute("aria-label", `Search ${plural}`);
    btn.title = `Filter by ${noun}: tick one or more`;

    let options = []; // {value, label, hint}
    const selected = new Set();
    let shownOpts = [], active = -1;

    function updateButton() {
      const labels = options.filter((o) => selected.has(o.value)).map((o) => o.short || o.label);
      text.textContent = !labels.length ? `All ${plural}`
        : labels.length <= 2 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
      root.classList.toggle("has-value", labels.length > 0);
      btn.title = labels.length ? `${labels.length} ${labels.length === 1 ? noun : plural}: ${labels.join(", ")}` : `Filter by ${noun}: tick one or more`;
      countEl.textContent = labels.length ? `${labels.length} selected` : `${options.length.toLocaleString()} ${plural}`;
      clearBtn.disabled = !labels.length;
    }

    function renderList() {
      const term = search.value.trim().toLowerCase();
      shownOpts = term ? options.filter((o) => (o.label + " " + (o.hint || "")).toLowerCase().includes(term)) : options;
      const frag = document.createDocumentFragment();
      shownOpts.forEach((o, i) => {
        const row = frag.appendChild(document.createElement("label"));
        row.className = "ms-opt";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(selected.has(o.value)));
        row.dataset.i = i;
        const box = row.appendChild(document.createElement("input"));
        box.type = "checkbox";
        box.tabIndex = -1;
        box.checked = selected.has(o.value);
        row.appendChild(document.createElement("span")).textContent = o.label;
        if (o.hint) {
          const h = row.appendChild(document.createElement("span"));
          h.className = "ms-hint";
          h.textContent = o.hint;
        }
      });
      if (!shownOpts.length) {
        const none = frag.appendChild(document.createElement("div"));
        none.className = "ms-empty";
        none.textContent = options.length ? `No ${plural} match "${search.value.trim()}"` : `No ${plural} to choose from`;
      }
      list.replaceChildren(frag);
      setActive(shownOpts.length ? Math.min(Math.max(active, 0), shownOpts.length - 1) : -1);
    }

    function setActive(i) {
      list.querySelector(".ms-opt.active")?.classList.remove("active");
      active = i;
      const row = list.children[i];
      if (row?.classList.contains("ms-opt")) {
        row.classList.add("active");
        row.scrollIntoView({ block: "nearest" });
      }
    }

    function toggle(i) {
      const o = shownOpts[i];
      if (!o) return;
      if (selected.has(o.value)) selected.delete(o.value);
      else selected.add(o.value);
      const row = list.children[i];
      row.querySelector("input").checked = selected.has(o.value);
      row.setAttribute("aria-selected", String(selected.has(o.value)));
      updateButton();
      onChange();
    }

    function setOpen(open) {
      if (open === !panel.hidden) return;
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) {
        search.value = "";
        active = 0;
        renderList();
        search.focus();
      }
    }

    btn.addEventListener("click", () => setOpen(panel.hidden));
    search.addEventListener("input", () => { active = 0; renderList(); });
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".ms-opt");
      if (!row) return;
      e.preventDefault(); // we toggle the box ourselves
      setActive(Number(row.dataset.i));
      toggle(Number(row.dataset.i));
    });
    root.addEventListener("keydown", (e) => {
      if (panel.hidden) {
        if (e.key === "ArrowDown" && e.target === btn) { e.preventDefault(); setOpen(true); }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (shownOpts.length) setActive((active + (e.key === "ArrowDown" ? 1 : shownOpts.length - 1)) % shownOpts.length);
      } else if (e.key === "Enter" || (e.key === " " && e.target !== search)) {
        e.preventDefault();
        toggle(active);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btn.focus();
      } else if (e.key === "Tab") {
        setOpen(false);
      }
    });
    clearBtn.addEventListener("click", () => {
      if (!selected.size) return;
      selected.clear();
      renderList();
      updateButton();
      onChange();
      search.focus();
    });
    document.addEventListener("mousedown", (e) => {
      if (!panel.hidden && !root.contains(e.target)) setOpen(false);
    });

    updateButton();
    return {
      get values() { return options.filter((o) => selected.has(o.value)).map((o) => o.value); },
      // Replaces the choices; ticked values that are no longer offered are dropped.
      setOptions(opts) {
        options = opts;
        const offered = new Set(opts.map((o) => o.value));
        for (const v of [...selected]) if (!offered.has(v)) selected.delete(v);
        if (!panel.hidden) renderList();
        updateButton();
      },
      setValues(vals) {
        selected.clear();
        const offered = new Set(options.map((o) => o.value));
        for (const v of vals || []) if (offered.has(v)) selected.add(v);
        if (!panel.hidden) renderList();
        updateButton();
      },
    };
  }

  // ---------- filters ----------
  // Saved for this browser tab after a short pause in typing (and straight
  // away when the page unloads), so a refresh shows the same cars. A link with
  // ?q=/state=/limit= overrides the saved search, state and page size.

  const DEFAULTS = { q: "", states: [], cities: [], limit: "all", offset: 0, vins: "", old: false, sort: { key: null, dir: 1 } };

  function loadFilters() {
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(FILTERS_KEY)) || {}; } catch { /* none saved */ }
    const f = { ...DEFAULTS, ...saved };
    if (typeof saved.state === "string") f.states = saved.state ? [saved.state] : []; // saved before multi-select
    const params = new URLSearchParams(location.search);
    if (["q", "state", "city", "limit", "offset", "scope"].some((k) => params.has(k))) {
      f.q = params.get("q") || "";
      f.states = params.getAll("state").filter(Boolean);
      f.cities = params.getAll("city").filter(Boolean);
      f.limit = params.get("limit") || "all";
      f.offset = Number(params.get("offset")) || 0;
      f.old = params.get("scope") === "all";
    }
    return f;
  }

  // The search, states, cities and page size as URL parameters (pasted VINs are too long).
  function filterParams() {
    const p = new URLSearchParams();
    if (q.value.trim()) p.set("q", q.value.trim());
    for (const st of stateFilter.values) p.append("state", st);
    for (const c of cityFilter.values) p.append("city", c);
    p.set("limit", limitSel.value);
    if (includeOld.checked) p.set("scope", "all");
    if (offset && limitSel.value !== "all") p.set("offset", offset);
    return p;
  }

  let restored = false; // until the state and city lists have loaded, the saved choices can't be shown yet
  function saveFiltersNow() {
    if (!restored) return;
    history.replaceState(null, "", "?" + filterParams().toString());
    const f = {
      q: q.value, states: stateFilter.values, cities: cityFilter.values,
      limit: limitSel.value, offset, vins: vinBox.value, old: includeOld.checked, sort,
    };
    try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* private mode */ }
    resetBtn.disabled = !q.value.trim() && !stateFilter.values.length && !cityFilter.values.length && limitSel.value === DEFAULTS.limit &&
      !vinBox.value.trim() && !sort.key && !includeOld.checked;
  }
  const saveFilters = debounced(saveFiltersNow, 400);

  const initial = loadFilters();

  // States and Cities: ticking states narrows the city list to those states
  // (cities ticked in other states are dropped); with no state ticked, every
  // city is listed.
  let allCities = []; // [{state, city}]
  const filtersSoon = debounced(() => reload(), 350);
  const onFilterChange = () => { saveFilters(); filtersSoon(); };
  const cityFilter = multiSelect($("city-filter"), { noun: "city", plural: "cities", onChange: onFilterChange });
  const stateFilter = multiSelect($("state-filter"), {
    noun: "state", plural: "states",
    onChange: () => { updateCityOptions(); onFilterChange(); },
  });
  function updateCityOptions() {
    const states = new Set(stateFilter.values);
    cityFilter.setOptions(allCities
      .filter((p) => !states.size || states.has(p.state))
      .map((p) => ({ value: p.state + "|" + p.city, label: p.city, hint: p.state, short: `${p.city}, ${p.state}` })));
  }
  q.value = initial.q;
  limitSel.value = initial.limit;
  if (!limitSel.value) limitSel.value = DEFAULTS.limit;
  offset = initial.offset;
  includeOld.checked = !!initial.old;
  vinBox.value = initial.vins;
  if (initial.sort && initial.sort.key && COLUMNS.some((c) => c.key === initial.sort.key)) sort = initial.sort;

  // ---------- column widths ----------
  // The table uses a fixed layout driven by a <colgroup>. An empty filler
  // column before the dibs columns soaks up spare room, so the pinned columns
  // sit at the right edge when the table is narrower than the page. When it's
  // wider, they stay stuck to the right edge while the rest scrolls.
  //
  // The notes aren't in the table: they're a separate panel (#notes-panel)
  // over the right side of it, shown with the Notes tab. Each panel row is
  // placed at its car's table row, so the two line up and scroll together.

  let widths = {};
  try { widths = JSON.parse(localStorage.getItem(WIDTHS_KEY)) || {}; } catch { /* none saved */ }
  const sizedCols = []; // {key, def, el}

  function saveWidths() {
    try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths)); } catch { /* private mode */ }
  }

  // Columns turned off in the Columns menu, by key ("vin", "dib:Mike", "note:Mike").
  let hiddenCols = new Set();
  try { hiddenCols = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []); } catch { /* all shown */ }
  const shown = (key) => !hiddenCols.has(key);

  const widthOf = (c) => (shown(c.key) ? widths[c.key] || c.def : 0);
  let notesPanelWidth = 0;

  function applyWidths() {
    let sum = 0;
    for (const c of sizedCols) {
      const w = widthOf(c);
      c.el.style.width = w + "px";
      sum += w;
    }
    table.style.width = `max(${sum}px, 100%)`;
    // Right offsets for the pinned dibs columns: the last one sits at 0.
    const pinned = pinnedCols();
    let right = 0;
    for (let i = pinned.length - 1; i >= 0; i--) {
      table.style.setProperty(`--pin-right-${i}`, right + "px");
      right += widthOf(pinned[i]);
    }
    // Notes panel column widths.
    let panel = 0;
    dibsNames.forEach((name, i) => {
      const w = widthOf({ key: "note:" + name, def: NOTE_WIDTH });
      notesPanel.style.setProperty(`--note-w-${i}`, w + "px");
      panel += w;
    });
    notesPanelWidth = panel;
    layoutNotesPanel();
  }
  const applyWidthsSoon = perFrame(applyWidths);

  // The columns stuck to the right edge, left to right.
  function pinnedCols() {
    return [
      ...dibsNames.map((name) => ({ key: "dib:" + name, def: DIB_WIDTH })),
    ];
  }

  // Which widths a grip edits: the main table's by default (the All Dibs
  // pop-up passes its own).
  const mainSizing = { widths, apply: () => applyWidths(), applySoon: applyWidthsSoon, save: saveWidths };

  // The grip sits on the column's right edge, or on its left edge (fromLeft)
  // for the notes panel, which grows leftwards. `sized` is the element whose
  // width is the column's width.
  function addResizer(th, key, { sized = th, fromLeft = false, sizing = mainSizing } = {}) {
    const { widths, apply: applyWidths, applySoon: applyWidthsSoon, save: saveWidths } = sizing;
    const grip = document.createElement("span");
    grip.className = "col-resizer" + (fromLeft ? " left" : "");
    grip.title = "Drag to resize · double-click to reset";
    grip.addEventListener("click", (e) => e.stopPropagation()); // don't sort or select
    grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      delete widths[key];
      applyWidths();
      saveWidths();
    });
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startW = sized.getBoundingClientRect().width;
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev) => {
        const dx = ev.clientX - startX;
        widths[key] = Math.max(MIN_WIDTH, Math.round(startW + (fromLeft ? -dx : dx)));
        applyWidthsSoon(); // re-layout once per frame, not per mouse event
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        document.body.classList.remove("resizing");
        applyWidths();
        saveWidths(); // once, when the drag ends
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    sized.appendChild(grip);
  }

  function buildHeader() {
    const colgroup = document.createElement("colgroup");
    const addCol = (key, def) => {
      const el = colgroup.appendChild(document.createElement("col"));
      if (key) sizedCols.push({ key, def, el });
    };

    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.scope = "col";
      th.className = "sortable";
      th.appendChild(document.createElement("span")).textContent = col.label;
      th.addEventListener("click", () => {
        sort = { key: col.key, dir: sort.key === col.key ? -sort.dir : 1 };
        saveFiltersNow();
        renderAll();
      });
      addResizer(th, col.key);
      col.th = th;
      thead.appendChild(th);
      addCol(col.key, col.w);
    }

    const waveTh = document.createElement("th");
    waveTh.scope = "col";
    waveTh.className = "dib-head wave-head";
    waveTh.appendChild(document.createElement("span")).textContent = WAVE;
    waveTh.title = `Select every ${WAVE} box shown, then press Space to tick them`;
    waveTh.addEventListener("click", () => selectDibColumn(WAVE));
    addResizer(waveTh, "wave");
    thead.appendChild(waveTh);
    addCol("wave", WAVE_WIDTH);

    const filler = document.createElement("th");
    filler.className = "filler";
    filler.setAttribute("aria-hidden", "true");
    thead.appendChild(filler);
    addCol(null);

    // Dibs columns, each pinned with its own right offset (set in applyWidths).
    const pinned = pinnedCols();
    const css = [];
    pinned.forEach((col, i) => {
      const name = dibsNames[i];
      const th = document.createElement("th");
      th.scope = "col";
      th.className = "dib-head pin";
      th.appendChild(document.createElement("span")).textContent = name;
      th.title = `Select every ${name} box shown, then press Space to tick them`;
      th.addEventListener("click", () => selectDibColumn(name));
      addResizer(th, col.key);
      thead.appendChild(th);
      addCol(col.key, col.def);
      css.push(`#cars tr > .pin:nth-last-child(${pinned.length - i}) { right: var(--pin-right-${i}); }`);
    });
    // Notes panel: a label per person over their column, and column widths.
    dibsNames.forEach((name, i) => {
      const label = notesHead.appendChild(document.createElement("div"));
      label.className = `notes-label nc-${i}`;
      label.dataset.name = name;
      label.title = `Select every ${name} note shown, then press Delete to clear them`;
      label.appendChild(document.createElement("span")).textContent = name + " Notes";
      addResizer(label, "note:" + name, { fromLeft: true });
      css.push(`#notes-panel .nc-${i} { width: var(--note-w-${i}); }`);
    });
    document.head.appendChild(document.createElement("style")).textContent = css.join("\n");

    table.prepend(colgroup);
    buildColumnMenu();
    applyColumns();
  }

  // ---------- showing and hiding columns ----------
  // A hidden column keeps its place (so every row's cells still line up with
  // the <colgroup>) but gets no width and isn't painted.

  const columnStyle = document.createElement("style");
  document.head.appendChild(columnStyle);

  // Position (1-based, counting the filler) of a column's cells in each row.
  function cellPosition(key) {
    const i = COLUMNS.findIndex((c) => c.key === key);
    if (i >= 0) return i + 1;
    if (key === "wave") return COLUMNS.length + 1;
    return COLUMNS.length + 3 + dibsNames.indexOf(key.split(":")[1]);
  }

  function applyColumns() {
    const css = [];
    for (const key of hiddenCols) {
      if (key.startsWith("note:")) {
        const i = dibsNames.indexOf(key.slice(5));
        if (i >= 0) css.push(`#notes-panel .nc-${i} { display: none; }`);
        continue;
      }
      const k = cellPosition(key);
      if (!(k > 0)) continue;
      css.push(`#cars thead tr > :nth-child(${k}), #cars tbody tr[data-vin] > :nth-child(${k}) { padding: 0; border: 0; visibility: hidden; }`);
    }
    // The shadow that marks where the pinned columns start goes on the first
    // one still showing.
    const firstDib = dibsNames.find((name) => shown("dib:" + name));
    const firstNote = dibsNames.find((name) => shown("note:" + name));
    if (firstDib) {
      css.push(`#cars tr > :nth-child(${cellPosition("dib:" + firstDib)}).pin { box-shadow: inset 1px 0 0 var(--border), -4px 0 6px -4px rgb(0 0 0 / 18%); }`);
    }
    columnStyle.textContent = css.join("\n");

    // No notes columns showing: no Notes tab either.
    notesFlag.hidden = !firstNote;
    if (!firstNote && notesOpen) setNotesOpen(false);
    if (range && !shown(dibKey(range.name))) setRange(null);
    if (noteRange && !shown("note:" + noteRange.name)) setNoteRange(null);
    applyWidths();
  }

  function saveHidden() {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenCols])); } catch { /* private mode */ }
  }

  function buildColumnMenu() {
    const groups = [
      { title: "Car details", cols: [...COLUMNS.map((c) => ({ key: c.key, label: c.label })), { key: "wave", label: WAVE }] },
      { title: "Dibs", cols: dibsNames.map((name) => ({ key: "dib:" + name, label: name })) },
      { title: "Notes", cols: dibsNames.map((name) => ({ key: "note:" + name, label: name + " Notes" })) },
    ];
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const fs = frag.appendChild(document.createElement("fieldset"));
      fs.appendChild(document.createElement("legend")).textContent = g.title;
      for (const c of g.cols) {
        const label = fs.appendChild(document.createElement("label"));
        const box = label.appendChild(document.createElement("input"));
        box.type = "checkbox";
        box.dataset.key = c.key;
        box.checked = shown(c.key);
        label.append(" " + c.label);
      }
    }
    const foot = frag.appendChild(document.createElement("div"));
    foot.className = "col-menu-foot";
    const all = foot.appendChild(document.createElement("button"));
    all.type = "button";
    all.className = "btn secondary";
    all.textContent = "Show all columns";
    all.addEventListener("click", () => {
      hiddenCols.clear();
      for (const box of colMenuPanel.querySelectorAll("input[data-key]")) box.checked = true;
      saveHidden();
      applyColumns();
    });
    colMenuPanel.replaceChildren(frag);

    colMenuPanel.addEventListener("change", (e) => {
      const key = e.target.dataset?.key;
      if (!key) return;
      if (e.target.checked) hiddenCols.delete(key);
      else hiddenCols.add(key);
      saveHidden();
      applyColumns();
    });
  }

  function setColMenuOpen(open) {
    colMenuPanel.hidden = !open;
    colMenuBtn.setAttribute("aria-expanded", String(open));
  }
  colMenuBtn.addEventListener("click", () => setColMenuOpen(colMenuPanel.hidden));
  document.addEventListener("mousedown", (e) => {
    if (!colMenuPanel.hidden && !e.target.closest?.("#col-menu")) setColMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !colMenuPanel.hidden) {
      setColMenuOpen(false);
      colMenuBtn.focus();
    }
  });

  // ---------- dibs state ----------

  function hasSavedDib(car, name) {
    return name === WAVE ? !!car.wave : car.dibs.some((d) => d.name === name);
  }

  function isChecked(car, name) {
    const p = pending.get(keyOf(car.vin, name));
    return p ? p.claim : hasSavedDib(car, name);
  }

  // Sets a dibs box (drawn or not) and records it as a pending change, or
  // drops the change if it's back to what's saved.
  function setDib(car, name, checked) {
    const key = keyOf(car.vin, name);
    pending.delete(key); // re-add so the Map keeps the order of the latest clicks
    if (checked !== hasSavedDib(car, name)) pending.set(key, { vin: car.vin, name, claim: checked });
    const td = cellFor(car.vin, "dib", name);
    if (td) {
      td.firstElementChild.checked = checked;
      paintDibCell(td, car, name);
    }
  }

  // Colours the cell by when this person's dibs was saved, relative to the
  // car's other dibs: 1st green, 2nd blue, 3rd yellow, 4th orange.
  function paintDibCell(td, car, name) {
    if (name === WAVE) {
      td.className = "dib wave" + (car.wave ? " wave-on" : "");
      if (inRange(range, idxOf.get(car.vin), name)) td.classList.add("range-selected");
      td.title = car.wave ? `${WAVE}: ticked ${new Date(car.wave.at).toLocaleString()}${car.wave.by ? ` by ${car.wave.by}` : ""}` : `Tick for ${WAVE}`;
      const p = pending.get(keyOf(car.vin, name));
      if (p) {
        td.classList.add("pending");
        td.title += p.claim ? " (not saved yet)" : " (untick not saved yet)";
      }
      return;
    }
    const idx = car.dibs.findIndex((d) => d.name === name);
    td.className = "dib pin";
    if (inRange(range, idxOf.get(car.vin), name)) td.classList.add("range-selected");
    if (idx >= 0) {
      td.classList.add("dib-" + Math.min(idx + 1, 4));
      const at = new Date(car.dibs[idx].at).toLocaleString();
      td.title = `${name}: ${ORDINALS[idx] || idx + 1 + "th"} dibs, called ${at}`;
    } else {
      td.title = `Call dibs for ${name}`;
    }
    const p = pending.get(keyOf(car.vin, name));
    if (p) {
      td.classList.add("pending");
      td.title += p.claim ? " (not saved yet)" : " (release not saved yet)";
    }
  }

  // ---------- rows ----------

  const editable = (() => {
    const probe = document.createElement("div");
    probe.contentEditable = "plaintext-only";
    return probe.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
  })();

  function buildRow(car) {
    const tr = document.createElement("tr");
    tr.dataset.vin = car.vin;
    if (!car.inLatest && latestImport) tr.className = "old-car";
    for (const col of COLUMNS) {
      const td = document.createElement("td");
      const v = car[col.key] ?? "";
      td.textContent = col.fmt ? col.fmt(v) : v;
      if (col.num) td.className = "num";
      else td.title = td.textContent; // full text when the column is too narrow
      if (col.mono) td.className = "mono";
      tr.appendChild(td);
    }
    if (cellRange) paintCellRow(tr, idxOf.get(car.vin));
    for (const name of [WAVE, null, ...dibsNames]) {
      if (name === null) {
        tr.appendChild(document.createElement("td")).className = "filler";
        continue;
      }
      const td = document.createElement("td");
      td.dataset.name = name;
      const box = td.appendChild(document.createElement("input"));
      box.type = "checkbox";
      box.dataset.name = name;
      box.checked = isChecked(car, name);
      box.setAttribute("aria-label", name === WAVE ? `${WAVE} for ${car.vin}` : `${name} dibs on ${car.vin}`);
      paintDibCell(td, car, name);
      tr.appendChild(td);
    }
    return tr;
  }

  // A car's row in the notes panel: one editable cell per person.
  function buildNoteRow(car) {
    const row = document.createElement("div");
    row.className = "note-row";
    row.dataset.vin = car.vin;
    dibsNames.forEach((name, i) => {
      const cell = row.appendChild(document.createElement("div"));
      cell.className = `note-cell nc-${i}`;
      cell.dataset.name = name;
      const div = cell.appendChild(document.createElement("div"));
      div.className = "note-text";
      div.contentEditable = editable;
      div.spellcheck = false;
      div.setAttribute("role", "textbox");
      div.setAttribute("aria-label", `${name} notes on ${car.vin}`);
      div.dataset.placeholder = name;
      div.textContent = car.notes[name] || "";
      cell.title = div.textContent;
      if (fill && inRange(fill, idxOf.get(car.vin), name)) cell.classList.add("fill-target");
      if (noteRange && inRange(noteRange, idxOf.get(car.vin), name)) cell.classList.add("range-selected");
      if (selected && selected.vin === car.vin && selected.name === name) selectNoteCell(cell);
    });
    return row;
  }

  // Drawn rows: vin → tr, for view[winStart .. winEnd).
  let drawn = new Map(), winStart = 0, winEnd = 0;
  let rowH = 40; // measured after the first draw
  const topSpacer = document.createElement("tr"), bottomSpacer = document.createElement("tr");
  topSpacer.className = bottomSpacer.className = "spacer";
  topSpacer.setAttribute("aria-hidden", "true");
  bottomSpacer.setAttribute("aria-hidden", "true");
  topSpacer.appendChild(document.createElement("td"));
  bottomSpacer.appendChild(document.createElement("td"));

  // A drawn cell: kind "dib" (table) or "note" (notes panel).
  function cellFor(vin, kind, name) {
    const row = kind === "note" ? drawnNotes.get(vin) : drawn.get(vin);
    const sel = kind === "note" ? ".note-cell" : "td.dib";
    return row ? row.querySelector(`${sel}[data-name="${CSS.escape(name)}"]`) : null;
  }

  function retire(tr) {
    tr.remove();
  }

  // ---------- notes panel rows ----------
  // Mirrors the drawn table rows. Rows are reused by VIN (so a cell being
  // typed in keeps focus), and each is placed at its table row's position.

  let drawnNotes = new Map(); // vin → .note-row

  function retireNote(row) {
    const active = document.activeElement;
    if (active && row.contains(active) && active.classList.contains("note-text")) commitNote(noteTd(active));
    row.remove();
  }

  function drawNotes(force) {
    if (!notesOpen || !view.length) {
      for (const row of drawnNotes.values()) retireNote(row);
      drawnNotes = new Map();
      return;
    }
    const active = document.activeElement;
    const next = new Map();
    const frag = document.createDocumentFragment();
    for (const vin of drawn.keys()) {
      let row = drawnNotes.get(vin);
      if (row && force && !row.contains(active)) {
        retireNote(row);
        row = null;
      }
      if (!row) {
        row = buildNoteRow(byVIN.get(vin));
        frag.appendChild(row);
      }
      next.set(vin, row);
    }
    for (const [vin, row] of drawnNotes) if (!next.has(vin)) retireNote(row);
    drawnNotes = next;
    notesRows.appendChild(frag);
    positionNotes();
  }

  // Puts each panel row level with its table row (reads layout once).
  function positionNotes() {
    if (!drawnNotes.size) return;
    const headH = theadEl.offsetHeight;
    const spots = [];
    for (const [vin, tr] of drawn) spots.push([drawnNotes.get(vin), tr.offsetTop - headH, tr.offsetHeight]);
    for (const [row, top, h] of spots) {
      if (!row) continue;
      row.style.top = top + "px";
      row.style.height = h + "px";
    }
    syncNotesScroll();
  }

  function syncNotesScroll() {
    notesRows.style.transform = `translateY(${-wrap.scrollTop}px)`;
  }

  // Draws the rows in view. With force, every row is rebuilt (after the data
  // or order changed); otherwise rows already drawn are kept as they are.
  function drawWindow(force) {
    if (!view.length) return;
    const top = Math.max(0, wrap.scrollTop - theadEl.offsetHeight);
    const visible = Math.ceil(wrap.clientHeight / rowH) + 1;
    const start = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const end = Math.min(view.length, start + visible + OVERSCAN * 2);
    if (!force && start === winStart && end === winEnd && drawn.size) return;

    if (force || end <= winStart || start >= winEnd || !drawn.size) {
      for (const tr of drawn.values()) retire(tr);
      drawn = new Map();
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const tr = buildRow(view[i]);
        drawn.set(view[i].vin, tr);
        frag.appendChild(tr);
      }
      tbody.replaceChildren(topSpacer, frag, bottomSpacer);
    } else {
      // Keep the overlap in place (so a cell being typed in keeps focus),
      // drop rows that scrolled out, and add the ones that scrolled in.
      for (let i = winStart; i < start; i++) { retire(drawn.get(view[i].vin)); drawn.delete(view[i].vin); }
      for (let i = end; i < winEnd; i++) { retire(drawn.get(view[i].vin)); drawn.delete(view[i].vin); }
      const before = document.createDocumentFragment();
      for (let i = start; i < Math.min(winStart, end); i++) {
        const tr = buildRow(view[i]);
        drawn.set(view[i].vin, tr);
        before.appendChild(tr);
      }
      topSpacer.after(before);
      const after = document.createDocumentFragment();
      for (let i = Math.max(winEnd, start); i < end; i++) {
        const tr = buildRow(view[i]);
        drawn.set(view[i].vin, tr);
        after.appendChild(tr);
      }
      bottomSpacer.before(after);
    }
    winStart = start;
    winEnd = end;
    topSpacer.firstChild.style.height = start * rowH + "px";
    bottomSpacer.firstChild.style.height = (view.length - end) * rowH + "px";
    topSpacer.hidden = start === 0;
    bottomSpacer.hidden = end === view.length;
    drawNotes(force);
  }
  const drawWindowSoon = perFrame(() => drawWindow(false));
  wrap.addEventListener("scroll", () => {
    syncNotesScroll(); // keep the notes level with the table on every scroll step
    drawWindowSoon();
  }, { passive: true });
  window.addEventListener("resize", drawWindowSoon);

  function measureRows() {
    const tr = drawn.values().next().value;
    if (!tr) return;
    const h = tr.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - rowH) > 0.5) {
      rowH = h;
      drawWindow(true);
    }
  }

  // Scrolls so view[i] is on screen and drawn.
  function revealRow(i) {
    const headH = theadEl.offsetHeight;
    const rowTop = headH + i * rowH;
    if (rowTop < wrap.scrollTop + headH) wrap.scrollTop = i * rowH;
    else if (rowTop + rowH > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = rowTop + rowH - wrap.clientHeight;
    drawWindow(false);
  }

  // Rebuilds the view after the cars, their order or the saved dibs changed.
  function renderAll() {
    for (const col of COLUMNS) {
      col.th.setAttribute("aria-sort", sort.key === col.key ? (sort.dir > 0 ? "ascending" : "descending") : "none");
    }

    view = rows;
    if (sort.key) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      const cmp = col.num
        ? (a, b) => (Number(a[col.key]) - Number(b[col.key])) * sort.dir
        : (a, b) => collator.compare(String(a[col.key]), String(b[col.key])) * sort.dir;
      view = [...rows].sort(cmp);
    }
    idxOf = new Map(view.map((c, i) => [c.vin, i]));
    range = null;
    anchor = null;
    noteRange = null;
    noteAnchor = null;
    cellRange = null;
    cellAnchor = null;

    if (!view.length) {
      for (const tr of drawn.values()) retire(tr);
      drawn = new Map();
      winStart = winEnd = 0;
      drawNotes(true);
      const td = document.createElement("td");
      td.className = "empty";
      td.colSpan = COLUMNS.length + 2 + dibsNames.length; // + 2nd Wave and the filler
      const filtered = q.value.trim() || stateFilter.values.length || cityFilter.values.length || parseVINs(vinBox.value).length;
      td.textContent = filtered ? "No cars match those filters." : "No cars in the database yet.";
      const tr = document.createElement("tr");
      tr.appendChild(td);
      tbody.replaceChildren(tr);
    } else {
      drawWindow(true);
      measureRows();
    }
    layoutNotesPanel();
    updateRangeHint();

    const all = limitSel.value === "all";
    const limit = Number(limitSel.value);
    const from = total ? offset + 1 : 0;
    const to = Math.min(offset + rows.length, total);
    count.textContent = countText();
    pager.hidden = all || total <= limit;
    pageInfo.textContent = total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : "";
    prev.disabled = offset === 0;
    next.disabled = offset + limit >= total;
    updatePending();
  }

  // "4,266 cars on the Nov 18, 2:31 PM nationwide sheet", or for a search or
  // "Include older cars", how many of the matches are older (grey) ones.
  function countText() {
    const n = `${total.toLocaleString()} car${total === 1 ? "" : "s"}`;
    if (!latestImport) return n;
    const when = new Date(latestImport.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (scope === "latest") return `${n} on the ${when} nationwide sheet`;
    const old = rows.reduce((k, c) => k + (c.inLatest ? 0 : 1), 0);
    return old ? `${n} (${old.toLocaleString()} older, in grey)` : n;
  }

  // Index of the car a cell belongs to, in view.
  const rowIndex = (el) => idxOf.get(el.closest("[data-vin]")?.dataset.vin);

  // The data row under the pointer (or nearest the table's top/bottom edge).
  // The part of the table's rows area that's actually on screen: the box can
  // run below the bottom of the window, or under the sticky top bar.
  function visibleRowsArea() {
    const rect = wrap.getBoundingClientRect();
    const topbar = document.getElementById("topbar")?.getBoundingClientRect().bottom || 0;
    return {
      left: rect.left, right: rect.right,
      top: Math.max(rect.top + theadEl.offsetHeight, topbar),
      bottom: Math.min(rect.bottom, window.innerHeight),
    };
  }

  function rowIndexAt(x, y) {
    const rect = visibleRowsArea();
    const cy = Math.min(Math.max(y, rect.top + 1), rect.bottom - 2);
    const row = document.elementFromPoint(Math.min(Math.max(x, rect.left + 1), rect.right - 2), cy)
      ?.closest("#cars tbody tr[data-vin], .note-row");
    return row ? idxOf.get(row.dataset.vin) : undefined;
  }

  // Scrolls the table while the pointer is held near its top or bottom edge,
  // calling onScroll after each step. It only starts once the pointer has
  // moved a few pixels from (x0, y0), so a plain click never scrolls.
  // Returns {move(x, y), stop()}.
  function edgeScroller(x0, y0, onScroll) {
    let x = x0, y = y0, raf = 0, armed = false;
    const tick = () => {
      if (!armed) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const { top, bottom } = visibleRowsArea();
      const edge = 32;
      let dy = 0;
      if (y > bottom - edge) dy = Math.min(40, (y - (bottom - edge)) / 2 + 4);
      else if (y < top + edge) dy = -Math.min(40, (top + edge - y) / 2 + 4);
      if (dy) {
        wrap.scrollTop += dy;
        drawWindow(false);
        onScroll(x, y);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return {
      move(nx, ny) {
        x = nx;
        y = ny;
        if (Math.abs(x - x0) + Math.abs(y - y0) > 4) armed = true;
      },
      stop() { cancelAnimationFrame(raf); },
    };
  }

  // ---------- notes ----------
  // Each notes cell holds an editable div. Edits save on their own (no
  // button) a moment after leaving the cell. The selected cell shows a fill
  // handle in its corner: drag it down to copy the text into the cells below.

  const noteDiv = (td) => td.querySelector(".note-text");
  const noteTd = (div) => div.closest(".note-cell");
  const cleanNote = (text) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const cellCar = (td) => byVIN.get(td.closest("[data-vin]")?.dataset.vin);

  function caretToEnd(div) {
    div.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(div);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }

  function setNoteText(td, text) {
    const div = noteDiv(td);
    if (document.activeElement !== div) div.textContent = text;
    td.title = text;
  }

  // Saves the cell's text if it changed.
  function commitNote(td) {
    const car = cellCar(td);
    if (!car) return;
    const name = td.dataset.name;
    const div = noteDiv(td);
    const text = cleanNote(div.textContent);
    if (div.textContent !== text) div.textContent = text;
    td.title = text;
    if (text === (car.notes[name] || "")) return;
    car.notes[name] = text;
    queueNotes([{ vin: car.vin, name, note: text }]);
  }

  // Unsaved note changes: "vin\tname" → {vin, name, note}.
  const noteQueue = new Map();
  let noteTimer = null, noteSaving = false, notesOK = 0;
  let noteKeepalive = false; // the request in flight will finish even if the page unloads

  function queueNotes(changes, now) {
    for (const c of changes) {
      const key = keyOf(c.vin, c.name);
      noteQueue.delete(key);
      noteQueue.set(key, c);
    }
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNotes, now ? 0 : 400);
    showNotesState("Saving notes…", "");
  }

  function showNotesState(text, kind) {
    notesState.textContent = text;
    notesState.className = "notes-state" + (kind ? " " + kind : "");
  }

  async function flushNotes() {
    if (noteSaving || !noteQueue.size) return;
    const changes = [...noteQueue.values()];
    noteQueue.clear();
    noteSaving = true;
    const body = JSON.stringify({ updatedBy: SF.store.get("username") || "", changes });
    // keepalive lets a save finish during a page refresh (browsers cap it at 64 KB).
    noteKeepalive = body.length < 60000;
    try {
      const res = await SF.fetchJSON("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: noteKeepalive,
      });
      notesOK += changes.length;
      // Take the server's copy (it may include other people's edits), except
      // for cells that have changed again since this request went out.
      for (const [vin, notes] of Object.entries(res.notes)) {
        const car = byVIN.get(vin);
        if (!car) continue;
        for (const name of dibsNames) {
          if (noteQueue.has(keyOf(vin, name))) continue;
          car.notes[name] = notes[name] || "";
          const td = cellFor(vin, "note", name);
          if (td) setNoteText(td, car.notes[name]);
        }
      }
      if (!noteQueue.size) {
        showNotesState(`Notes saved${notesOK > 1 ? ` (${notesOK.toLocaleString()} cells)` : ""}.`, "ok");
        notesOK = 0;
      }
    } catch (err) {
      for (const c of changes) {
        const key = keyOf(c.vin, c.name);
        if (!noteQueue.has(key)) noteQueue.set(key, c);
      }
      showNotesState(`Notes not saved: ${err.message}. Retrying…`, "err");
      clearTimeout(noteTimer);
      noteTimer = setTimeout(flushNotes, 10000);
    } finally {
      noteSaving = false;
      if (noteQueue.size && !notesState.classList.contains("err")) flushNotes();
    }
  }

  // Selected notes cell (survives redrawing) and its fill handle.
  let selected = null; // {vin, name}
  let fill = null; // {name, from, to}: cells highlighted while dragging the fill handle
  const fillHandle = document.createElement("span");
  fillHandle.className = "fill-handle";
  fillHandle.title = "Drag down to copy this note into the cells below";

  function selectNoteCell(td) {
    const prevTd = fillHandle.closest(".note-cell");
    if (prevTd && prevTd !== td) prevTd.classList.remove("selected");
    td.classList.add("selected");
    td.appendChild(fillHandle);
    selected = { vin: td.closest("[data-vin]")?.dataset.vin ?? selected?.vin, name: td.dataset.name };
  }

  // Un-highlights the selected notes cell and removes its fill handle.
  function clearNoteSelection() {
    fillHandle.closest(".note-cell")?.classList.remove("selected");
    fillHandle.remove();
    selected = null;
  }

  notesRows.addEventListener("focusin", (e) => {
    if (e.target.classList?.contains("note-text")) selectNoteCell(noteTd(e.target));
  });
  notesRows.addEventListener("focusout", (e) => {
    if (e.target.classList?.contains("note-text") && e.target.isConnected) commitNote(noteTd(e.target));
  });

  notesRows.addEventListener("keydown", (e) => {
    const div = e.target;
    if (!div.classList?.contains("note-text")) return;
    const td = noteTd(div);
    if (e.key === "Escape") {
      div.textContent = cellCar(td)?.notes[td.dataset.name] || "";
      div.blur();
    } else if (e.key === "Enter") {
      // Like Excel: Enter saves and moves down, Shift+Enter moves up.
      e.preventDefault();
      const name = td.dataset.name;
      const i = rowIndex(td) + (e.shiftKey ? -1 : 1);
      if (i < 0 || i >= view.length) {
        div.blur();
        return;
      }
      commitNote(td);
      revealRow(i);
      const nextTd = cellFor(view[i].vin, "note", name);
      if (nextTd) caretToEnd(noteDiv(nextTd));
    }
  });

  // Paste as plain text on one line, whatever the browser supports.
  notesRows.addEventListener("paste", (e) => {
    if (!e.target.closest?.(".note-text")) return;
    e.preventDefault();
    document.execCommand("insertText", false, cleanNote(e.clipboardData.getData("text/plain")));
  });

  function paintFill() {
    for (const [vin, row] of drawnNotes) {
      const i = idxOf.get(vin);
      for (const cell of row.children) {
        cell.classList.toggle("fill-target", !!fill && inRange(fill, i, cell.dataset.name));
      }
    }
  }

  fillHandle.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus where it is
  fillHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const source = fillHandle.closest(".note-cell");
    if (!source) return;
    if (document.activeElement === noteDiv(source)) noteDiv(source).blur(); // commits it
    const car = cellCar(source), name = source.dataset.name;
    if (!car) return;
    const text = car.notes[name] || "";
    const from = idxOf.get(car.vin);

    // Listen on the window: the source row may scroll out and be removed.
    const update = (x, y) => {
      const to = rowIndexAt(x, y);
      if (to === undefined) return;
      fill = to > from ? { name, from: from + 1, to } : null;
      paintFill();
    };
    let lastX = e.clientX, lastY = e.clientY;
    const updateSoon = perFrame(() => update(lastX, lastY));
    const scroller = edgeScroller(lastX, lastY, update);
    document.body.classList.add("filling");

    const move = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      scroller.move(lastX, lastY);
      updateSoon();
    };
    const end = (ev) => {
      scroller.stop();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("filling");
      const done = fill;
      fill = null;
      paintFill();
      if (ev.type === "pointercancel" || !done) return;

      const changes = [];
      for (let i = done.from; i <= done.to; i++) {
        const c = view[i];
        if ((c.notes[name] || "") === text) continue;
        c.notes[name] = text;
        const td = cellFor(c.vin, "note", name);
        if (td) setNoteText(td, text);
        changes.push({ vin: c.vin, name, note: text });
      }
      if (changes.length) queueNotes(changes, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  // ---------- notes tab ----------

  let notesOpen = false;
  try { notesOpen = localStorage.getItem(NOTES_OPEN_KEY) === "1"; } catch { /* closed */ }

  // The panel covers the right side of the table, inside its scrollbars, with
  // a label strip level with the table's heading row. The tab sits just right
  // of the table when the panel is in, and on the panel's left edge when out.
  function layoutNotesPanel() {
    // Inside the table box's border and its vertical scrollbar.
    const right = wrap.offsetWidth - wrap.clientWidth - wrap.clientLeft;
    notesFlag.style.right = notesOpen ? `${notesPanelWidth + right}px` : "";
    if (!notesOpen) return;
    const headH = theadEl.offsetHeight;
    notesPanel.style.top = wrap.clientTop + "px";
    notesPanel.style.right = right + "px";
    notesPanel.style.width = notesPanelWidth + "px";
    notesPanel.style.height = wrap.clientHeight + "px";
    notesHead.style.height = headH + "px";
    notesBody.style.top = headH + "px";
    positionNotes();
  }

  function setNotesOpen(open) {
    notesOpen = open;
    const active = document.activeElement;
    if (!open && active?.classList.contains("note-text")) active.blur(); // saves it
    if (!open) clearNoteSelection();
    if (!open && noteRange) setNoteRange(null); // never leave hidden notes selected for Delete
    notesPanel.hidden = !open;
    if (dibsNames) drawNotes(true);
    notesFlag.classList.toggle("open", open);
    notesFlag.setAttribute("aria-expanded", String(open));
    notesFlag.title = open ? "Hide the notes" : "Show everyone's notes";
    try { localStorage.setItem(NOTES_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode */ }
    layoutNotesPanel();
  }
  notesFlag.addEventListener("click", () => setNotesOpen(!notesOpen));
  window.addEventListener("resize", perFrame(layoutNotesPanel));

  // The panel sits over the table, so pass its wheel scrolling through.
  notesPanel.addEventListener("wheel", (e) => {
    e.preventDefault();
    wrap.scrollTop += e.deltaY;
    wrap.scrollLeft += e.deltaX;
  }, { passive: false });


  // ---------- selecting a run of notes ----------
  // Drag down a notes column, Shift+click a second note, or click the
  // column's label to select notes; Delete or Backspace then clears them all
  // (saved straight away, with an Undo). A plain click still edits the note.

  let noteRange = null; // {name, from, to} over view indices
  let noteAnchor = null; // {i, name}: the note last clicked
  let lastClear = null; // {name, items: [{vin, note}]}: what Undo puts back
  let undoTimer = null;

  function paintNoteRange() {
    for (const [vin, row] of drawnNotes) {
      const i = idxOf.get(vin);
      for (const cell of row.children) {
        cell.classList.toggle("range-selected", inRange(noteRange, i, cell.dataset.name));
      }
    }
  }

  function setNoteRange(r) {
    noteRange = r;
    if (r) {
      if (range) setRange(null);
      if (cellRange) setCellRange(null);
      clearNoteSelection();
    }
    paintNoteRange();
    updateRangeHint();
  }

  function selectNoteColumn(name) {
    if (!view.length) return;
    document.activeElement?.blur?.(); // saves a note being typed
    noteAnchor = null;
    setNoteRange({ name, from: 0, to: view.length - 1 });
  }

  function filledInNoteRange() {
    let n = 0;
    for (let i = noteRange.from; i <= noteRange.to; i++) if (view[i].notes[noteRange.name]) n++;
    return n;
  }

  notesPanel.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const label = e.target.closest?.(".notes-label");
    if (label) {
      if (!e.target.closest(".col-resizer")) {
        e.preventDefault();
        selectNoteColumn(label.dataset.name);
      }
      return;
    }
    const cell = e.target.closest?.(".note-cell");
    if (!cell || e.target === fillHandle) return;
    if (range) setRange(null);
    if (cellRange) setCellRange(null);
    const i = rowIndex(cell), name = cell.dataset.name;

    if (e.shiftKey) {
      const from = noteAnchor?.name === name ? noteAnchor.i
        : selected?.name === name ? idxOf.get(selected.vin) : undefined;
      if (from !== undefined) {
        e.preventDefault(); // select, don't edit
        document.activeElement?.blur?.();
        setNoteRange({ name, from: Math.min(from, i), to: Math.max(from, i) });
        return;
      }
    }
    const inSel = inRange(noteRange, i, name);
    if (noteRange && !inSel) setNoteRange(null);
    noteAnchor = { i, name };
    // Inside the selected run a click keeps it (double-click to edit);
    // elsewhere, clicking a cell's padding puts the caret in its text.
    if (inSel) {
      e.preventDefault();
    } else if (!e.target.classList.contains("note-text")) {
      e.preventDefault();
      caretToEnd(noteDiv(cell));
    }

    // Dragging onto another row turns the click into a range selection.
    let lastX = e.clientX, lastY = e.clientY, ranging = false;
    const update = (x, y) => {
      const j = rowIndexAt(x, y);
      if (j === undefined || (j === i && !ranging)) return;
      if (!ranging) {
        ranging = true;
        document.activeElement?.blur?.(); // saves the note it started in
        getSelection().removeAllRanges();
        document.body.classList.add("selecting");
      }
      noteRange = { name, from: Math.min(i, j), to: Math.max(i, j) };
      clearNoteSelection();
      paintNoteRange();
      updateRangeHintSoon();
    };
    const updateSoon = perFrame(() => update(lastX, lastY));
    const scroller = edgeScroller(lastX, lastY, update);
    const move = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      scroller.move(lastX, lastY);
      updateSoon();
    };
    const up = () => {
      scroller.stop();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!ranging) return;
      document.body.classList.remove("selecting");
      getSelection().removeAllRanges();
      if (range) setRange(null);
      updateRangeHintSoon.flush();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  notesPanel.addEventListener("dblclick", (e) => {
    const cell = e.target.closest?.(".note-cell");
    if (!cell || !noteRange || !inRange(noteRange, rowIndex(cell), cell.dataset.name)) return;
    setNoteRange(null);
    caretToEnd(noteDiv(cell));
  });

  // Empties every note in the selected run and saves straight away.
  function clearNoteRange() {
    const { name, from, to } = noteRange;
    const items = [], changes = [];
    for (let i = from; i <= to; i++) {
      const car = view[i];
      const old = car.notes[name] || "";
      if (!old) continue;
      items.push({ vin: car.vin, note: old });
      car.notes[name] = "";
      const cell = cellFor(car.vin, "note", name);
      if (cell) setNoteText(cell, "");
      changes.push({ vin: car.vin, name, note: "" });
    }
    updateRangeHint();
    if (!changes.length) {
      showNotesState("Nothing to clear: those notes are already empty.", "");
      return;
    }
    queueNotes(changes, true);
    lastClear = { name, items };
    notesUndo.textContent = `Undo clearing ${items.length.toLocaleString()} note${items.length === 1 ? "" : "s"}`;
    notesUndo.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { notesUndo.hidden = true; lastClear = null; }, 60000);
  }

  // Puts the cleared notes back, unless someone has typed a new one since.
  notesUndo.addEventListener("click", () => {
    if (!lastClear) return;
    const { name, items } = lastClear;
    lastClear = null;
    notesUndo.hidden = true;
    clearTimeout(undoTimer);
    const changes = [];
    for (const { vin, note } of items) {
      const car = byVIN.get(vin);
      if (car) {
        if (car.notes[name]) continue;
        car.notes[name] = note;
        const cell = cellFor(vin, "note", name);
        if (cell) setNoteText(cell, note);
      }
      changes.push({ vin, name, note });
    }
    if (changes.length) queueNotes(changes, true);
    if (noteRange) updateRangeHint();
  });

  document.addEventListener("keydown", (e) => {
    if (!noteRange || typingInField(document.activeElement)) return;
    if (e.key === "Escape") {
      setNoteRange(null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (!e.repeat) clearNoteRange();
    }
  });

  setNotesOpen(notesOpen); // after the notes-range state above exists

  // ---------- pending dibs ----------

  function updatePending() {
    const n = pending.size;
    saveBtn.disabled = n === 0;
    discardBtn.hidden = n === 0;
    if (!n) {
      pendingNote.textContent = "";
      return;
    }
    let hidden = 0;
    for (const p of pending.values()) if (!byVIN.has(p.vin)) hidden++;
    pendingNote.textContent = `${n} unsaved change${n === 1 ? "" : "s"}` +
      (hidden ? ` (${hidden} not shown with the current filters)` : "");
  }

  tbody.addEventListener("change", (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
    setDib(cellCar(box), box.dataset.name, box.checked);
    updatePending();
    if (range) updateRangeHint();
  });

  // ---------- selecting a run of dibs boxes ----------
  // Drag down a dibs column, Shift+click a second box, or click the column
  // heading to select boxes; Space then ticks them all (or unticks them if
  // they're all ticked already). Nothing is saved until Call Dibs.

  let range = null; // {name, from, to} over view indices
  let anchor = null; // {i, name}: where the last click or drag started
  let dragging = null, dragged = false; // dragging: the edge scroller while a drag is on

  function inRange(r, i, name) {
    return !!r && r.name === name && i >= r.from && i <= r.to;
  }

  function setRange(r) {
    range = r;
    if (r && noteRange) setNoteRange(null);
    if (r && cellRange) setCellRange(null);
    for (const [vin, tr] of drawn) {
      const i = idxOf.get(vin);
      for (const td of tr.querySelectorAll("td.dib")) {
        td.classList.toggle("range-selected", inRange(range, i, td.dataset.name));
      }
    }
    updateRangeHint();
  }

  function selectRows(a, b, name) {
    if (a === undefined || b === undefined) return;
    setRange({ name, from: Math.min(a, b), to: Math.max(a, b) });
  }

  function selectDibColumn(name) {
    if (!view.length) return;
    clearNoteSelection();
    setRange({ name, from: 0, to: view.length - 1 });
    anchor = null;
    document.activeElement?.blur?.(); // so Space reaches the page, not a text box
  }

  function rangeAllTicked() {
    for (let i = range.from; i <= range.to; i++) if (!isChecked(view[i], range.name)) return false;
    return true;
  }

  function updateRangeHint() {
    if (cellRange) {
      const rowsN = cellRange.to - cellRange.from + 1;
      const cols = selectedColumns().length;
      const what = rowsN === 1 && cols === 1 ? "1 cell"
        : `${rowsN.toLocaleString()} row${rowsN === 1 ? "" : "s"} × ${cols} column${cols === 1 ? "" : "s"}`;
      rangeHint.textContent = `${what} selected: press ${COPY_KEYS} to copy`;
      return;
    }
    if (noteRange) {
      const n = noteRange.to - noteRange.from + 1, filled = filledInNoteRange();
      rangeHint.textContent = `${n.toLocaleString()} ${noteRange.name} note${n === 1 ? "" : "s"} selected` +
        (filled ? ` (${filled.toLocaleString()} filled in): press Delete to clear them, or ${COPY_KEYS} to copy` : " (all empty)");
      return;
    }
    if (!range) {
      rangeHint.textContent = "";
      return;
    }
    const n = range.to - range.from + 1;
    rangeHint.textContent = `${n.toLocaleString()} ${range.name} box${n === 1 ? "" : "es"} selected: ` +
      `press Space to ${rangeAllTicked() ? "untick" : "tick"} them`;
  }
  const updateRangeHintSoon = debounced(updateRangeHint, 120);

  // Like Excel, clicking a cell starts a new selection: the old dibs range
  // and the old notes cell are un-highlighted first (Shift+click on a dibs
  // box extends the range instead).
  tbody.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (noteRange) setNoteRange(null);
    const dataTd = e.target.closest?.("tr[data-vin] > td");
    if (dataTd && dataTd.cellIndex < COLUMNS.length) {
      startCellSelection(e, dataTd);
      return;
    }
    if (cellRange) setCellRange(null);
    const td = e.target.closest?.("td.dib");
    if (!td) {
      if (range) setRange(null);
      if (e.target.closest?.("tr")?.dataset.vin) clearNoteSelection();
      return;
    }
    e.preventDefault(); // no text selection, and keep Space away from the checkbox
    document.activeElement?.blur?.(); // saves a note being typed
    clearNoteSelection();
    const i = rowIndex(td), name = td.dataset.name;
    dragged = false;
    if (e.shiftKey && anchor && anchor.name === name) {
      selectRows(anchor.i, i, name);
      dragged = true; // a Shift+click selects instead of toggling
      return;
    }
    // Clicking inside the highlighted run keeps it (ticking a box there
    // changes only that box). Elsewhere, the box itself just toggles, and the
    // cell around it selects that one box; only the box changes a tick.
    if (!inRange(range, i, name)) setRange(e.target === td.firstElementChild ? null : { name, from: i, to: i });
    anchor = { i, name };
    const update = (x, y) => {
      const j = rowIndexAt(x, y);
      if (j === undefined || (j === anchor.i && !dragged)) return;
      dragged = true;
      // Highlight the drawn cells now; work out the hint once the drag pauses.
      range = { name, from: Math.min(anchor.i, j), to: Math.max(anchor.i, j) };
      for (const vin of drawn.keys()) {
        cellFor(vin, "dib", name)?.classList.toggle("range-selected", inRange(range, idxOf.get(vin), name));
      }
      updateRangeHintSoon();
    };
    let lastX = e.clientX, lastY = e.clientY;
    const updateSoon = perFrame(() => update(lastX, lastY));
    const scroller = edgeScroller(lastX, lastY, update);
    dragging = {
      stop: () => scroller.stop(),
      onMove(x, y) {
        lastX = x;
        lastY = y;
        scroller.move(x, y);
        updateSoon();
      },
    };
  });

  document.addEventListener("mousemove", (e) => {
    if (dragging) dragging.onMove(e.clientX, e.clientY);
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging.stop();
    dragging = null;
    if (dragged) {
      setRange(range); // repaint rows drawn during the drag
      updateRangeHintSoon.flush();
    }
  });

  // A drag or Shift+click shouldn't also toggle the box it ended on.
  tbody.addEventListener("click", (e) => {
    if (dragged && e.target.closest?.("td.dib")) {
      e.preventDefault();
      dragged = false;
    }
  }, true);

  // True while focus is in something that uses Space itself: a text box, or
  // a checkbox in the Columns menu.
  function typingInField(el) {
    return el && (el.isContentEditable || !!el.closest?.("#col-menu, .ms") || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(el.type)) || el.tagName === "SELECT");
  }

  document.addEventListener("keydown", (e) => {
    if (!range || typingInField(document.activeElement)) return;
    if (e.key === "Escape") {
      setRange(null);
      return;
    }
    if (e.key !== " ") return;
    e.preventDefault(); // don't scroll the page or toggle a focused checkbox
    if (e.repeat) return;
    const tick = !rangeAllTicked();
    for (let i = range.from; i <= range.to; i++) {
      if (isChecked(view[i], range.name) !== tick) setDib(view[i], range.name, tick);
    }
    updatePending();
    updateRangeHint();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " " && range && !typingInField(document.activeElement)) e.preventDefault();
  });

  // ---------- selecting and copying car details ----------
  // Click a cell, drag across cells, or Shift+click to select a block of the
  // car-detail columns; Ctrl+C (⌘C) copies it as tab-separated rows, which
  // paste into Excel or Google Sheets as cells. Hidden columns are left out.

  const COPY_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C";
  let cellRange = null; // {from, to, c1, c2}: view rows and COLUMNS indexes
  let cellAnchor = null; // {i, c}

  function selectedColumns() {
    const out = [];
    for (let c = cellRange.c1; c <= cellRange.c2; c++) if (shown(COLUMNS[c].key)) out.push(c);
    return out;
  }

  function paintCellRow(tr, i) {
    const inRows = !!cellRange && i >= cellRange.from && i <= cellRange.to;
    for (let c = 0; c < COLUMNS.length; c++) {
      tr.cells[c].classList.toggle("cell-selected", inRows && c >= cellRange.c1 && c <= cellRange.c2);
    }
  }

  function paintCellRange() {
    for (const [vin, tr] of drawn) paintCellRow(tr, idxOf.get(vin));
  }

  function setCellRange(r) {
    cellRange = r;
    if (r) {
      if (range) setRange(null);
      if (noteRange) setNoteRange(null);
    }
    paintCellRange();
    updateRangeHint();
  }

  // The car-detail column under the pointer, or the nearest one.
  function columnAt(x, y) {
    const td = document.elementFromPoint(x, y)?.closest?.("#cars td, #cars th");
    if (td && td.cellIndex < COLUMNS.length) return td.cellIndex;
    return x < table.getBoundingClientRect().left + 20 ? 0 : COLUMNS.length - 1;
  }

  function startCellSelection(e, td) {
    e.preventDefault(); // our selection instead of the browser's text selection
    document.activeElement?.blur?.(); // saves a note being typed
    clearNoteSelection();
    const i = rowIndex(td), c = td.cellIndex;
    if (e.shiftKey && cellAnchor) {
      setCellRange({
        from: Math.min(cellAnchor.i, i), to: Math.max(cellAnchor.i, i),
        c1: Math.min(cellAnchor.c, c), c2: Math.max(cellAnchor.c, c),
      });
      return;
    }
    cellAnchor = { i, c };
    // Clicking inside the selection keeps it; dragging from there starts anew.
    let keep = td.classList.contains("cell-selected");
    if (!keep) setCellRange({ from: i, to: i, c1: c, c2: c });

    let lastX = e.clientX, lastY = e.clientY;
    const update = (x, y) => {
      const j = rowIndexAt(x, y);
      if (j === undefined) return;
      const area = visibleRowsArea();
      const k = columnAt(x, Math.min(Math.max(y, area.top + 2), area.bottom - 2));
      if (keep) {
        if (j === i && k === c) return;
        keep = false;
      }
      cellRange = {
        from: Math.min(cellAnchor.i, j), to: Math.max(cellAnchor.i, j),
        c1: Math.min(cellAnchor.c, k), c2: Math.max(cellAnchor.c, k),
      };
      paintCellRange();
      updateRangeHintSoon();
    };
    const updateSoon = perFrame(() => update(lastX, lastY));
    const scroller = edgeScroller(lastX, lastY, update);
    const move = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      scroller.move(lastX, lastY);
      updateSoon();
    };
    const up = () => {
      scroller.stop();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      updateRangeHintSoon.flush();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // What Ctrl+C copies: the selected car details, or the selected notes.
  function selectionText() {
    const clean = (v) => String(v).replace(/[\t\r\n]+/g, " ");
    if (cellRange) {
      const cols = selectedColumns().map((c) => COLUMNS[c]);
      const lines = [];
      for (let i = cellRange.from; i <= cellRange.to; i++) {
        const car = view[i];
        lines.push(cols.map((col) => clean(col.fmt ? col.fmt(car[col.key] ?? "") : car[col.key] ?? "")).join("\t"));
      }
      return { text: lines.join("\n"), count: lines.length * cols.length };
    }
    if (noteRange) {
      const lines = [];
      for (let i = noteRange.from; i <= noteRange.to; i++) lines.push(clean(view[i].notes[noteRange.name] || ""));
      return { text: lines.join("\n"), count: lines.length };
    }
    return null;
  }

  // Uses the copy event (not navigator.clipboard), which also works when the
  // page is served over plain http.
  document.addEventListener("copy", (e) => {
    if (dibsDlg.open) {
      copyPopupSelection(e);
      return;
    }
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "checkbox"))) return;
    if (!getSelection().isCollapsed) return; // ordinary highlighted text copies as usual
    const sel = selectionText();
    if (!sel) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", sel.text);
    SF.setStatus(status, "ok", `Copied ${sel.count.toLocaleString()} cell${sel.count === 1 ? "" : "s"}. Paste into a spreadsheet or email.`);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cellRange && !typingInField(document.activeElement)) setCellRange(null);
  });

  // ---------- clearing selections ----------
  // A click anywhere except on a highlighted cell clears the selection. It
  // runs before the cell handlers, which then start a new one. Shift+click on
  // a cell (extends the selection), scrollbars and column resizing don't count.

  const HIGHLIGHTED = "td.range-selected, td.cell-selected, .note-cell.range-selected, .note-cell.selected";

  function onScrollbar(e) {
    const el = e.target;
    if (!(el instanceof Element) || (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)) return false;
    const r = el.getBoundingClientRect();
    return e.clientX - r.left >= el.clientLeft + el.clientWidth || e.clientY - r.top >= el.clientTop + el.clientHeight;
  }

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest(HIGHLIGHTED) || t.closest(".col-resizer") || onScrollbar(e)) return;
    if (e.shiftKey && t.closest("#cars tbody tr[data-vin] > td, .note-cell")) return;
    if (range) setRange(null);
    if (noteRange) setNoteRange(null);
    if (cellRange) setCellRange(null);
    if (selected && !t.closest(".note-cell")) document.activeElement?.blur?.(); // saves a note being typed
    clearNoteSelection();
  }, true);

  // ---------- saving dibs ----------

  saveBtn.addEventListener("click", async () => {
    if (!pending.size) return;
    const changes = [...pending.values()];
    SF.setBusy(saveBtn, true, "Saving…");
    discardBtn.disabled = true;
    try {
      const res = await SF.fetchJSON("/api/dibs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calledBy: SF.store.get("username") || "", changes }),
      });
      for (const [vin, dibs] of Object.entries(res.dibs)) {
        const car = byVIN.get(vin);
        if (car) car.dibs = dibs;
      }
      for (const [vin, wave] of Object.entries(res.wave || {})) {
        const car = byVIN.get(vin);
        if (car) car.wave = wave;
      }
      pending.clear();
      drawWindow(true);
      updatePending();
      const parts = [];
      if (res.claimed) parts.push(`${res.claimed} dibs called`);
      if (res.released) parts.push(`${res.released} released`);
      if (res.waveSet) parts.push(`${res.waveSet} ticked ${WAVE}`);
      if (res.waveCleared) parts.push(`${res.waveCleared} unticked ${WAVE}`);
      SF.setStatus(status, "ok", parts.length ? `Saved: ${parts.join(", ")}.` : "Saved. Nothing had changed.");
    } catch (err) {
      SF.setStatus(status, "err", `Dibs not saved: ${err.message}`);
    } finally {
      SF.setBusy(saveBtn, false);
      discardBtn.disabled = false;
      updatePending();
      if (range) updateRangeHint();
    }
  });

  discardBtn.addEventListener("click", () => {
    pending.clear();
    drawWindow(true);
    updatePending();
    if (range) updateRangeHint();
    SF.setStatus(status, "", "");
  });

  // On refresh or close: write the filters now, save a note that's still
  // being typed, and send queued notes straight away.
  function flushBeforeLeaving() {
    saveFilters.flush();
    const active = document.activeElement;
    if (active?.classList.contains("note-text")) commitNote(noteTd(active));
    if (noteQueue.size && !noteSaving) {
      clearTimeout(noteTimer);
      flushNotes();
    }
  }
  window.addEventListener("pagehide", flushBeforeLeaving);
  window.addEventListener("beforeunload", (e) => {
    flushBeforeLeaving();
    if (pending.size || noteQueue.size || (noteSaving && !noteKeepalive)) e.preventDefault();
  });

  // ---------- All Dibs pop-up ----------
  // Every car on the latest nationwide sheet with a saved dibs, fetched fresh
  // each time it opens. Its table works like the main one, read-only: click
  // a heading to sort (a dibs or notes heading selects that column instead),
  // drag a column edge to resize, and click, drag or Shift+click cells to
  // select them for Ctrl+C. It always shows every column, including ones
  // hidden in the Columns menu. Export downloads the same list as .xlsx.

  const dibsDlg = $("all-dibs"), dibsDlgBtn = $("all-dibs-btn"), dibsDlgClose = $("all-dibs-close");
  const dibsDlgSub = $("all-dibs-sub"), dibsDlgStatus = $("all-dibs-status"), dibsExport = $("all-dibs-export");
  const dibsHint = $("all-dibs-hint");
  const pTable = $("all-dibs-table"), pWrap = pTable.parentElement, pHead = pTable.tHead.rows[0], pBody = pTable.tBodies[0];
  const P_WIDTHS_KEY = "inventory.allDibsColWidths"; // localStorage
  const P_SORT_KEY = "inventory.allDibsSort"; // sessionStorage, like the main table's sort
  let dibsDlgReq = 0;

  let pCols = []; // {key, label, kind: "car" | "dib" | "note", col?, name?, def, th, el}
  let pCars = [], pView = [];
  let pSort = { key: null, dir: 1 };
  try { pSort = JSON.parse(sessionStorage.getItem(P_SORT_KEY)) || pSort; } catch { /* none saved */ }
  let pSel = null; // {from, to, c1, c2}: rows of pView and indexes of pCols
  let pAnchor = null; // {i, c}

  // The pop-up's own widths; a column it hasn't sized starts at the main table's width.
  const pWidths = (() => { try { return JSON.parse(localStorage.getItem(P_WIDTHS_KEY)) || {}; } catch { return {}; } })();
  const pWidthOf = (c) => pWidths[c.key] || widths[c.key] || c.def;
  function applyPopupWidths() {
    let sum = 0;
    for (const c of pCols) {
      const w = pWidthOf(c);
      c.el.style.width = w + "px";
      sum += w;
    }
    pTable.style.width = `max(${sum}px, 100%)`;
  }
  // Like the main table, an empty last column soaks up spare room, so the
  // other columns keep exactly the widths they're dragged to.
  const pFiller = () => {
    const th = document.createElement("th");
    th.className = "filler";
    th.setAttribute("aria-hidden", "true");
    return th;
  };
  const popupSizing = {
    widths: pWidths,
    apply: applyPopupWidths,
    applySoon: perFrame(applyPopupWidths),
    save: () => { try { localStorage.setItem(P_WIDTHS_KEY, JSON.stringify(pWidths)); } catch { /* private mode */ } },
  };

  function buildPopupHeader(names) {
    pCols = [
      ...COLUMNS.map((col) => ({ key: col.key, label: col.label, kind: "car", col, def: col.w })),
      { key: "wave", label: WAVE, kind: "wave", name: WAVE, def: WAVE_WIDTH },
      ...names.map((name) => ({ key: "dib:" + name, label: name, kind: "dib", name, def: DIB_WIDTH })),
      ...names.map((name) => ({ key: "note:" + name, label: name + " Notes", kind: "note", name, def: NOTE_WIDTH })),
    ];
    const colgroup = document.createElement("colgroup");
    pHead.replaceChildren();
    pCols.forEach((c, idx) => {
      c.el = colgroup.appendChild(document.createElement("col"));
      const th = (c.th = document.createElement("th"));
      th.scope = "col";
      th.appendChild(document.createElement("span")).textContent = c.label;
      if (c.kind === "car") {
        th.className = "sortable";
        th.addEventListener("click", () => {
          pSort = { key: c.key, dir: pSort.key === c.key ? -pSort.dir : 1 };
          try { sessionStorage.setItem(P_SORT_KEY, JSON.stringify(pSort)); } catch { /* private mode */ }
          setPopupSel(null);
          renderPopupRows();
        });
      } else {
        th.className = c.kind === "note" ? "" : "dib-head";
        th.title = `Select the whole ${c.label} column, then press ${COPY_KEYS} to copy it`;
        th.addEventListener("click", () => {
          if (pView.length) setPopupSel({ from: 0, to: pView.length - 1, c1: idx, c2: idx });
        });
      }
      addResizer(th, c.key, { sizing: popupSizing });
      pHead.appendChild(th);
    });
    colgroup.appendChild(document.createElement("col"));
    pHead.appendChild(pFiller());
    pTable.querySelector("colgroup")?.remove();
    pTable.prepend(colgroup);
    applyPopupWidths();
  }

  // What a cell shows, and what Ctrl+C copies from it (dibs as TRUE/FALSE, as in the export).
  function popupCopyText(c, car) {
    if (c.kind === "car") return c.col.fmt ? c.col.fmt(car[c.key] ?? "") : car[c.key] ?? "";
    if (c.kind === "dib") return car.dibs.some((d) => d.name === c.name) ? "TRUE" : "FALSE";
    if (c.kind === "wave") return car.wave ? "TRUE" : "FALSE";
    return car.notes[c.name] || "";
  }

  function renderPopupRows() {
    pView = pCars.slice();
    for (const c of pCols) {
      if (c.kind === "car") c.th.setAttribute("aria-sort", pSort.key === c.key ? (pSort.dir > 0 ? "ascending" : "descending") : "none");
    }
    const sc = pSort.key && COLUMNS.find((c) => c.key === pSort.key);
    if (sc) {
      pView.sort(sc.num
        ? (a, b) => (Number(a[sc.key]) - Number(b[sc.key])) * pSort.dir
        : (a, b) => collator.compare(String(a[sc.key]), String(b[sc.key])) * pSort.dir);
    }

    const body = document.createDocumentFragment();
    pView.forEach((car, i) => {
      const tr = body.appendChild(document.createElement("tr"));
      tr.dataset.i = i;
      for (const c of pCols) {
        const td = tr.appendChild(document.createElement("td"));
        if (c.kind === "car") {
          td.textContent = popupCopyText(c, car);
          td.className = c.col.num ? "num" : c.col.mono ? "mono" : "";
        } else if (c.kind === "wave") {
          const box = td.appendChild(document.createElement("input"));
          box.type = "checkbox";
          box.checked = !!car.wave;
          box.inert = true;
          box.tabIndex = -1;
          box.setAttribute("aria-label", `${WAVE}: ${car.wave ? "ticked" : "not ticked"}`);
          td.className = car.wave ? "dib wave wave-on" : "dib wave";
        } else if (c.kind === "dib") {
          // Read-only checkboxes: the same look as the main table, but inert.
          const order = car.dibs.findIndex((d) => d.name === c.name);
          const box = td.appendChild(document.createElement("input"));
          box.type = "checkbox";
          box.checked = order >= 0;
          box.inert = true;
          box.tabIndex = -1;
          box.setAttribute("aria-label", `${c.name}: ${order >= 0 ? "has dibs" : "no dibs"}`);
          td.className = order >= 0 ? `dib dib-${Math.min(order + 1, 4)}` : "dib";
        } else {
          td.textContent = td.title = car.notes[c.name] || "";
          td.className = "note";
        }
      }
      tr.appendChild(document.createElement("td")).className = "filler";
    });
    if (!pView.length) {
      const td = body.appendChild(document.createElement("tr")).appendChild(document.createElement("td"));
      td.className = "empty";
      td.colSpan = pCols.length + 1;
      td.textContent = "Nobody has dibs on a car from the latest nationwide sheet yet.";
    }
    pBody.replaceChildren(body);
    paintPopupSel();
  }

  function paintPopupSel() {
    for (const tr of pBody.rows) {
      const i = Number(tr.dataset.i);
      const inRows = !!pSel && i >= pSel.from && i <= pSel.to;
      for (let c = 0; c < pCols.length && tr.dataset.i !== undefined; c++) {
        tr.cells[c].classList.toggle("cell-selected", inRows && c >= pSel.c1 && c <= pSel.c2);
      }
    }
  }

  function updatePopupHint() {
    if (!pSel) {
      dibsHint.textContent = "";
      return;
    }
    const rowsN = pSel.to - pSel.from + 1, cols = pSel.c2 - pSel.c1 + 1;
    const what = rowsN === 1 && cols === 1 ? "1 cell"
      : `${rowsN.toLocaleString()} row${rowsN === 1 ? "" : "s"} × ${cols} column${cols === 1 ? "" : "s"}`;
    dibsHint.textContent = `${what} selected: press ${COPY_KEYS} to copy`;
  }
  const updatePopupHintSoon = debounced(updatePopupHint, 120);

  function setPopupSel(r) {
    pSel = r;
    paintPopupSel();
    updatePopupHint();
  }

  // The popup cell under (x, y), clamped to the visible part of the table so
  // a drag past an edge picks the edge row or column.
  function popupCellAt(x, y) {
    const r = pWrap.getBoundingClientRect(), headH = pTable.tHead.offsetHeight;
    const cx = Math.min(Math.max(x, r.left + 2), r.left + pWrap.clientWidth - 2);
    const cy = Math.min(Math.max(y, r.top + headH + 2), r.top + pWrap.clientHeight - 2);
    const td = document.elementFromPoint(cx, cy)?.closest?.("#all-dibs-table tbody tr[data-i] > td");
    return td ? { i: Number(td.parentElement.dataset.i), c: Math.min(td.cellIndex, pCols.length - 1) } : null;
  }

  pBody.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest?.("tr[data-i] > td");
    if (!td) return;
    e.preventDefault(); // our selection instead of the browser's text selection
    if (td.classList.contains("filler")) {
      setPopupSel(null);
      return;
    }
    const i = Number(td.parentElement.dataset.i), c = td.cellIndex;
    if (e.shiftKey && pAnchor) {
      setPopupSel({
        from: Math.min(pAnchor.i, i), to: Math.max(pAnchor.i, i),
        c1: Math.min(pAnchor.c, c), c2: Math.max(pAnchor.c, c),
      });
      return;
    }
    pAnchor = { i, c };
    // Clicking inside the selection keeps it; dragging from there starts anew.
    let keep = td.classList.contains("cell-selected");
    if (!keep) setPopupSel({ from: i, to: i, c1: c, c2: c });

    let lastX = e.clientX, lastY = e.clientY, raf = 0, armed = false;
    const update = () => {
      const at = popupCellAt(lastX, lastY);
      if (!at) return;
      if (keep) {
        if (at.i === i && at.c === c) return;
        keep = false;
      }
      pSel = {
        from: Math.min(i, at.i), to: Math.max(i, at.i),
        c1: Math.min(c, at.c), c2: Math.max(c, at.c),
      };
      paintPopupSel();
      updatePopupHintSoon();
    };
    const updateSoon = perFrame(update);
    // Like the main table: holding the pointer near an edge scrolls that way.
    const tick = () => {
      if (armed) {
        const r = pWrap.getBoundingClientRect(), top = r.top + pTable.tHead.offsetHeight;
        const edge = 32, step = (d) => Math.min(40, d / 2 + 4);
        let dx = 0, dy = 0;
        if (lastY > r.bottom - edge) dy = step(lastY - (r.bottom - edge));
        else if (lastY < top + edge) dy = -step(top + edge - lastY);
        if (lastX > r.right - edge) dx = step(lastX - (r.right - edge));
        else if (lastX < r.left + edge) dx = -step(r.left + edge - lastX);
        if (dx || dy) {
          pWrap.scrollTop += dy;
          pWrap.scrollLeft += dx;
          update();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const move = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (Math.abs(lastX - e.clientX) + Math.abs(lastY - e.clientY) > 4) armed = true;
      updateSoon();
    };
    const up = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      updatePopupHintSoon.flush();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // Inside the pop-up, a click anywhere but a highlighted cell clears the
  // selection (Shift+click on a cell, scrollbars and resizing don't count).
  dibsDlg.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !pSel) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest("td.cell-selected") || t.closest(".col-resizer") || onScrollbar(e)) return;
    if (e.shiftKey && t.closest("#all-dibs-table tbody td")) return;
    setPopupSel(null);
  }, true);

  // Esc clears the selection first; with nothing selected it closes the pop-up.
  dibsDlg.addEventListener("cancel", (e) => {
    if (pSel) {
      e.preventDefault();
      setPopupSel(null);
    }
  });

  // Called by the page's copy handler while the pop-up is open (the copy
  // event goes to whatever has focus, which may be outside the pop-up).
  function copyPopupSelection(e) {
    if (!pSel || !getSelection().isCollapsed) return;
    const clean = (v) => String(v).replace(/[\t\r\n]+/g, " ");
    const lines = [];
    for (let i = pSel.from; i <= pSel.to; i++) {
      const cells = [];
      for (let c = pSel.c1; c <= pSel.c2; c++) cells.push(clean(popupCopyText(pCols[c], pView[i])));
      lines.push(cells.join("\t"));
    }
    e.preventDefault();
    e.clipboardData.setData("text/plain", lines.join("\n"));
    const n = lines.length * (pSel.c2 - pSel.c1 + 1);
    SF.setStatus(dibsDlgStatus, "ok", `Copied ${n.toLocaleString()} cell${n === 1 ? "" : "s"}. Paste into a spreadsheet or email.`);
  }

  function renderAllDibs(res) {
    if (!pCols.length) buildPopupHeader(res.dibsNames);
    pCars = res.cars;
    renderPopupRows();
    const n = res.cars.length;
    let sub = `${n.toLocaleString()} car${n === 1 ? "" : "s"} with dibs`;
    sub += res.latest ? ` on the ${new Date(res.latest.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} nationwide sheet` : "";
    dibsDlgSub.textContent = sub + ".";
    dibsExport.disabled = !n;
  }

  async function openAllDibs() {
    const id = ++dibsDlgReq;
    dibsDlgSub.textContent = "Loading…";
    dibsExport.disabled = true;
    pCars = [];
    pAnchor = null;
    setPopupSel(null);
    pBody.replaceChildren();
    SF.setStatus(dibsDlgStatus, pending.size ? "warn" : "",
      pending.size === 1 ? "You have 1 dibs change that isn't saved yet, so it isn't shown here. Press Call Dibs to save it."
        : pending.size ? `You have ${pending.size.toLocaleString()} dibs changes that aren't saved yet, so they aren't shown here. Press Call Dibs to save them.` : "");
    if (!dibsDlg.open) dibsDlg.showModal();
    pWrap.scrollTo(0, 0);
    try {
      const res = await SF.fetchJSON("/api/dibs/all");
      if (id !== dibsDlgReq || !dibsDlg.open) return;
      renderAllDibs(res);
    } catch (err) {
      if (id !== dibsDlgReq) return;
      dibsDlgSub.textContent = "";
      SF.setStatus(dibsDlgStatus, "err", `Couldn't load dibs: ${err.message}`);
    }
  }

  dibsDlgBtn.addEventListener("click", openAllDibs);
  dibsDlgClose.addEventListener("click", () => dibsDlg.close());
  // A click on the dimmed backdrop (outside the box) closes it too.
  dibsDlg.addEventListener("click", (e) => {
    if (e.target !== dibsDlg) return;
    const r = dibsDlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dibsDlg.close();
  });
  // Keep the main table's shortcuts (Space, Delete, Esc) from acting on the page behind.
  for (const type of ["keydown", "keyup"]) dibsDlg.addEventListener(type, (e) => e.stopPropagation());

  dibsExport.addEventListener("click", async () => {
    SF.setBusy(dibsExport, true, "Exporting…");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const resp = await fetch("/api/dibs/all.xlsx?tz=" + encodeURIComponent(tz));
      if (!resp.ok) throw new Error(await SF.errorMessage(resp));
      SF.download(await resp.blob(), SF.filenameFrom(resp, "all_dibs.xlsx"));
      SF.setStatus(dibsDlgStatus, "", "");
    } catch (err) {
      SF.setStatus(dibsDlgStatus, "err", `Export failed: ${err.message}`);
    } finally {
      SF.setBusy(dibsExport, false);
    }
  });

  // ---------- loading ----------

  function updateVinSummary(vins, notFound) {
    vinBadge.hidden = !vins.length;
    vinBadge.textContent = vins.length ? `${vins.length.toLocaleString()} VIN${vins.length === 1 ? "" : "s"}` : "";
    if (!vins.length) {
      vinSummary.textContent = "";
      return;
    }
    const found = vins.length - notFound.length;
    let text = `${found.toLocaleString()} of ${vins.length.toLocaleString()} pasted VINs are in the database.`;
    if (notFound.length) {
      const shown = notFound.slice(0, 15).join(", ");
      text += ` Not found: ${shown}${notFound.length > 15 ? `, and ${notFound.length - 15} more` : ""}.`;
    }
    vinSummary.textContent = text;
  }

  async function load() {
    const id = ++reqId;
    saveFilters.cancel();
    saveFiltersNow();
    const p = filterParams();
    const vins = parseVINs(vinBox.value);
    if (vins.length) p.set("vins", vins.join(","));

    try {
      const page = await SF.fetchJSON("/api/cars?" + p.toString());
      if (id !== reqId) return; // a newer search already started
      if (!dibsNames) {
        dibsNames = page.dibsNames;
        buildHeader();
      }
      rows = page.cars;
      byVIN = new Map(rows.map((c) => [c.vin, c]));
      total = page.total;
      latestImport = page.latest || null;
      scope = page.scope;
      // A search covers every car anyway, so the checkbox has nothing to add.
      const searching = !!(q.value.trim() || vins.length);
      includeOld.disabled = searching || !latestImport;
      includeOldLabel.classList.toggle("disabled", includeOld.disabled);
      updateVinSummary(vins, page.notFound || []);
      if (status.classList.contains("err")) SF.setStatus(status, "", "");
      wrap.scrollTop = 0;
      renderAll();
    } catch (err) {
      if (id !== reqId) return;
      SF.setStatus(status, "err", err.message);
    }
  }

  const reload = () => { offset = 0; load(); };

  // Typing only schedules work: the search runs, and the filters are saved,
  // once the typing pauses.
  const searchSoon = debounced(reload, 300), vinsSoon = debounced(reload, 400);
  q.addEventListener("input", () => { saveFilters(); searchSoon(); });
  vinBox.addEventListener("input", () => { saveFilters(); vinsSoon(); });
  $("vins-clear").addEventListener("click", () => { vinBox.value = ""; reload(); vinBox.focus(); });

  // Back to the full inventory: no VINs, no search, all states, all cars,
  // nationwide-sheet order. Unsaved dibs ticks are kept.
  resetBtn.addEventListener("click", () => {
    q.value = DEFAULTS.q;
    stateFilter.setValues([]);
    updateCityOptions();
    cityFilter.setValues([]);
    limitSel.value = DEFAULTS.limit;
    includeOld.checked = DEFAULTS.old;
    vinBox.value = DEFAULTS.vins;
    sort = { ...DEFAULTS.sort };
    reload();
  });
  includeOld.addEventListener("change", reload);
  limitSel.addEventListener("change", reload);
  prev.addEventListener("click", () => { offset = Math.max(0, offset - Number(limitSel.value)); load(); });
  next.addEventListener("click", () => { offset += Number(limitSel.value); load(); });

  Promise.allSettled([SF.fetchJSON("/api/cars/states"), SF.fetchJSON("/api/cars/cities")])
    .then(([st, ct]) => {
      // If a list doesn't load, its filter just stays at "All …".
      if (st.status === "fulfilled") stateFilter.setOptions(st.value.states.map((v) => ({ value: v, label: v })));
      if (ct.status === "fulfilled") allCities = ct.value.cities;
      stateFilter.setValues(initial.states); // states no longer listed are dropped
      updateCityOptions();
      cityFilter.setValues(initial.cities);
      restored = true;
      load();
    });
});
