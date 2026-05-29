"use strict";

// ══════════════════════════════════════════════════════════════════
// Layout switching + alternate-layout renderers.
// ──────────────────────────────────────────────────────────────────
// The default panel grid lives in app.js. This file owns:
//   1. The layout chip + modal (DFLT / GAUG / …)
//   2. The renderers for each non-default layout
// Each renderer is invoked from app.js's refresh() via window.layoutOnTick
// after it has computed its own smoothed values, so the gauges read the
// same numbers the user sees on the default panel.
// ══════════════════════════════════════════════════════════════════

const LAYOUTS = ["default", "gauges", "heatmap", "flowstrip"];
const LAYOUT_LABELS = {
  default:    "DEFAULT",
  gauges:     "GAUGES",
  heatmap:    "HEATMAP",
  flowstrip:  "FLOWSTRIP",
};
const LAYOUT_CHIP = {
  default:    "DFLT",
  gauges:     "GAUG",
  heatmap:    "HEAT",
  flowstrip:  "FLOW",
};

let currentLayout = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get("layout");
    if (q && LAYOUTS.includes(q)) return q;
    return localStorage.getItem("kiosk.layout") || "default";
  } catch (e) { return "default"; }
})();

function applyLayout(name, opts) {
  if (!LAYOUTS.includes(name)) name = "default";
  currentLayout = name;
  if (name === "default") document.documentElement.removeAttribute("data-layout");
  else document.documentElement.setAttribute("data-layout", name);
  try { localStorage.setItem("kiosk.layout", name); } catch (e) {}
  const valEl = document.getElementById("settings-layout-value");
  if (valEl) valEl.textContent = LAYOUT_LABELS[name];
  document.querySelectorAll(".layout-swatch").forEach((el) => {
    el.classList.toggle("selected", el.dataset.layout === name);
  });
  // Re-apply per-layout widget config — each layout owns its own
  // localStorage entry, so switching back later restores exactly the
  // toggles/order the user left for that layout.
  if (typeof window.__kioskApplyWidgets === "function") {
    window.__kioskApplyWidgets(name);
  }
}

// Exposed for the settings modal in app.js so it can read the active
// layout's user-facing label and reopen the picker.
window.__kioskCurrentLayoutLabel = () => LAYOUT_LABELS[currentLayout];

// ── Layout picker modal ───────────────────────────────────────────
function buildLayoutSwatch(name) {
  const sw = document.createElement("div");
  sw.className = "layout-swatch";
  sw.dataset.layout = name;
  if (name === currentLayout) sw.classList.add("selected");

  // Each preview is a tiny but faithful sketch of the layout it
  // selects — same column counts, same row proportions, same heat
  // colour buckets — so the user can pick by silhouette rather than
  // having to read the label. The `preview-<name>` class drives all
  // dimensions from CSS; the JS only emits the matching DOM.
  const preview = document.createElement("div");
  preview.className = "preview preview-" + name;
  if (name === "default") {
    // Four tall vertical panels (CPU+GPU split · MEM · DISK+NET split
    // · PROCS). Split panels get a mid-height divider; non-split ones
    // are solid. Each panel holds a tiny sparkline at the top and a
    // couple of bar-like rows below to suggest the bars + tables.
    for (let i = 0; i < 4; i++) {
      const p = document.createElement("div");
      p.className = "panel-mini";
      if (i === 0 || i === 2) p.classList.add("split");
      p.innerHTML =
        '<div class="spark"></div>' +
        '<div class="line"></div>' +
        '<div class="line short"></div>';
      preview.appendChild(p);
    }
  } else if (name === "gauges") {
    // Top: four small dial circles. Bottom: three cards in the same
    // 1.4 / 1 / 1.3 column ratio as the live grid.
    const dials = document.createElement("div");
    dials.className = "dials";
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("div");
      d.className = "dial";
      dials.appendChild(d);
    }
    const cards = document.createElement("div");
    cards.className = "cards";
    for (let i = 0; i < 3; i++) {
      const c = document.createElement("div");
      c.className = "card-mini";
      cards.appendChild(c);
    }
    preview.append(dials, cards);
  } else if (name === "heatmap") {
    // Top: five percent cells. Middle: 8-row heat grid (one row per
    // core, matching the live layout). Bottom: a single sparkline
    // strip that suggests the NET overlay graph.
    const pcts = document.createElement("div");
    pcts.className = "pcts";
    for (let i = 0; i < 5; i++) {
      const c = document.createElement("div");
      c.className = "pct";
      pcts.appendChild(c);
    }
    const heat = document.createElement("div");
    heat.className = "heat";
    // Fixed deterministic pattern — looks like real heatmap data
    // without depending on stats. Buckets match _hmHeatColor.
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 14; c++) {
        const cell = document.createElement("span");
        const v = (((r * 13 + c * 7) ^ (r + c)) % 5);
        cell.dataset.v = String(v);
        heat.appendChild(cell);
      }
    }
    const net = document.createElement("div");
    net.className = "net";
    preview.append(pcts, heat, net);
  } else if (name === "flowstrip") {
    // Top: six narrow columns, each a tall stack of [graph · pct ·
    // details · spark]. Bottom: a wide procs strip beneath. The
    // .col / .row markers drive all dimensions from CSS so the
    // preview tracks any future column-count change.
    const cols = document.createElement("div");
    cols.className = "cols";
    for (let i = 0; i < 6; i++) {
      const col = document.createElement("div");
      col.className = "col";
      col.innerHTML =
        '<div class="g"></div>' +
        '<div class="p"></div>' +
        '<div class="d"></div>' +
        '<div class="s"></div>';
      cols.appendChild(col);
    }
    const procs = document.createElement("div");
    procs.className = "procs";
    preview.append(cols, procs);
  }

  const label = document.createElement("div");
  label.textContent = LAYOUT_LABELS[name];

  // Per-layout reset — clears this layout's widget config without
  // switching to it. Useful for restoring "factory" widget order on
  // a layout you're not currently viewing.
  const reset = document.createElement("button");
  reset.className = "layout-swatch-reset";
  reset.type = "button";
  reset.textContent = "↻";
  reset.title = "Reset " + LAYOUT_LABELS[name] + " to default widgets";
  reset.setAttribute("aria-label", reset.title);
  const stopAll = (e) => { e.stopPropagation(); };
  reset.addEventListener("pointerdown", stopAll);
  reset.addEventListener("pointerup",   stopAll);
  reset.addEventListener("click", (e) => {
    e.stopPropagation();
    _wClearConfig(name);
    if (name === currentLayout) applyWidgetConfig(name);
    reset.classList.add("flash");
    setTimeout(() => reset.classList.remove("flash"), 400);
  });

  sw.append(preview, label, reset);

  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    applyLayout(name);
    // Modal stays open so the user can keep cycling without
    // re-navigating into Settings → Layout each time. They close
    // it explicitly via the ← BACK button or by tapping outside.
    buildLayoutsGrid();
  });
  sw.addEventListener("pointerdown", (e) => e.stopPropagation());
  sw.addEventListener("pointerup",   (e) => e.stopPropagation());
  return sw;
}
function buildLayoutsGrid() {
  const root = document.getElementById("layouts-grid");
  if (!root) return;
  root.innerHTML = "";
  for (const name of LAYOUTS) root.appendChild(buildLayoutSwatch(name));
}
function openLayoutsModal() {
  buildLayoutsGrid();
  const m = document.getElementById("layouts-modal");
  if (m) m.classList.add("show");
}
function closeLayoutsModal() {
  const m = document.getElementById("layouts-modal");
  if (m) m.classList.remove("show");
}
window.__kioskOpenLayouts  = openLayoutsModal;
window.__kioskCloseLayouts = closeLayoutsModal;

const layoutsModalEl = document.getElementById("layouts-modal");
if (layoutsModalEl) {
  layoutsModalEl.addEventListener("click", (e) => {
    if (e.target === layoutsModalEl) closeLayoutsModal();
  });
  layoutsModalEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  layoutsModalEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLayoutsModal();
});

// ══════════════════════════════════════════════════════════════════
// Gauges renderer
// ──────────────────────────────────────────────────────────────────
// pathLength=370.7079 on each ring matches 2π × r=59 from the SVG.
// Setting stroke-dasharray="<filled> <gap>" with that constant draws
// an arc covering pct% of the circumference. Value rendering is done
// every tick, but the layout-gauges container is display:none unless
// data-layout=gauges, so the cost when inactive is just attribute
// writes — no paint.
// ══════════════════════════════════════════════════════════════════

const GAUGE_CIRCUM = 370.7079;
const _g_proc_rows = [];

function _gColorClass(pct) {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  if (pct >= 50) return "calm";
  return "good";
}

function _gSetText(el, v) { if (el && el.textContent !== v) el.textContent = v; }

function _gSetArc(arcEl, pct) {
  if (!arcEl) return;
  pct = Math.max(0, Math.min(100, pct));
  const filled = (pct / 100) * GAUGE_CIRCUM;
  const next = filled.toFixed(2) + " " + (GAUGE_CIRCUM - filled).toFixed(2);
  if (arcEl.getAttribute("stroke-dasharray") !== next) {
    arcEl.setAttribute("stroke-dasharray", next);
  }
  // Theme-aware tint via class — strokes pull from CSS vars.
  const cls = _gColorClass(pct);
  if (arcEl._cls !== cls) {
    arcEl.classList.remove("good", "calm", "warn", "crit");
    arcEl.classList.add(cls);
    arcEl._cls = cls;
  }
}

function _gFmtBytes(n) {
  if (n < 1024) return n.toFixed(0) + " B";
  if (n < 1024**2) return (n/1024).toFixed(1) + " K";
  if (n < 1024**3) return (n/1024**2).toFixed(1) + " M";
  if (n < 1024**4) return (n/1024**3).toFixed(2) + " G";
  return (n/1024**4).toFixed(2) + " T";
}
function _gFmtRate(n) { return _gFmtBytes(n) + "/s"; }

// One-time DOM build for the cores grid; reused per tick.
let _gCoresBuilt = 0;
function _gBuildCores(n) {
  if (_gCoresBuilt === n) return;
  const root = document.getElementById("g-cores-grid");
  if (!root) return;
  root.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const row = document.createElement("div");
    row.className = "g-core";
    row.innerHTML = `
      <span class="id">c${String(i).padStart(2, "0")}</span>
      <div class="bar"><div class="fill" id="g-core-fill-${i}"></div></div>
      <span class="pct" id="g-core-pct-${i}">0%</span>
    `;
    root.appendChild(row);
  }
  _gCoresBuilt = n;
}

function _gEnsureProcRows(n) {
  const root = document.getElementById("g-procs-rows");
  if (!root) return;
  while (root.children.length < n) {
    const row = document.createElement("div");
    row.className = "g-proc-row";
    const pid = document.createElement("span"); pid.className = "pid";
    const nm  = document.createElement("span"); nm.className  = "name";
    const cpu = document.createElement("span"); cpu.className = "cpu";
    const mem = document.createElement("span"); mem.className = "mem";
    row.append(pid, nm, cpu, mem);
    root.appendChild(row);
  }
  while (root.children.length > n) root.removeChild(root.lastChild);
}

// Pick the row count by *rounding* the container's height to the
// nearest natural-row-size multiple, then let CSS `flex: 1 1 0` on
// the rows distribute that height exactly. This means the count
// auto-fits whatever window the kiosk is running at — fewer rows on a
// short display, more on a tall one — and the last row is always a
// complete row instead of a fractional clip. Rounding (not flooring)
// reclaims the up-to-half-row of slack that floor() left empty.
//
// G_PROC_ROW_PX is the *target* height; the actual height per row is
// `clientHeight / count`, which lands within ~1px of the target by
// construction.
const G_PROC_ROW_PX = 14;
const G_PROC_ROW_MIN = 12;        // don't shrink rows below this
function _gMaxProcRows() {
  const root = document.getElementById("g-procs-rows");
  if (!root) return 0;
  const h = root.clientHeight;
  if (h < G_PROC_ROW_MIN) return 0;
  const ideal = Math.round(h / G_PROC_ROW_PX);
  const floor = Math.floor(h / G_PROC_ROW_MIN);   // hard ceiling
  return Math.max(1, Math.min(ideal, floor));
}

function _gColorForPct(pct) {
  if (pct < 50) return "var(--fg-bright)";
  if (pct < 75) return "var(--accent-2)";
  if (pct < 90) return "var(--warn)";
  return "var(--crit)";
}

function _gPickPrimaryDisk(disks) {
  if (!Array.isArray(disks) || !disks.length) return null;
  // Prefer the largest non-root mount; fall back to "/" if that's all there is.
  const nonRoot = disks.filter(d => d.label !== "/");
  const pool = nonRoot.length ? nonRoot : disks;
  return pool.reduce((a, b) => (b.total > a.total ? b : a), pool[0]);
}

// Public hook called from app.js refresh() with the latest stats and
// the same EMA-smoothed values rendered on the default layout.
window.layoutOnTick = function (s, sm) {
  // Even when the gauges layout is hidden we still update its DOM so
  // a switch presents instantly. Cost is just attribute writes.
  const cpuPct  = sm && Number.isFinite(sm.cpuPct)  ? sm.cpuPct  : (s.cpu && s.cpu.avg) || 0;
  const memPct  = sm && Number.isFinite(sm.memPct)  ? sm.memPct  : (s.mem && s.mem.percent) || 0;
  const diskPct = sm && Number.isFinite(sm.diskPct) ? sm.diskPct : (s.disk && s.disk.percent) || 0;

  // ── CPU dial ──
  _gSetText(document.getElementById("g-cpu-pct"), cpuPct.toFixed(0) + "%");
  _gSetArc (document.getElementById("g-cpu-arc"), cpuPct);
  const cpuTemp = s.cpu && s.cpu.temp_c;
  _gSetText(document.getElementById("g-cpu-sub"),
    cpuTemp != null ? cpuTemp.toFixed(0) + " °C" : "— °C");

  // ── MEM dial ──
  _gSetText(document.getElementById("g-mem-pct"), memPct.toFixed(0) + "%");
  _gSetArc (document.getElementById("g-mem-arc"), memPct);
  if (s.mem) {
    _gSetText(document.getElementById("g-mem-sub"),
      _gFmtBytes(s.mem.used) + " / " + _gFmtBytes(s.mem.total));
  }

  // ── DISK dial — show the primary data mount ──
  const primary = _gPickPrimaryDisk(s.disks) || (s.disk && {
    label: "/", total: s.disk.total, used: s.disk.used, percent: s.disk.percent,
  });
  if (primary) {
    _gSetText(document.getElementById("g-disk-pct"), primary.percent.toFixed(0) + "%");
    _gSetArc (document.getElementById("g-disk-arc"), primary.percent);
    // Always title the dial "DISK" — names like "hdd-vg/hdd-thin"
    // are noisy in the big slot. The mount path lives in the sub
    // line so it's visible without dominating the gauge.
    _gSetText(document.getElementById("g-disk-label"), "DISK");
    _gSetText(document.getElementById("g-disk-sub"),
      _gFmtBytes(primary.used) + " / " + _gFmtBytes(primary.total));
  }

  // ── GPU dial — visible only when the host reports a working iGPU.
  // The .gauges-row also collapses to a 3-track grid in that case so
  // CPU / MEM / DISK fan out to fill the full width instead of leaving
  // a blank slot. ──
  const gpuEl = document.getElementById("g-gpu");
  const gRowEl = document.getElementById("g-row");
  const gpu = s.gpu;
  if (gpu && gpu.available) {
    if (gpuEl.hidden) gpuEl.hidden = false;
    if (gRowEl) gRowEl.classList.remove("no-gpu");
    _gSetText(document.getElementById("g-gpu-pct"), (gpu.busy || 0).toFixed(0) + "%");
    _gSetArc (document.getElementById("g-gpu-arc"), gpu.busy || 0);
    let sub = "—";
    if (gpu.temp_c != null) sub = gpu.temp_c.toFixed(0) + " °C";
    else if (gpu.power_w != null) sub = gpu.power_w.toFixed(1) + " W";
    _gSetText(document.getElementById("g-gpu-sub"), sub);
  } else {
    if (gpuEl && !gpuEl.hidden) gpuEl.hidden = true;
    if (gRowEl) gRowEl.classList.add("no-gpu");
  }

  // ── CPU sparkline (gauges card) — share the default-layout history ring ──
  // app.js owns the global history; if running standalone the gauges spark
  // simply stays empty rather than failing.
  if (window.__kioskHist && window.__kioskHist.cpu && typeof window.__kioskRenderSpark === "function") {
    window.__kioskRenderSpark(
      document.getElementById("g-cpu-spark"),
      window.__kioskHist.cpu.arr(),
      100,
      window.__kioskFrame,
    );
  }

  // ── Cores grid ──
  if (s.cpu && Array.isArray(s.cpu.per)) {
    _gBuildCores(s.cpu.count);
    _gSetText(document.getElementById("g-cores-meta"), s.cpu.count + " c");
    const per = (sm && sm.cpuPer) ? sm.cpuPer : s.cpu.per;
    for (let i = 0; i < s.cpu.per.length; i++) {
      const v = per[i] || 0;
      const f = document.getElementById(`g-core-fill-${i}`);
      const p = document.getElementById(`g-core-pct-${i}`);
      if (f) f.style.right = (100 - Math.max(0, Math.min(100, v))) + "%";
      if (p) {
        _gSetText(p, v.toFixed(0) + "%");
        if (p._color !== v) {
          p.style.color = _gColorForPct(v);
          p._color = v;
        }
      }
    }
  }

  // ── NET card ──
  const wan = s.net && s.net.wan;
  const wanRow = document.getElementById("g-wan-row");
  if (wan && wan.iface) {
    wanRow.hidden = false;
    _gSetText(document.getElementById("g-wan-rx"), _gFmtRate(wan.rx || 0));
    _gSetText(document.getElementById("g-wan-tx"), _gFmtRate(wan.tx || 0));
  } else if (wanRow) wanRow.hidden = true;

  const lan = s.net && s.net.lan;
  const lanRow = document.getElementById("g-lan-row");
  if (lan && Array.isArray(lan.ifaces) && lan.ifaces.length) {
    lanRow.hidden = false;
    _gSetText(document.getElementById("g-lan-rx"), _gFmtRate(lan.rx || 0));
    _gSetText(document.getElementById("g-lan-tx"), _gFmtRate(lan.tx || 0));
  } else if (lanRow) lanRow.hidden = true;

  const ping = s.net && s.net.ping;
  const renderSpark = window.__kioskRenderSpark;
  if (ping) {
    if (ping.gw) {
      _gSetText(document.getElementById("g-ping-gw-target"), ping.gw.target || "—");
      _gSetText(document.getElementById("g-ping-gw-ms"),
        ping.gw.ms == null ? "↯" : ping.gw.ms.toFixed(1) + " ms");
      if (renderSpark && Array.isArray(ping.gw.hist)) {
        renderSpark(document.getElementById("g-ping-gw-spark"),
                    ping.gw.hist, ping.gw.scale_ms || 100);
      }
    }
    if (ping.ext) {
      _gSetText(document.getElementById("g-ping-ext-target"), ping.ext.target || "—");
      _gSetText(document.getElementById("g-ping-ext-ms"),
        ping.ext.ms == null ? "↯" : ping.ext.ms.toFixed(1) + " ms");
      if (renderSpark && Array.isArray(ping.ext.hist)) {
        renderSpark(document.getElementById("g-ping-ext-spark"),
                    ping.ext.hist, (ping.ext.scale_ms || (ping.gw && ping.gw.scale_ms) || 100));
      }
    }
  }

  // Net meta — show "0–N ms" scale for the ping sparks (matches default
  // layout's PING block) when ping data is present, else iface · ip.
  const scale = ping && ping.gw && ping.gw.scale_ms;
  const netMeta = scale
    ? `${(wan && wan.iface) ? wan.iface + " · " : ""}0–${scale} ms`
    : ((wan && wan.iface) ? `${wan.iface}${wan.ip ? " · " + wan.ip : ""}` : "—");
  _gSetText(document.getElementById("g-net-meta"), netMeta);

  // Peak rates — read from app.js's running peak tracker. When the
  // kiosk has only just started these will be the current rates,
  // climbing as bigger transfers come through.
  const peaks = (typeof window.__kioskPeaks === "function") ? window.__kioskPeaks() : { rx: 0, tx: 0 };
  _gSetText(document.getElementById("g-peak-rx"), _gFmtRate(peaks.rx || 0));
  _gSetText(document.getElementById("g-peak-tx"), _gFmtRate(peaks.tx || 0));

  // ── Processes (throttled by the caller) ──
  if (Array.isArray(s.procs_top)) {
    _gSetText(document.getElementById("g-procs-meta"), s.procs + " total");
    // clientHeight is 0 while gauges layout is display:none. Skip the
    // resize in that case — when the user activates this layout the
    // next tick will measure correctly.
    const fit = _gMaxProcRows();
    const visible = fit > 0 ? Math.min(s.procs_top.length, fit) : s.procs_top.length;
    _gEnsureProcRows(visible);
    const root = document.getElementById("g-procs-rows");
    for (let i = 0; i < visible; i++) {
      const p = s.procs_top[i];
      const row = root.children[i];
      _gSetText(row.children[0], String(p.pid));
      if (row.children[1].textContent !== p.name) {
        row.children[1].textContent = p.name;
        row.children[1].title = p.name;
      }
      _gSetText(row.children[2], p.cpu.toFixed(0));
      row.children[2].style.color = _gColorForPct(Math.min(100, p.cpu));
      _gSetText(row.children[3], p.mem.toFixed(1));
      row.children[3].style.color = _gColorForPct(Math.min(100, p.mem));
    }
  }
};

// ══════════════════════════════════════════════════════════════════
// Heatmap renderer
// ──────────────────────────────────────────────────────────────────
// "The chart IS the interface": a per-core × time grid is the focal
// element. One heatmap cell ≈ 1 second of CPU usage on that core.
// We sample the latest cpuPer (smoothed) at most once a second based
// on wall-clock — independent of TICK_MS, so changing the polling
// rate doesn't stretch or compress the time axis. The grid keeps a
// rolling window of HM_COLS samples per core; the newest cell is on
// the right, the oldest on the left.
// ══════════════════════════════════════════════════════════════════

const HM_COLS = 60;                  // 60 visible cells = ~60 seconds of scope
const HM_COMMIT_MS = 1000;           // wall-clock interval between column shifts
const HM_STEP_PCT = 100 / (HM_COLS + 1);  // strip translateX step (one cell width)
const HM_NET_HIST = 600;             // net spark history depth

// Per-core CPU ring (built lazily once we know the core count).
let _hmCoresBuilt = 0;
let _hmCoreHist = [];                // [coreIdx] -> array of HM_COLS+1 (last is live)
let _hmCoreCellEls = [];             // [coreIdx][col] -> <span>
let _hmCoreStripEls = [];            // [coreIdx] -> <div class="hm-core-strip">
let _hmCorePctEls = [];              // [coreIdx] -> right-side <span>
let _hmLastSampleMs = 0;             // wall-clock of last column commit
let _hmRxHist = new Array(HM_NET_HIST).fill(0);
let _hmTxHist = new Array(HM_NET_HIST).fill(0);

function _hmHeatColor(pct) {
  // Quantise into five buckets so the grid reads as bands rather than
  // a noisy continuous gradient. The CSS variables stay theme-aware.
  if (pct <  2)  return "var(--grid)";
  if (pct < 25)  return "var(--good)";
  if (pct < 50)  return "var(--accent-2)";
  if (pct < 75)  return "var(--warn)";
  return "var(--crit)";
}

function _hmBuildCores(n) {
  if (_hmCoresBuilt === n) return;
  const root = document.getElementById("hm-cores");
  if (!root) return;
  root.innerHTML = "";
  _hmCoreHist = [];
  _hmCoreCellEls = [];
  _hmCoreStripEls = [];
  _hmCorePctEls = [];
  for (let i = 0; i < n; i++) {
    const row = document.createElement("div");
    row.className = "hm-core-row";
    const id = document.createElement("span");
    id.className = "hm-core-id";
    id.textContent = "c" + String(i).padStart(2, "0");
    // strip-wrap clips the strip to the visible HM_COLS cells; the strip
    // itself is one cell wider so a fresh "live" cell sits offscreen-right
    // and slides in over HM_COMMIT_MS, matching the CPU sparkline trick.
    const wrap = document.createElement("div");
    wrap.className = "hm-core-strip-wrap";
    const strip = document.createElement("div");
    strip.className = "hm-core-strip";
    const cells = [];
    for (let c = 0; c <= HM_COLS; c++) {
      const cell = document.createElement("span");
      cell.className = "hm-core-cell";
      strip.appendChild(cell);
      cells.push(cell);
    }
    wrap.appendChild(strip);
    const pct = document.createElement("span");
    pct.className = "hm-core-pct";
    pct.textContent = "0%";
    row.append(id, wrap, pct);
    root.appendChild(row);
    _hmCoreHist.push(new Array(HM_COLS + 1).fill(0));
    _hmCoreCellEls.push(cells);
    _hmCoreStripEls.push(strip);
    _hmCorePctEls.push(pct);
  }
  _hmCoresBuilt = n;
}

function _hmCommitColumn(per) {
  // One commit per HM_COMMIT_MS: shift each core's ring left by one
  // and seed the offscreen-right cell with the current live value.
  for (let i = 0; i < per.length && i < _hmCoreHist.length; i++) {
    const ring = _hmCoreHist[i];
    for (let c = 0; c < HM_COLS; c++) ring[c] = ring[c + 1];
    ring[HM_COLS] = per[i] || 0;
  }
}

function _hmUpdateLiveCell(per) {
  // Between commits, only the offscreen-right cell tracks the current
  // value — its colour glides via CSS transition as the bar slides in.
  for (let i = 0; i < per.length && i < _hmCoreHist.length; i++) {
    _hmCoreHist[i][HM_COLS] = per[i] || 0;
  }
}

function _hmRepaintCells() {
  for (let i = 0; i < _hmCoreHist.length; i++) {
    const ring = _hmCoreHist[i];
    const cells = _hmCoreCellEls[i];
    for (let c = 0; c <= HM_COLS; c++) {
      const colour = _hmHeatColor(ring[c]);
      if (cells[c]._c !== colour) {
        cells[c].style.backgroundColor = colour;
        cells[c]._c = colour;
      }
    }
  }
}

// Same scrolling trick the CPU sparkline uses: snap the strip to
// translateX(0) on each commit, then animate it left by exactly one
// cell width over HM_COMMIT_MS. Because we shifted the colour ring at
// the same instant we snapped, end-of-tick at translateX(-stepPct) is
// pixel-identical to start-of-next-tick at translateX(0) — the snap is
// invisible. Between commits the transform animation keeps gliding
// without restart.
function _hmAdvanceScroll(snap) {
  for (let i = 0; i < _hmCoreStripEls.length; i++) {
    const strip = _hmCoreStripEls[i];
    if (!strip._initialized) {
      strip.style.transition = "none";
      strip.style.transform  = "translateX(0)";
      strip._initialized = true;
      void strip.getBoundingClientRect();
      strip.style.transition = "transform " + HM_COMMIT_MS + "ms linear";
      strip.style.transform  = "translateX(-" + HM_STEP_PCT.toFixed(4) + "%)";
    } else if (snap) {
      strip.style.transition = "none";
      strip.style.transform  = "translateX(0)";
      void strip.getBoundingClientRect();
      strip.style.transition = "transform " + HM_COMMIT_MS + "ms linear";
      strip.style.transform  = "translateX(-" + HM_STEP_PCT.toFixed(4) + "%)";
    }
  }
}

function _hmFmtBytes(n) { return _gFmtBytes(n); }
function _hmFmtRate(n)  { return _gFmtRate(n); }

// Visible-window peak across both rx and tx so the heatmap NET block
// glyphs scale against a shared y-axis. A 1 KB/s floor keeps an idle
// row from amplifying noise into a busy-looking bar.
function _hmNetPeak() {
  let peak = 1024;
  for (let i = 0; i < _hmRxHist.length; i++) if (_hmRxHist[i] > peak) peak = _hmRxHist[i];
  for (let i = 0; i < _hmTxHist.length; i++) if (_hmTxHist[i] > peak) peak = _hmTxHist[i];
  return peak;
}

// ── Unicode block-glyph sparkline ─────────────────────────────────
// Renders the visible window of `data` as a single row of ▁▂▃▄▅▆▇█.
// Used in two places that explicitly want a quantised "bar shape"
// readout instead of a smooth line graph:
//   • heatmap layout's NET DL/UL rows (single-line block strip)
//   • flowstrip layout's bottom-of-column secondary readouts
//
// Design choices that make the bar shape readable:
//  • Auto-scale to the visible window's own peak (not the full ring)
//    so a stale spike from minutes ago doesn't pin every current
//    sample to the floor. Caller can pass a `floor` value as the
//    optional `peakFloor` argument.
//  • Map any non-zero value to at least ▂ — trickle traffic should
//    show as a clearly-visible bar, not the same flat space as 0.
//  • Square-root compression broadens small values without
//    flattening real spikes (logs were too aggressive — a 1 KB/s
//    blip became indistinguishable from a 1 MB/s burst).
const _BLOCK_GLYPHS = [
  " ", "▂", "▃", "▄",
  "▅", "▆", "▇", "█",
];
function _renderBlockSpark(el, data, peakFloor) {
  if (!el || !data || !data.length) return;
  // Tear down any leftover SVG from a previous line-graph render —
  // shouldn't happen for elements that are always block-glyph, but
  // guards against accidental re-targeting.
  if (el._svg && el.firstChild) {
    el.innerHTML = "";
    el._svg = null; el._line = null; el._area = null; el._scroll = null;
    el._w = 0; el._h = 0; el._initialized = false; el._sig = "";
    el._lastUpdate = 0;
  }
  const cs = window.getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 14;
  const charW = fs * 0.55;
  const w = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 0;
  if (w < 4) return;
  const cols = Math.max(8, Math.floor(w / charW));
  const start = Math.max(0, data.length - cols);

  // Visible-window peak with a sensible floor.
  let peak = peakFloor || 1;
  for (let i = start; i < data.length; i++) {
    if (data[i] > peak) peak = data[i];
  }
  const sqrtPeak = Math.sqrt(peak) || 1;
  const topLvl = _BLOCK_GLYPHS.length - 1;

  let out = "";
  // Pad on the left so a partially-filled history right-aligns to "now".
  const pad = cols - (data.length - start);
  for (let i = 0; i < pad; i++) out += _BLOCK_GLYPHS[0];
  for (let i = start; i < data.length; i++) {
    const v = data[i] || 0;
    if (v <= 0) { out += _BLOCK_GLYPHS[0]; continue; }
    let lvl = Math.round((Math.sqrt(v) / sqrtPeak) * topLvl);
    if (lvl < 1) lvl = 1;
    if (lvl > topLvl) lvl = topLvl;
    out += _BLOCK_GLYPHS[lvl];
  }
  if (el._spark !== out) {
    el.textContent = out;
    el._spark = out;
  }
}

// ── DOM bar sparkline (scrolling) ─────────────────────────────────
// Fills the host element with a row of variable-height bars that
// scroll right-to-left using the same translateX trick as the line
// sparkline. Unlike _renderBlockSpark (which is text glyphs capped
// at the host's font-size), the bars stretch to el.clientHeight, so
// the sparkline reads at any container height.
//
// Continuity at snap-time relies on the same identity the line spark
// uses: bar k (after data push) = bar k+1 (before push). At
// translateX(0) with the new bar list, viewport position k shows the
// same height as before the snap at translateX(-1bar) with the old
// list — so the snap is invisible, and the animation slides the
// newest bar in from offscreen-right.
function _renderBarSpark(el, data, peakFloor, version) {
  if (!el || !data || !data.length) return;

  // Clear any leftover SVG/text from a previous render path.
  if (el._svg) {
    el.innerHTML = "";
    el._svg = null; el._line = null; el._area = null; el._scroll = null;
    el._w = 0; el._h = 0; el._initialized = false; el._sig = "";
    el._lastUpdate = 0;
  }
  if (!el._barRoot && el.firstChild && !el._spark_is_bars) {
    el.textContent = "";
  }
  if (!el._barRoot) {
    const root = document.createElement("div");
    root.className = "bar-spark-wrap";
    el.appendChild(root);
    el._barRoot = root;
    el._bars = [];
    el._barCount = 0;
    el._initialized = false;
    el._lastUpdate = 0;
    el._sig = "";
    el._spark_is_bars = true;
  }

  const w = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 0;
  if (w < 4) return;

  // ~3px per bar matches the line spark's sample density; bigger
  // hosts get more bars, smaller hosts get fewer but never below 8.
  const BAR_PX = 3;
  const N = Math.max(8, Math.min(200, Math.floor(w / BAR_PX)));
  const total = N + 1;  // +1 offscreen-right "live" bar for slide-in

  if (el._barCount !== total) {
    el._barRoot.innerHTML = "";
    el._bars = [];
    for (let i = 0; i < total; i++) {
      const b = document.createElement("div");
      b.className = "bar-spark-cell";
      el._barRoot.appendChild(b);
      el._bars.push(b);
    }
    el._barCount = total;
    el._initialized = false;
    // Wrap is one bar wider than the host so the +1 bar lives just
    // past the right edge and slides into view over `interval` ms.
    el._barRoot.style.width = (100 * total / N).toFixed(4) + "%";
  }

  // Visible-window peak with a sensible floor. Same sqrt compression
  // as _renderBlockSpark so small values stay readable next to spikes.
  const start = Math.max(0, data.length - total);
  const have = data.length - start;
  let peak = peakFloor || 1;
  for (let i = start; i < data.length; i++) {
    if (data[i] > peak) peak = data[i];
  }
  const sqrtPeak = Math.sqrt(peak) || 1;

  // Update bar heights. Left-pad with zero-height if the ring is
  // shorter than `total`; non-zero values clamp to a 2% floor so a
  // sub-peak value never disappears into the baseline.
  for (let i = 0; i < total; i++) {
    const k = i - (total - have);
    const v = (k >= 0) ? (data[start + k] || 0) : 0;
    let pct;
    if (v <= 0) pct = 0;
    else pct = Math.max(2, Math.min(100, (Math.sqrt(v) / sqrtPeak) * 100));
    const b = el._bars[i];
    if (b._pct !== pct) {
      b.style.height = pct.toFixed(2) + "%";
      b._pct = pct;
    }
  }

  // Scroll detection. Same sig trick as renderLineSpark — version is
  // the per-tick frame counter for caller-pushed rings so the slide
  // restarts every tick even when the underlying data plateaus.
  // Server-driven rings (ping) leave version undefined so the sig
  // falls back to content change detection and the slide rate
  // matches the actual sample interval.
  const len = data.length;
  const sig = (version != null ? version + "|" : "") +
              len + "|" + (data[len - 1] || 0) + "|" + (data[len - 2] || 0);
  const dataChanged = (el._sig !== sig);
  el._sig = sig;

  const stepPct = 100 / total;
  const tickMs = (typeof TICK_MS === "number" && TICK_MS > 0) ? TICK_MS : 100;
  const root = el._barRoot;

  if (!el._initialized) {
    root.style.transition = "none";
    root.style.transform = "translateX(0)";
    el._initialized = true;
    el._lastUpdate = performance.now();
    void root.getBoundingClientRect();
    root.style.transition = "transform " + tickMs + "ms linear";
    root.style.transform = "translateX(-" + stepPct.toFixed(4) + "%)";
  } else if (dataChanged) {
    const now = performance.now();
    const last = el._lastUpdate || 0;
    const interval = last ? Math.max(50, Math.min(2500, now - last)) : tickMs;
    el._lastUpdate = now;
    root.style.transition = "none";
    root.style.transform = "translateX(0)";
    void root.getBoundingClientRect();
    root.style.transition = "transform " + interval.toFixed(0) + "ms linear";
    root.style.transform = "translateX(-" + stepPct.toFixed(4) + "%)";
  }
}

// Public renderer — called from layoutOnTick when running.
function _renderHeatmap(s, sm) {
  // ── Top row: percentage cells ──
  const cpuPct  = sm && Number.isFinite(sm.cpuPct)  ? sm.cpuPct  : (s.cpu && s.cpu.avg) || 0;
  const memPct  = sm && Number.isFinite(sm.memPct)  ? sm.memPct  : (s.mem && s.mem.percent) || 0;
  const diskPct = sm && Number.isFinite(sm.diskPct) ? sm.diskPct : (s.disk && s.disk.percent) || 0;
  _gSetText(document.getElementById("hm-cpu-pct"),  cpuPct.toFixed(0)  + "%");
  _gSetText(document.getElementById("hm-mem-pct"),  memPct.toFixed(0)  + "%");
  _gSetText(document.getElementById("hm-disk-pct"), diskPct.toFixed(0) + "%");
  const load1 = (s.load && s.load[0]) || 0;
  _gSetText(document.getElementById("hm-load-val"), load1.toFixed(2));

  // GPU cell collapses out when the host has no usable iGPU, mirroring
  // the gauges layout's no-gpu collapse so the strip stays balanced.
  const gpuCell = document.getElementById("hm-gpu-cell");
  const pcts    = document.getElementById("hm-pcts");
  const gpu = s.gpu;
  if (gpu && gpu.available) {
    if (gpuCell.hidden) gpuCell.hidden = false;
    if (pcts) pcts.classList.remove("no-gpu");
    _gSetText(document.getElementById("hm-gpu-pct"), (gpu.busy || 0).toFixed(0) + "%");
  } else {
    if (gpuCell && !gpuCell.hidden) gpuCell.hidden = true;
    if (pcts) pcts.classList.add("no-gpu");
  }

  // ── Middle: cores × time heatmap ──
  if (s.cpu && Array.isArray(s.cpu.per)) {
    _hmBuildCores(s.cpu.count);
    _gSetText(document.getElementById("hm-cores-meta"),
              s.cpu.count + "c · " + HM_COLS + "s");
    // Use raw per-core values (not the EMA-smoothed sm.cpuPer) so each
    // heatmap cell updates in lockstep with the CPU sparkline. The EMA
    // (α=0.10) makes sense for the big numeric % displays where it
    // damps flicker, but applied to a 5-bucket quantised cell it just
    // delays colour transitions without smoothing anything visually —
    // and that delay reads as the heatmap "lagging" the sparkline.
    const per = s.cpu.per;

    // Wall-clock-paced commits (one column per HM_COMMIT_MS); between
    // commits we update only the offscreen-right "live" cell so it
    // glides into view colour-tinted by the current load.
    const now = (typeof s.ts === "number") ? s.ts * 1000 : Date.now();
    const isCommit = !_hmLastSampleMs || now - _hmLastSampleMs >= HM_COMMIT_MS;
    if (isCommit) {
      _hmCommitColumn(per);
      _hmLastSampleMs = now;
    } else {
      _hmUpdateLiveCell(per);
    }
    _hmRepaintCells();
    _hmAdvanceScroll(isCommit);

    for (let i = 0; i < per.length; i++) {
      const v = per[i] || 0;
      const el = _hmCorePctEls[i];
      if (el) {
        _gSetText(el, v.toFixed(0) + "%");
        const col = _gColorForPct(v);
        if (el._color !== col) { el.style.color = col; el._color = col; }
      }
    }
  }

  // ── Bottom: NET sparklines (DOWNLOAD and UPLOAD on stacked rows) ──
  // Each row auto-scales itself against its own visible window so the
  // bar shape is readable regardless of whether one direction is two
  // orders of magnitude busier than the other.
  const rx = (s.net && s.net.rx) || 0;
  const tx = (s.net && s.net.tx) || 0;
  _hmRxHist.push(rx); if (_hmRxHist.length > HM_NET_HIST) _hmRxHist.shift();
  _hmTxHist.push(tx); if (_hmTxHist.length > HM_NET_HIST) _hmTxHist.shift();

  // DOM-bar sparkline keeps the NET overlay reading as discrete
  // bars rather than a smooth line — the user wants the bar shape
  // here so a single glance separates "flatline" from "active".
  // Both rows share a peak so their heights stay comparable at a
  // glance, and the bars slide right-to-left in lockstep with the
  // cores heatmap above using the same translateX trick.
  const peak = _hmNetPeak();
  const hmVer = window.__kioskFrame;
  _renderBarSpark(document.getElementById("hm-rx-spark"), _hmRxHist, peak, hmVer);
  _renderBarSpark(document.getElementById("hm-tx-spark"), _hmTxHist, peak, hmVer);

  // Per-row instantaneous rates sit next to each label so the spark
  // glyphs are flanked by absolute numbers, not just relative shape.
  _gSetText(document.getElementById("hm-rx-rate"), _hmFmtRate(rx));
  _gSetText(document.getElementById("hm-tx-rate"), _hmFmtRate(tx));

  // Card-head meta keeps just the ping reading — the up/down rates now
  // live on their own rows so duplicating them here would be noise.
  const ping = s.net && s.net.ping;
  let pingFrag = "—";
  if (ping && ping.gw && ping.gw.ms != null) {
    pingFrag = "ping " + ping.gw.ms.toFixed(1) + " ms";
  } else if (ping && ping.ext && ping.ext.ms != null) {
    pingFrag = "ping " + ping.ext.ms.toFixed(1) + " ms";
  }
  _gSetText(document.getElementById("hm-net-meta"), pingFrag);
}

// Hook the heatmap renderer into the existing layoutOnTick — the
// gauges renderer already runs on every tick; we wrap it so both
// alternate layouts stay live regardless of which one is visible.
const _layoutOnTick_gauges = window.layoutOnTick;
window.layoutOnTick = function (s, sm) {
  if (typeof _layoutOnTick_gauges === "function") _layoutOnTick_gauges(s, sm);
  try { _renderHeatmap(s, sm); }
  catch (e) { /* keep ticks resilient if heatmap DOM not ready */ }
};

// ══════════════════════════════════════════════════════════════════
// Flowstrip renderer
// ──────────────────────────────────────────────────────────────────
// Six columns (CPU · GPU · MEM · DISK · WAN/LAN · PING), each a
// vertical stack of [primary graph · big number · details ·
// secondary sparkline]. A single full-width process table spans
// the bottom of the layout.
//
// All graphs and sparks go through window.__kioskRenderSpark so they
// inherit the active graph style (braille / line) and scroll
// smoothly via the same CPU-graph trick. Per-metric history rings
// live in this module — we don't reuse the heatmap rings because
// the two renderers can disagree on push cadence and we want each
// layout's data path to stand on its own.
// ══════════════════════════════════════════════════════════════════

const FS_HIST = 600;
let _fsTempHist     = new Array(FS_HIST).fill(0);
let _fsGpuPowerHist = new Array(FS_HIST).fill(0);
let _fsSwapHist     = new Array(FS_HIST).fill(0);
let _fsDiskPctHist  = new Array(FS_HIST).fill(0);
let _fsDiskIoHist   = new Array(FS_HIST).fill(0);
let _fsRxHist       = new Array(FS_HIST).fill(0);
let _fsTxHist       = new Array(FS_HIST).fill(0);

function _fsRingPush(ring, v) {
  ring.push(v);
  if (ring.length > FS_HIST) ring.shift();
}

function _fsPushHistory(s) {
  _fsRingPush(_fsTempHist,     (s.cpu && s.cpu.temp_c) || 0);
  _fsRingPush(_fsGpuPowerHist, (s.gpu && s.gpu.power_w) || 0);
  _fsRingPush(_fsSwapHist,     (s.swap && s.swap.percent) || 0);
  _fsRingPush(_fsDiskPctHist,  (s.disk && s.disk.percent) || 0);
  _fsRingPush(_fsDiskIoHist,
    ((s.disk && s.disk.read_rate) || 0) + ((s.disk && s.disk.write_rate) || 0));
  _fsRingPush(_fsRxHist, (s.net && s.net.rx) || 0);
  _fsRingPush(_fsTxHist, (s.net && s.net.tx) || 0);
}

function _fsPeak(ring, floor) {
  let peak = floor || 1;
  for (let i = 0; i < ring.length; i++) if (ring[i] > peak) peak = ring[i];
  return peak;
}

// Inline "name pct%" pair for the bottom proc banner. Lazily
// re-uses existing children by index so the banner doesn't reflow
// on every tick — only the values change.
const FS_BANNER_LIMIT = 8;
function _fsEnsureBannerItems(n) {
  const root = document.getElementById("fs-procs-banner");
  if (!root) return;
  while (root.children.length < n) {
    const item = document.createElement("span");
    item.className = "fs-banner-item";
    const nm = document.createElement("span"); nm.className = "name";
    const pc = document.createElement("span"); pc.className = "pct";
    item.append(nm, pc);
    root.appendChild(item);
  }
  while (root.children.length > n) root.removeChild(root.lastChild);
}
function _fsCompactRate(n) {
  // Reference template uses "116K" rather than "116.0 K/s" because
  // the big-number slot has limited horizontal room. Drop the "/s"
  // and shorten the unit; precision drops as the magnitude grows.
  if (n < 1024)        return Math.round(n) + "";
  if (n < 1024**2)     return (n / 1024).toFixed(n / 1024 < 10 ? 1 : 0) + "K";
  if (n < 1024**3)     return (n / 1024**2).toFixed(n / 1024**2 < 10 ? 1 : 0) + "M";
  return (n / 1024**3).toFixed(2) + "G";
}

function _renderFlowstrip(s, sm) {
  _fsPushHistory(s);

  const renderSpark = window.__kioskRenderSpark;
  const hist = window.__kioskHist;
  // Per-tick version stamp for line-graph stutter prevention. Local
  // history rings pass this through so the SVG keeps animating even
  // when the underlying value plateaus (idle GPU, idle disk i/o).
  // Block-glyph sparks at the bottom of each column don't need a
  // version — they re-render text on every call anyway.
  const ver = window.__kioskFrame;

  // ── CPU column ──
  const cpuPct = sm && Number.isFinite(sm.cpuPct) ? sm.cpuPct : (s.cpu && s.cpu.avg) || 0;
  _gSetText(document.getElementById("fs-cpu-pct"), cpuPct.toFixed(0) + "%");
  if (s.cpu) {
    // Sub-line mirrors the reference: "59°C · I7-6700"
    const tempStr = s.cpu.temp_c != null ? s.cpu.temp_c.toFixed(0) + "°C" : "—";
    const modelStr = (s.cpu.model || "").replace(/Intel\s+Core\s+/i, "").trim() || "—";
    _gSetText(document.getElementById("fs-cpu-sub"), tempStr + " · " + modelStr);
  }
  if (renderSpark && hist && hist.cpu) {
    renderSpark(document.getElementById("fs-cpu-graph"), hist.cpu.arr(), 100, ver);
  }
  _renderBarSpark(document.getElementById("fs-cpu-spark"), _fsTempHist, 1, ver);

  // ── MEM column ──
  const memPct = sm && Number.isFinite(sm.memPct) ? sm.memPct : (s.mem && s.mem.percent) || 0;
  _gSetText(document.getElementById("fs-mem-pct"), memPct.toFixed(0) + "%");
  if (s.mem) {
    _gSetText(document.getElementById("fs-mem-sub"),
      _gFmtBytes(s.mem.used) + " / " + _gFmtBytes(s.mem.total));
  }
  if (renderSpark && hist && hist.mem) {
    renderSpark(document.getElementById("fs-mem-graph"), hist.mem.arr(), 100, ver);
  }
  _renderBarSpark(document.getElementById("fs-mem-spark"), _fsSwapHist, 1, ver);

  // ── GPU column (auto-collapses on hosts with no usable iGPU) ──
  const gpuCol  = document.getElementById("fs-gpu-col");
  const cols    = document.getElementById("fs-cols");
  const gpu = s.gpu;
  if (gpu && gpu.available) {
    if (gpuCol && gpuCol.hidden) gpuCol.hidden = false;
    if (cols) cols.classList.remove("no-gpu");
    _gSetText(document.getElementById("fs-gpu-pct"), (gpu.busy || 0).toFixed(0) + "%");
    // "8.7 W · HD 530" style sub-line — power on the left, short
    // model name on the right. Falls back to temp if no power sensor.
    const powerStr = gpu.power_w != null ? gpu.power_w.toFixed(1) + " W"
      : (gpu.temp_c != null ? gpu.temp_c.toFixed(0) + "°C" : "—");
    const gpuModel = (gpu.model || "").replace(/^Intel\s+/i, "").replace(/Graphics/i, "").trim() || "GPU";
    _gSetText(document.getElementById("fs-gpu-sub"), powerStr + " · " + gpuModel);
    if (renderSpark && hist && hist.gpu) {
      renderSpark(document.getElementById("fs-gpu-graph"), hist.gpu.arr(), 100, ver);
    }
    _renderBarSpark(document.getElementById("fs-gpu-spark"), _fsGpuPowerHist, 1, ver);
  } else {
    if (gpuCol && !gpuCol.hidden) gpuCol.hidden = true;
    if (cols) cols.classList.add("no-gpu");
  }

  // ── DISK column — primary fill % drives the big number; the
  // bottom block-glyph spark is read+write rate (more dynamic). ──
  const primary = _gPickPrimaryDisk(s.disks) || (s.disk && {
    label: "/", total: s.disk.total, used: s.disk.used, percent: s.disk.percent,
  });
  if (primary) {
    _gSetText(document.getElementById("fs-disk-pct"),  primary.percent.toFixed(0) + "%");
    _gSetText(document.getElementById("fs-disk-sub"),
      (primary.label || "/") + " · " + _gFmtBytes(primary.used));
  }
  if (renderSpark) {
    renderSpark(document.getElementById("fs-disk-graph"), _fsDiskPctHist, 100, ver);
  }
  _renderBarSpark(document.getElementById("fs-disk-spark"), _fsDiskIoHist, 1024, ver);

  // ── WAN column — big number is the current download rate (compact),
  // sub-line carries upload + interface name. ──
  const wan = s.net && s.net.wan;
  const rx = (s.net && s.net.rx) || 0;
  const tx = (s.net && s.net.tx) || 0;
  _gSetText(document.getElementById("fs-net-rx"), _fsCompactRate(rx));
  _gSetText(document.getElementById("fs-net-sub"),
    "↑ " + _fsCompactRate(tx) + " · " + ((wan && wan.iface) || "net"));
  if (renderSpark) {
    const netPeak = Math.max(_fsPeak(_fsRxHist, 1024), _fsPeak(_fsTxHist, 1024));
    renderSpark(document.getElementById("fs-net-graph"), _fsRxHist, netPeak, ver);
  }
  _renderBarSpark(document.getElementById("fs-net-spark"), _fsTxHist, 1024, ver);

  // ── PING column — server-provided history rings drive the top
  // graph; the animation pacer in renderLineSpark uses the actual
  // inter-sample interval (~1 Hz) so the graph slides continuously
  // between pings. The bottom block-glyph spark shows external
  // ping with a 5-bucket bar shape, complementing the smooth line. ──
  const ping = s.net && s.net.ping;
  if (ping) {
    if (ping.gw) {
      _gSetText(document.getElementById("fs-ping-gw"),
        ping.gw.ms == null ? "↯" : ping.gw.ms.toFixed(1));
      _gSetText(document.getElementById("fs-ping-sub"),
        "gw · " + (ping.gw.target || "—"));
      if (renderSpark && Array.isArray(ping.gw.hist)) {
        // No version: ping data is server-driven and only changes
        // when a fresh ping result arrives, not every client tick.
        renderSpark(document.getElementById("fs-ping-graph"),
          ping.gw.hist, ping.gw.scale_ms || 100);
      }
    }
    if (ping.ext && Array.isArray(ping.ext.hist)) {
      // No version: ping is server-driven at ~1 Hz, so the slide
      // paces itself off real sample arrivals, not the client tick.
      _renderBarSpark(document.getElementById("fs-ping-spark"),
        ping.ext.hist, 1);
    }
  }

  // ── Bottom proc banner: "TOP name pct% name pct% … +N more" ──
  if (Array.isArray(s.procs_top)) {
    const visible = Math.min(s.procs_top.length, FS_BANNER_LIMIT);
    _fsEnsureBannerItems(visible);
    const root = document.getElementById("fs-procs-banner");
    for (let i = 0; i < visible; i++) {
      const p = s.procs_top[i];
      const item = root.children[i];
      if (item.children[0].textContent !== p.name) {
        item.children[0].textContent = p.name;
      }
      _gSetText(item.children[1], p.cpu.toFixed(0) + "%");
    }
    const remaining = Math.max(0, (s.procs || 0) - visible);
    _gSetText(document.getElementById("fs-procs-more"),
      remaining > 0 ? "+" + remaining + " more" : "—");
  }
}

// Hook the flowstrip renderer in alongside heatmap/gauges so all
// alternate layouts stay live regardless of which one is visible.
const _layoutOnTick_heatmap = window.layoutOnTick;
window.layoutOnTick = function (s, sm) {
  if (typeof _layoutOnTick_heatmap === "function") _layoutOnTick_heatmap(s, sm);
  try { _renderFlowstrip(s, sm); }
  catch (e) { /* keep ticks resilient if flowstrip DOM not ready */ }
};

// Apply persisted layout on initial load (silent — no toast).
applyLayout(currentLayout);

// ══════════════════════════════════════════════════════════════════
// Widget modularity — per-layout enable/disable + reorder.
// ──────────────────────────────────────────────────────────────────
// Each layout exposes a catalog of widgets grouped by their parent
// container. The user can reorder widgets within a group (▲▼) and
// toggle individual widgets off. Anchor widgets cannot be hidden
// (e.g. heatmap's cores × time card — without it the layout has
// nothing to show).
//
// When the stored config diverges from the default the group's
// container is flagged with [data-modular="1"], which switches its
// grid to auto-flow column with minmax(0, 1fr) tracks so visible
// widgets proportionally fill the empty space at any screen size.
// Persisted under kiosk.widgets.<layout> so each layout keeps its
// own configuration across reloads and back-and-forth switches.
// ══════════════════════════════════════════════════════════════════

const LAYOUT_WIDGETS = {
  default: {
    label: "DEFAULT",
    // The default layout uses a column model instead of slot groups:
    // each column hosts one widget (single) or two widgets stacked
    // 50/50 (pair). The user can reshape any column at runtime via
    // the WIDGETS picker — top/bottom widget choice + mode toggle.
    columnSpec: {
      container: ".panels",
      widgets: [
        { id: "cpu",  label: "CPU",  selector: '[data-widget="cpu"]'  },
        { id: "gpu",  label: "GPU",  selector: '[data-widget="gpu"]', autohide: true },
        { id: "mem",  label: "MEM",  selector: '[data-widget="mem"]'  },
        { id: "disk", label: "DISK", selector: '[data-widget="disk"]' },
        { id: "net",  label: "NET",  selector: '[data-widget="net"]'  },
        { id: "proc", label: "PROC", selector: '[data-widget="proc"]' },
      ],
      defaultColumns: [
        { top: "cpu",  bottom: "gpu"  },
        { top: "mem",  bottom: null   },
        { top: "disk", bottom: "net"  },
        { top: "proc", bottom: null   },
      ],
    },
  },
  gauges: {
    label: "GAUGES",
    groups: [
      {
        label: "DIALS",
        container: ".gauges-row",
        widgets: [
          { id: "g-cpu",  label: "CPU",  selector: "#g-cpu" },
          { id: "g-gpu",  label: "GPU",  selector: "#g-gpu",  autohide: true },
          { id: "g-mem",  label: "MEM",  selector: "#g-mem" },
          { id: "g-disk", label: "DISK", selector: "#g-disk" },
        ],
      },
      {
        label: "CARDS",
        container: ".gauges-grid",
        widgets: [
          { id: "g-card-cpu",  label: "CPU + CORES", selector: ".g-cpu-card" },
          { id: "g-card-net",  label: "NETWORK",     selector: ".g-net" },
          { id: "g-card-proc", label: "PROCESSES",   selector: ".g-procs" },
        ],
      },
    ],
  },
  heatmap: {
    label: "HEATMAP",
    groups: [
      {
        label: "STATS STRIP",
        container: ".hm-pcts",
        widgets: [
          { id: "hm-cpu",  label: "CPU",  selector: "#hm-pct-cpu" },
          { id: "hm-mem",  label: "MEM",  selector: "#hm-pct-mem" },
          { id: "hm-disk", label: "DISK", selector: "#hm-pct-disk" },
          { id: "hm-gpu",  label: "GPU",  selector: "#hm-gpu-cell", autohide: true },
          { id: "hm-load", label: "LOAD", selector: "#hm-pct-load" },
        ],
      },
      {
        label: "SECTIONS",
        container: ".layout-heatmap",
        widgets: [
          { id: "hm-cores", label: "CORES × TIME", selector: ".hm-cores-card", anchor: true },
          { id: "hm-net",   label: "NET",          selector: ".hm-net-card" },
        ],
      },
    ],
  },
  flowstrip: {
    label: "FLOWSTRIP",
    groups: [
      {
        label: "COLUMNS",
        container: ".fs-cols",
        widgets: [
          { id: "fs-cpu",  label: "CPU",  selector: ".fs-cols > .fs-cpu" },
          { id: "fs-mem",  label: "MEM",  selector: ".fs-cols > .fs-mem" },
          { id: "fs-gpu",  label: "GPU",  selector: "#fs-gpu-col", autohide: true },
          { id: "fs-disk", label: "DISK", selector: ".fs-cols > .fs-disk" },
          { id: "fs-net",  label: "WAN",  selector: ".fs-cols > .fs-net" },
          { id: "fs-ping", label: "PING", selector: ".fs-cols > .fs-ping" },
        ],
      },
      {
        label: "BOTTOM STRIP",
        container: ".layout-flowstrip",
        widgets: [
          { id: "fs-procs", label: "TOP PROCESSES BANNER", selector: ".fs-procs-banner" },
        ],
      },
    ],
  },
};

// Storage model: per layout we save a "slots" object — one array
// per group, each entry is either a widget ID (the widget to show
// at that slot) or null (slot is OFF). Default config = slot i
// contains spec.widgets[i].id for each group. This shape lets each
// slot be independently re-targeted via a single cycle button —
// the picker shows N rows (one per slot) rather than reordering a
// list. A widget can be referenced from only one slot at a time;
// cycling to a widget already in another slot SWAPS the two.
const WIDGET_STORAGE_PREFIX = "kiosk.widgets.";

function _wLoadConfig(layout) {
  try {
    const raw = localStorage.getItem(WIDGET_STORAGE_PREFIX + layout);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {}
  return null;
}
function _wSaveConfig(layout, cfg) {
  try { localStorage.setItem(WIDGET_STORAGE_PREFIX + layout, JSON.stringify(cfg)); }
  catch (e) {}
}
function _wClearConfig(layout) {
  try { localStorage.removeItem(WIDGET_STORAGE_PREFIX + layout); } catch (e) {}
}

// Each slot has TWO independent properties:
//   • id  — which widget type this slot displays (changed via the
//           cycle button; cycling never goes to "OFF", so widgets
//           can't accidentally leak away when stepping past nulls)
//   • on  — whether this slot is currently visible (changed via
//           the per-row ON/OFF toggle; independent of the cycle)
// Cycling swaps id with whatever other slot currently has that
// target id, so each widget appears at most once across the
// group. Toggling on/off is purely local to the slot — no swaps.
function _wResolveGroupSlots(group, storedGroup) {
  const validIds = new Set(group.widgets.map((w) => w.id));
  const N = group.widgets.length;

  let slots;
  if (Array.isArray(storedGroup) && storedGroup.length) {
    slots = storedGroup.map((entry, idx) => {
      const fallbackId = (group.widgets[idx] && group.widgets[idx].id) || group.widgets[0].id;
      if (entry == null) {
        // Earlier slot-only ["id" | null, …] shape — null meant OFF.
        return { id: fallbackId, on: false };
      }
      if (typeof entry === "string") {
        return { id: validIds.has(entry) ? entry : fallbackId, on: true };
      }
      if (typeof entry === "object" && entry !== null) {
        return {
          id: validIds.has(entry.id) ? entry.id : fallbackId,
          on: entry.on !== false,
        };
      }
      return { id: fallbackId, on: true };
    });
    while (slots.length < N) {
      slots.push({ id: group.widgets[slots.length].id, on: true });
    }
    slots.length = N;
  } else {
    slots = group.widgets.map((w) => ({ id: w.id, on: true }));
  }

  // Duplicates allowed: cycling no longer swaps with collisions, so
  // two slots can hold the same widget id. _wApplyGroup renders the
  // widget at the first ON occurrence; subsequent matching slots
  // show the same name in the picker but don't render an extra copy
  // (there's only one DOM element per widget). The user toggles OFF
  // any duplicates they don't want.

  // Anchors are fixed at their declared slot and stay ON forever.
  for (const w of group.widgets) {
    if (!w.anchor) continue;
    const declared = group.widgets.findIndex((x) => x.id === w.id);
    const current  = slots.findIndex((s) => s.id === w.id);
    if (current !== declared) {
      const displaced = slots[declared];
      slots[declared] = { id: w.id, on: true };
      if (current >= 0) slots[current] = displaced;
    }
    slots[declared].on = true;
  }
  return slots;
}

function _wResolveLayout(layout) {
  const spec = LAYOUT_WIDGETS[layout];
  if (!spec) return null;
  const stored = _wLoadConfig(layout);
  if (spec.columnSpec) {
    return {
      layout, label: spec.label, kind: "columns",
      spec: spec.columnSpec,
      columns: _wResolveColumns(spec.columnSpec, stored),
    };
  }
  const groups = spec.groups.map((g) => ({
    label: g.label,
    container: g.container,
    widgets: g.widgets,
    slots: _wResolveGroupSlots(g, stored && stored.groups && stored.groups[g.label]),
  }));
  return { layout, label: spec.label, kind: "groups", groups };
}

// ── Column model (default layout) ─────────────────────────────────
// Stored as { version: 2, columns: [{top, bottom}, ...] }. Legacy
// configs in the v1 "groups" shape are ignored and we fall back to
// defaults — the v1 shape grouped CPU+GPU into a single widget so
// there is no clean migration to per-half pairing.
function _wResolveColumns(cspec, stored) {
  const validIds = new Set(cspec.widgets.map((w) => w.id));
  const defaults = cspec.defaultColumns;
  let src = null;
  if (stored && stored.version === 2 && Array.isArray(stored.columns)) {
    src = stored.columns;
  }
  const cols = defaults.map((d, i) => {
    const entry = src && src[i] ? src[i] : d;
    const top = entry && validIds.has(entry.top) ? entry.top : null;
    const bottom = entry && validIds.has(entry.bottom) ? entry.bottom : null;
    return { top, bottom };
  });
  return cols;
}

function _wIsWidgetAvailable(widget) {
  if (!widget) return false;
  if (!widget.autohide) return true;
  // Autohide widgets (currently GPU) hide their own DOM via the
  // `hidden` attribute when the metrics feed reports no data. A
  // configured autohide widget that has no data should not occupy a
  // column slot — the column collapses to the other half (or hides
  // entirely if both halves are unavailable).
  const el = document.querySelector(widget.selector);
  return !!(el && !el.hidden);
}

function _wApplyColumns(resolved) {
  const cspec = resolved.spec;
  const container = document.querySelector(cspec.container);
  if (!container) return;

  // Pull each widget element out of its current home so columns can
  // be (re)built in any order.
  const widgetById = new Map();
  cspec.widgets.forEach((w) => {
    const el = document.querySelector(w.selector);
    widgetById.set(w.id, { ...w, el });
    if (el && el.parentElement) el.parentElement.removeChild(el);
  });

  // Sections are recreated from scratch every apply so column add /
  // remove from the picker is just a config-array edit — no need to
  // track section identity. Existing sections get wiped first.
  Array.from(container.querySelectorAll('section.panel[data-col-id]'))
    .forEach((s) => s.remove());

  const placed = new Set();
  let visibleCount = 0;
  resolved.columns.forEach((cfg, idx) => {
    const section = document.createElement("section");
    section.className = "panel";
    section.dataset.colId = String(idx + 1);

    // First-claim-wins: a widget id already placed in an earlier
    // column shows as empty here. Lets the user configure freely
    // without surprise swaps; the modal flags duplicates explicitly.
    const wantTop = cfg.top && !placed.has(cfg.top) ? widgetById.get(cfg.top) : null;
    const wantBot = cfg.bottom && !placed.has(cfg.bottom) ? widgetById.get(cfg.bottom) : null;
    const topOK = wantTop && wantTop.el && _wIsWidgetAvailable(wantTop);
    const botOK = wantBot && wantBot.el && _wIsWidgetAvailable(wantBot);

    if (!topOK && !botOK) {
      // Empty column — drop the section entirely so the grid reflows.
      return;
    }
    visibleCount++;
    if (topOK && botOK) {
      section.dataset.colMode = "pair";
      section.classList.add("split-panel");
      section.appendChild(wantTop.el);
      section.appendChild(wantBot.el);
      placed.add(wantTop.id);
      placed.add(wantBot.id);
    } else {
      section.dataset.colMode = "single";
      const w = topOK ? wantTop : wantBot;
      section.appendChild(w.el);
      placed.add(w.id);
    }
    container.appendChild(section);
  });

  // Widgets that didn't land anywhere get parked at the end, hidden,
  // so a later re-apply can pick them up without losing their event
  // listeners or live-update bindings.
  widgetById.forEach((w) => {
    if (!w.el) return;
    if (!w.el.parentElement) {
      container.appendChild(w.el);
      w.el.classList.add("widget-hidden");
    } else {
      w.el.classList.remove("widget-hidden");
    }
  });

  container.style.setProperty("--visible-cols", String(visibleCount || 1));
  container.dataset.visibleCols = String(visibleCount);
}

function _wIsDefaultGroup(group) {
  for (let i = 0; i < group.widgets.length; i++) {
    if (group.slots[i].id !== group.widgets[i].id) return false;
    if (!group.slots[i].on) return false;
  }
  return true;
}

function _wApplyGroup(group) {
  const container = document.querySelector(group.container);
  if (!container) return;
  const isDefault = _wIsDefaultGroup(group);
  if (isDefault) container.removeAttribute("data-modular");
  else container.setAttribute("data-modular", "1");

  // Each widget renders at the FIRST ON slot that holds its id;
  // additional ON slots claiming the same id are visible in the
  // picker as duplicates but only contribute one rendered copy of
  // the widget (there's a single DOM element per widget). Slots
  // whose id is never ON anywhere mark their widget hidden.
  const firstOnSlot = new Map();
  group.slots.forEach((s, idx) => {
    if (s.on && !firstOnSlot.has(s.id)) firstOnSlot.set(s.id, idx);
  });
  group.widgets.forEach((w) => {
    const el = document.querySelector(w.selector);
    if (!el) return;
    const slotIdx = firstOnSlot.get(w.id);
    if (slotIdx == null) {
      el.classList.add("widget-hidden");
      el.style.order = "";
    } else {
      el.classList.remove("widget-hidden");
      el.style.order = String(slotIdx + 1);
    }
  });

  // Whole-group-empty signal — used by the gauges layout to
  // collapse the row entirely when every dial / card is OFF, so
  // the surviving section fills the available space.
  const allEmpty = group.slots.every((s) => !s.on);
  if (allEmpty) container.setAttribute("data-empty", "1");
  else container.removeAttribute("data-empty");
}

function applyWidgetConfig(layout) {
  const resolved = _wResolveLayout(layout);
  if (!resolved) return;
  if (resolved.kind === "columns") {
    _wApplyColumns(resolved);
    return;
  }
  resolved.groups.forEach(_wApplyGroup);
}
window.__kioskApplyWidgets = applyWidgetConfig;

function _wCurrentLayoutName() {
  const a = document.documentElement.getAttribute("data-layout");
  return a || "default";
}

function _wPersistFromResolved(layout, resolved) {
  if (resolved.kind === "columns") {
    _wSaveConfig(layout, { version: 2, columns: resolved.columns.map(
      (c) => ({ top: c.top || null, bottom: c.bottom || null })
    ) });
    return;
  }
  const cfg = { groups: {} };
  for (const g of resolved.groups) {
    cfg.groups[g.label] = g.slots.map((s) => ({ id: s.id, on: !!s.on }));
  }
  _wSaveConfig(layout, cfg);
}

// ── Column model helpers (modal-facing) ───────────────────────────
// Cycling a slot rotates through (OFF, ...widget ids) for the bottom
// half and (...widget ids) for the top. Picking a widget that's
// already used in another column does NOT swap — duplicates are
// allowed in the config, and the apply step renders only the first
// claim (later columns show "—DUP—" in the picker so the user can
// spot it). The user can keep the duplicate or pick something else.
function _wColumnsCycleSlot(resolved, colIdx, pos, dir) {
  const cspec = resolved.spec;
  const options = [null];
  cspec.widgets.forEach((w) => {
    if (w.autohide) {
      const el = document.querySelector(w.selector);
      if (el && el.hidden) return;
    }
    options.push(w.id);
  });
  // Both top and bottom can be OFF — top OFF + bottom set means the
  // bottom widget renders full-height; both OFF removes the column
  // from the rendered grid.
  const col = resolved.columns[colIdx];
  const currentId = col[pos];
  let cursor = options.indexOf(currentId);
  if (cursor < 0) cursor = 0;
  cursor = (cursor + dir + options.length) % options.length;
  resolved.columns[colIdx][pos] = options[cursor];
}

function _wColumnsSetMode(resolved, colIdx, mode) {
  const col = resolved.columns[colIdx];
  if (mode === "single") {
    col.bottom = null;
  } else if (mode === "pair") {
    if (col.bottom == null) {
      // Promote to pair with the first available widget. Preferred
      // candidate is one not already used in another column, but it's
      // OK to start with a duplicate — the user can immediately cycle
      // away from it via the BOT picker.
      const used = new Set();
      resolved.columns.forEach((c) => {
        if (c.top)    used.add(c.top);
        if (c.bottom) used.add(c.bottom);
      });
      const cspec = resolved.spec;
      let cand = cspec.widgets.find((w) => {
        if (used.has(w.id)) return false;
        if (w.autohide) {
          const el = document.querySelector(w.selector);
          if (el && el.hidden) return false;
        }
        return true;
      });
      if (!cand) {
        cand = cspec.widgets.find((w) => {
          if (w.autohide) {
            const el = document.querySelector(w.selector);
            if (el && el.hidden) return false;
          }
          return true;
        });
      }
      col.bottom = cand ? cand.id : null;
    }
  }
}

// Clearing a column drops both widget picks but preserves the row
// in the picker, so the user can re-enable the column later by
// cycling its TOP picker to a widget — no separate "add column"
// flow needed. Apply skips columns with nothing set, so the grid
// reflows like the column was removed.
function _wColumnsClear(resolved, colIdx) {
  resolved.columns[colIdx] = { top: null, bottom: null };
}

function _wColumnLabel(cspec, id) {
  if (!id) return "— OFF";
  const w = cspec.widgets.find((x) => x.id === id);
  return w ? w.label : "?";
}

// Returns true when this slot's widget id is already taken by an
// earlier slot — the picker uses this to flag duplicates so the
// user understands why their pick isn't rendering.
function _wColumnsIsDup(columns, colIdx, pos) {
  const id = columns[colIdx][pos];
  if (!id) return false;
  for (let i = 0; i < colIdx; i++) {
    if (columns[i].top === id) return true;
    if (columns[i].bottom === id) return true;
  }
  if (pos === "bottom" && columns[colIdx].top === id) return true;
  return false;
}

// Cycle slot `idx` to the next widget TYPE in the rotation.
// Cycling only mutates this slot — other slots are untouched, so
// duplicates can occur (the user explicitly opted into this so
// they can compose any combination and toggle OFF unwanted
// repeats). Visibility is separate (the row's ON/OFF toggle).
function _wCycleSlot(group, idx, dir) {
  const opts = group.widgets.map((w) => w.id);
  const currentId = group.slots[idx].id;
  const currentSpec = group.widgets.find((w) => w.id === currentId);
  if (currentSpec && currentSpec.anchor) return;
  let cursor = opts.indexOf(currentId);
  if (cursor < 0) cursor = 0;
  for (let step = 0; step < opts.length; step++) {
    cursor = (cursor + dir + opts.length) % opts.length;
    const cnd = opts[cursor];
    if (cnd === currentId) continue;
    // Skip anchored widgets — they can only live at their declared
    // slot, so they're not valid targets for any other slot.
    const cndSpec = group.widgets.find((w) => w.id === cnd);
    if (cndSpec && cndSpec.anchor) continue;
    // Skip widgets the renderer has auto-hidden (no usable data)
    // so the user can't land on a slot that would render blank.
    if (cndSpec && cndSpec.autohide) {
      const el = document.querySelector(cndSpec.selector);
      if (el && el.hidden) continue;
    }
    group.slots[idx] = { id: cnd, on: group.slots[idx].on };
    return;
  }
}

function _wToggleSlot(group, idx) {
  const spec = group.widgets.find((w) => w.id === group.slots[idx].id);
  if (spec && spec.anchor) return; // anchors are always on
  group.slots[idx].on = !group.slots[idx].on;
}

function _wSlotLabel(group, id) {
  const spec = group.widgets.find((w) => w.id === id);
  return spec ? spec.label : "?";
}

function _renderWidgetsModal() {
  const root = document.getElementById("widgets-list");
  const titleEl = document.getElementById("widgets-title");
  if (!root) return;
  const layout = _wCurrentLayoutName();
  const resolved = _wResolveLayout(layout);
  root.innerHTML = "";
  if (titleEl) titleEl.textContent = (resolved && resolved.label) || "—";
  if (!resolved) return;

  if (resolved.kind === "columns") {
    _renderColumnsModal(root, layout, resolved);
    return;
  }

  resolved.groups.forEach((group) => {
    const sec = document.createElement("div");
    sec.className = "widgets-group";

    const head = document.createElement("div");
    head.className = "widgets-group-head";
    head.textContent = group.label + " · " + group.slots.length + " slots";
    sec.appendChild(head);

    group.slots.forEach((slot, idx) => {
      const row = document.createElement("div");
      row.className = "widgets-row";
      const spec = group.widgets.find((w) => w.id === slot.id);
      const isAnchor = !!(spec && spec.anchor);
      if (isAnchor)  row.classList.add("anchor");
      if (!slot.on)  row.classList.add("off");

      const pos = document.createElement("span");
      pos.className = "widgets-pos";
      pos.textContent = String(idx + 1);

      const prev = document.createElement("button");
      prev.className = "widgets-move";
      prev.textContent = "◀";
      prev.setAttribute("aria-label", "Previous widget");
      prev.disabled = isAnchor;
      prev.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isAnchor) return;
        _wCycleSlot(group, idx, -1);
        _wPersistFromResolved(layout, resolved);
        applyWidgetConfig(layout);
        _renderWidgetsModal();
      });
      prev.addEventListener("pointerdown", (e) => e.stopPropagation());
      prev.addEventListener("pointerup",   (e) => e.stopPropagation());

      // Cycle button shows the widget TYPE currently assigned to
      // this slot. Tapping advances to the next type (with
      // swap-on-collision so each type appears at most once).
      // It does NOT toggle visibility — that's the ON/OFF button.
      const cycle = document.createElement("button");
      cycle.className = "widgets-cycle";
      cycle.textContent = _wSlotLabel(group, slot.id);
      cycle.title = isAnchor ? "Anchor — required by this layout"
                             : "Tap to cycle widget type at this slot";
      cycle.disabled = isAnchor;
      if (slot.on)   cycle.classList.add("on");
      if (isAnchor)  cycle.classList.add("anchor");
      cycle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isAnchor) return;
        _wCycleSlot(group, idx, +1);
        _wPersistFromResolved(layout, resolved);
        applyWidgetConfig(layout);
        _renderWidgetsModal();
      });
      cycle.addEventListener("pointerdown", (e) => e.stopPropagation());
      cycle.addEventListener("pointerup",   (e) => e.stopPropagation());

      const next = document.createElement("button");
      next.className = "widgets-move";
      next.textContent = "▶";
      next.setAttribute("aria-label", "Next widget");
      next.disabled = isAnchor;
      next.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isAnchor) return;
        _wCycleSlot(group, idx, +1);
        _wPersistFromResolved(layout, resolved);
        applyWidgetConfig(layout);
        _renderWidgetsModal();
      });
      next.addEventListener("pointerdown", (e) => e.stopPropagation());
      next.addEventListener("pointerup",   (e) => e.stopPropagation());

      // Independent ON/OFF toggle — hides/shows this slot's
      // widget without disturbing its assigned type or swapping
      // with neighbouring slots. Cycling later is non-destructive.
      const toggle = document.createElement("button");
      toggle.className = "widgets-toggle";
      if (isAnchor) {
        toggle.textContent = "LOCKED";
        toggle.disabled = true;
        toggle.title = "Required by this layout";
      } else {
        toggle.textContent = slot.on ? "ON" : "OFF";
        toggle.classList.toggle("on", !!slot.on);
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          _wToggleSlot(group, idx);
          _wPersistFromResolved(layout, resolved);
          applyWidgetConfig(layout);
          _renderWidgetsModal();
        });
        toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
        toggle.addEventListener("pointerup",   (e) => e.stopPropagation());
      }

      row.append(pos, prev, cycle, next, toggle);
      sec.appendChild(row);
    });

    root.appendChild(sec);
  });

  const reset = document.createElement("button");
  reset.className = "widgets-reset";
  reset.textContent = "RESET TO DEFAULTS";
  reset.addEventListener("click", (e) => {
    e.stopPropagation();
    _wClearConfig(layout);
    applyWidgetConfig(layout);
    _renderWidgetsModal();
  });
  reset.addEventListener("pointerdown", (e) => e.stopPropagation());
  reset.addEventListener("pointerup",   (e) => e.stopPropagation());
  root.appendChild(reset);
}

// ── Columns modal renderer (default layout) ───────────────────────
// One row per column. Each row exposes:
//   • a SINGLE/PAIR mode toggle
//   • a TOP widget picker (◀ name ▶)
//   • a BOTTOM widget picker shown only in PAIR mode; its picker can
//     land on "— OFF" which behaves like flipping the column back to
//     SINGLE without losing the top widget choice
// Picking a widget already used in another column SWAPS the two so
// each widget appears in at most one place.
function _renderColumnsModal(root, layout, resolved) {
  const cspec = resolved.spec;
  const persist = () => {
    _wPersistFromResolved(layout, resolved);
    applyWidgetConfig(layout);
    _renderWidgetsModal();
  };

  const mkBtn = (cls, txt, onClick, opts) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = txt;
    if (opts && opts.title) b.title = opts.title;
    if (opts && opts.disabled) b.disabled = true;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("pointerup",   (e) => e.stopPropagation());
    return b;
  };

  resolved.columns.forEach((col, idx) => {
    const isPair = col.bottom != null;

    const card = document.createElement("div");
    card.className = "widgets-col-card";

    const head = document.createElement("div");
    head.className = "widgets-col-head";
    const pos = document.createElement("span");
    pos.className = "widgets-col-pos";
    pos.textContent = "COL " + (idx + 1);
    head.appendChild(pos);

    const modeBtn = mkBtn(
      "widgets-col-mode" + (isPair ? " pair" : ""),
      isPair ? "PAIR" : "SINGLE",
      () => {
        _wColumnsSetMode(resolved, idx, isPair ? "single" : "pair");
        persist();
      },
      { title: "Toggle column between single widget and stacked pair" }
    );
    head.appendChild(modeBtn);

    const clearBtn = mkBtn(
      "widgets-col-remove",
      "✕",
      () => { _wColumnsClear(resolved, idx); persist(); },
      { title: "Clear both picks (column hides until you cycle TOP back to a widget)" }
    );
    head.appendChild(clearBtn);

    card.appendChild(head);

    const makePickerRow = (label, posKey) => {
      const row = document.createElement("div");
      row.className = "widgets-row widgets-col-row";
      const isDup = _wColumnsIsDup(resolved.columns, idx, posKey);
      if (isDup) row.classList.add("dup");
      const tag = document.createElement("span");
      tag.className = "widgets-pos";
      tag.textContent = label;
      const prev = mkBtn("widgets-move", "◀",
        () => { _wColumnsCycleSlot(resolved, idx, posKey, -1); persist(); },
        { title: "Previous widget" });
      const widgetLabel = _wColumnLabel(cspec, col[posKey]);
      const text = isDup ? widgetLabel + "  · DUP" : widgetLabel;
      const cycle = mkBtn(
        "widgets-cycle" + (col[posKey] ? " on" : "") + (isDup ? " dup" : ""),
        text,
        () => { _wColumnsCycleSlot(resolved, idx, posKey, +1); persist(); },
        { title: isDup ? "Already used in an earlier column — pick a different one"
                       : "Cycle widget" }
      );
      const next = mkBtn("widgets-move", "▶",
        () => { _wColumnsCycleSlot(resolved, idx, posKey, +1); persist(); },
        { title: "Next widget" });
      row.append(tag, prev, cycle, next);
      return row;
    };

    card.appendChild(makePickerRow("TOP", "top"));
    if (isPair) card.appendChild(makePickerRow("BOT", "bottom"));

    root.appendChild(card);
  });

  const hint = document.createElement("div");
  hint.className = "widgets-col-hint";
  hint.textContent = "tap PAIR to stack two widgets · ✕ clears a column · DUP marks a widget already used elsewhere";
  root.appendChild(hint);

  const reset = mkBtn("widgets-reset", "RESET TO DEFAULTS", () => {
    _wClearConfig(layout);
    applyWidgetConfig(layout);
    _renderWidgetsModal();
  });
  root.appendChild(reset);
}

function openWidgetsModal() {
  _renderWidgetsModal();
  const m = document.getElementById("widgets-modal");
  if (m) m.classList.add("show");
}
function closeWidgetsModal() {
  const m = document.getElementById("widgets-modal");
  if (m) m.classList.remove("show");
}
window.__kioskOpenWidgets  = openWidgetsModal;
window.__kioskCloseWidgets = closeWidgetsModal;

const widgetsModalEl = document.getElementById("widgets-modal");
if (widgetsModalEl) {
  widgetsModalEl.addEventListener("click", (e) => {
    if (e.target === widgetsModalEl) closeWidgetsModal();
  });
  widgetsModalEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  widgetsModalEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeWidgetsModal();
});

// Apply for every layout on load so hidden layouts (data-layout
// inactive) are already configured the moment the user switches
// to them — config persistence is per-layout, so each one keeps
// its own ON/OFF set and ordering across reloads.
(function _wApplyAll() {
  for (const name of Object.keys(LAYOUT_WIDGETS)) applyWidgetConfig(name);
})();

// ══════════════════════════════════════════════════════════════════
// VIGOSK main menu + unified keyboard router
// ──────────────────────────────────────────────────────────────────
// Escape toggles the menu when no picker/settings modal is open.
// The menu is just a transparent overlay with a backdrop blur — the
// live kiosk keeps ticking behind it. Three actions: SETTINGS, HELP,
// QUIT. Arrow keys move focus between actions, Enter activates.
//
// Global shortcuts (active when no modal/menu is up):
//   s · open settings        a · prev theme
//   w · open widgets         d · next theme
//   l · open layouts         1-4 · jump to layout
//   g · open line mode       ?   · show help
//   t · open theme picker    esc · open VIGOSK menu
// ══════════════════════════════════════════════════════════════════
function openVtermMenu() {
  const help = document.getElementById("vigosk-help");
  if (help) help.classList.remove("show");
  const m = document.getElementById("vigosk-menu");
  if (m) {
    m.classList.add("show");
    _vigoskFocusAction(0);
  }
}
function closeVtermMenu() {
  const m = document.getElementById("vigosk-menu");
  if (m) m.classList.remove("show");
  const help = document.getElementById("vigosk-help");
  if (help) help.classList.remove("show");
}
function openVtermHelp() {
  const m = document.getElementById("vigosk-menu");
  if (m) m.classList.remove("show");
  const help = document.getElementById("vigosk-help");
  if (help) help.classList.add("show");
}
window.__kioskOpenVtermMenu  = openVtermMenu;
window.__kioskCloseVtermMenu = closeVtermMenu;
window.__kioskOpenVtermHelp  = openVtermHelp;

// Focus tracking for arrow-key navigation across action buttons.
let _vigoskActionIdx = 0;
function _vigoskActions() {
  return [...document.querySelectorAll("#vigosk-menu .vigosk-menu-action")];
}
function _vigoskFocusAction(idx) {
  const els = _vigoskActions();
  if (!els.length) return;
  _vigoskActionIdx = ((idx % els.length) + els.length) % els.length;
  els.forEach((el, i) => el.classList.toggle("focused", i === _vigoskActionIdx));
  if (els[_vigoskActionIdx]) els[_vigoskActionIdx].focus({ preventScroll: true });
}
function _vigoskActivate() {
  const els = _vigoskActions();
  const el = els[_vigoskActionIdx];
  if (el) el.click();
}

(function _wireVtermMenu() {
  const m = document.getElementById("vigosk-menu");
  if (m) {
    m.addEventListener("click", (e) => { if (e.target === m) closeVtermMenu(); });
  }
  const setBtn = document.getElementById("vigosk-settings-btn");
  if (setBtn) setBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeVtermMenu();
    if (typeof window.__kioskOpenSettings === "function") window.__kioskOpenSettings();
  });
  const helpBtn = document.getElementById("vigosk-help-btn");
  if (helpBtn) helpBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openVtermHelp();
  });
  const quitBtn = document.getElementById("vigosk-quit-btn");
  if (quitBtn) quitBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // window.close() only succeeds on tabs opened by script — on
    // the kiosk chromium it generally no-ops, which is the right
    // safety default. Hook this to a real shutdown command (e.g.
    // POST /kiosk/shutdown) if/when the operator wants it active.
    try { window.close(); } catch (_) {}
    closeVtermMenu();
  });
  const help = document.getElementById("vigosk-help");
  if (help) help.addEventListener("click", () => closeVtermMenu());
})();

// Per-modal arrow/Enter navigation. Each modal exposes a flat list
// of focusable items + a column count for 2D arrow nav. The first
// arrow press auto-focuses index 0 if nothing is focused yet.
const _MODAL_NAV = {
  "settings-modal": { sel: ".settings-btn",      cols: 1 },
  "theme-modal":    { sel: ".theme-swatch",      cols: 3 },
  "layouts-modal":  { sel: ".layout-swatch",     cols: 2 },
  "graph-modal":    { sel: ".graph-swatch",      cols: 2 },
};
const _modalFocusIdx = {};

function _modalItems(modalId) {
  const cfg = _MODAL_NAV[modalId];
  if (!cfg) return [];
  return [...document.querySelectorAll("#" + modalId + " " + cfg.sel)];
}
function _modalSetFocus(modalId, idx) {
  const items = _modalItems(modalId);
  if (!items.length) { _modalFocusIdx[modalId] = -1; return; }
  idx = ((idx % items.length) + items.length) % items.length;
  _modalFocusIdx[modalId] = idx;
  items.forEach((el, i) => el.classList.toggle("focused", i === idx));
  if (items[idx]) items[idx].focus({ preventScroll: true });
}
function _modalMove(modalId, dRow, dCol) {
  const items = _modalItems(modalId);
  if (!items.length) return;
  const cols = _MODAL_NAV[modalId].cols;
  let cur = _modalFocusIdx[modalId];
  if (cur == null || cur < 0) { _modalSetFocus(modalId, 0); return; }
  if (cols === 1) {
    _modalSetFocus(modalId, cur + dRow);
    return;
  }
  const row = Math.floor(cur / cols);
  const col = cur % cols;
  const rows = Math.ceil(items.length / cols);
  const newRow = ((row + dRow) % rows + rows) % rows;
  const newCol = ((col + dCol) % cols + cols) % cols;
  let newIdx = newRow * cols + newCol;
  if (newIdx >= items.length) newIdx = items.length - 1;
  _modalSetFocus(modalId, newIdx);
}
function _modalActivate(modalId) {
  const items = _modalItems(modalId);
  const idx = _modalFocusIdx[modalId];
  if (idx == null || idx < 0 || !items[idx]) return;
  items[idx].click();
}

// The widgets picker is structured row × {prev, cycle, toggle, next},
// so arrow nav is custom: ↑↓ moves between slots, ←→ cycles the
// widget at the focused slot, Enter toggles ON/OFF.
function _widgetsRows() {
  return [...document.querySelectorAll("#widgets-modal .widgets-row")];
}
let _widgetsRowIdx = 0;
function _widgetsFocusRow(idx) {
  const rows = _widgetsRows();
  if (!rows.length) { _widgetsRowIdx = -1; return; }
  idx = ((idx % rows.length) + rows.length) % rows.length;
  _widgetsRowIdx = idx;
  rows.forEach((r, i) => r.classList.toggle("focused", i === idx));
  const cycle = rows[idx] && rows[idx].querySelector(".widgets-cycle");
  if (cycle) cycle.focus({ preventScroll: true });
}
function _widgetsRowClick(selector) {
  const rows = _widgetsRows();
  const r = rows[_widgetsRowIdx];
  if (!r) return;
  const btn = r.querySelector(selector);
  if (btn && !btn.disabled) btn.click();
}

function _routeModalKey(e) {
  // Identify which modal is on top. The check order matches the
  // back-navigation chain so sub-modals win over the settings modal.
  const order = ["widgets-modal", "graph-modal", "theme-modal", "layouts-modal", "settings-modal"];
  let active = null;
  for (const id of order) {
    const el = document.getElementById(id);
    if (el && el.classList.contains("show")) { active = id; break; }
  }
  if (!active) return;

  if (active === "widgets-modal") {
    if (e.key === "ArrowDown") { e.preventDefault(); _widgetsFocusRow(_widgetsRowIdx + 1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); _widgetsFocusRow(_widgetsRowIdx - 1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); _widgetsRowClick(".widgets-move:first-of-type"); return; }
    if (e.key === "ArrowRight"){ e.preventDefault(); _widgetsRowClick(".widgets-move:last-of-type"); return; }
    if (e.key === "Enter")     { e.preventDefault(); _widgetsRowClick(".widgets-toggle"); return; }
    return;
  }

  // Grid-style pickers (settings is single-column, others are grids).
  if (e.key === "ArrowDown")  { e.preventDefault(); _modalMove(active, +1,  0); return; }
  if (e.key === "ArrowUp")    { e.preventDefault(); _modalMove(active, -1,  0); return; }
  if (e.key === "ArrowRight") { e.preventDefault(); _modalMove(active,  0, +1); return; }
  if (e.key === "ArrowLeft")  { e.preventDefault(); _modalMove(active,  0, -1); return; }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (_modalFocusIdx[active] == null || _modalFocusIdx[active] < 0) {
      _modalSetFocus(active, 0);
    } else {
      _modalActivate(active);
    }
    return;
  }
}

// Reset modal focus state whenever an open call runs so each
// re-entry starts at the top row instead of stale state from a
// previous session.
function _resetModalFocus(modalId) {
  _modalFocusIdx[modalId] = -1;
  const items = _modalItems(modalId);
  items.forEach((el) => el.classList.remove("focused"));
}
const _origOpenSettings = window.__kioskOpenSettings;
if (typeof _origOpenSettings === "function") {
  window.__kioskOpenSettings = function() {
    _origOpenSettings();
    _resetModalFocus("settings-modal");
  };
}
const _origOpenWidgets = window.__kioskOpenWidgets;
if (typeof _origOpenWidgets === "function") {
  window.__kioskOpenWidgets = function() {
    _origOpenWidgets();
    _widgetsRowIdx = -1;
    document.querySelectorAll("#widgets-modal .widgets-row").forEach((r) => r.classList.remove("focused"));
  };
}

// Unified keyboard router. Runs in the capture phase so it can
// short-circuit the per-modal Escape handlers above when the
// VIGOSK menu or help overlay is the layer that should respond.
function _anyPickerModalOpen() {
  return !!document.querySelector(".theme-modal.show");
}
function _vigoskMenuOpen() {
  const m = document.getElementById("vigosk-menu");
  return !!(m && m.classList.contains("show"));
}
function _vigoskHelpOpen() {
  const m = document.getElementById("vigosk-help");
  return !!(m && m.classList.contains("show"));
}

window.addEventListener("keydown", (e) => {
  // Don't capture keys when the user is typing into an input.
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;

  // ── Help overlay layer: Escape returns to menu, anything else closes. ──
  if (_vigoskHelpOpen()) {
    if (e.key === "Escape") { e.preventDefault(); openVtermMenu(); return; }
    return;
  }

  // ── VIGOSK menu layer: arrow nav + Enter to activate. ──
  if (_vigoskMenuOpen()) {
    if (e.key === "Escape") {
      e.preventDefault(); closeVtermMenu(); return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault(); _vigoskFocusAction(_vigoskActionIdx + 1); return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault(); _vigoskFocusAction(_vigoskActionIdx - 1); return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); _vigoskActivate(); return;
    }
    return;
  }

  // ── Picker/settings modal layer ──
  if (_anyPickerModalOpen()) {
    _routeModalKey(e);
    return;
  }

  // ── Kiosk live layer: all global shortcuts ──
  // Lowercase EVERY key (Escape, ArrowRight, single letters) so the
  // switch below stays case-insensitive — the earlier "k.length===1"
  // guard left "Escape" capitalised and silently fell through.
  const lower = (typeof e.key === "string") ? e.key.toLowerCase() : "";
  switch (lower) {
    case "escape": e.preventDefault(); openVtermMenu(); break;
    case "s": e.preventDefault(); if (window.__kioskOpenSettings) window.__kioskOpenSettings(); break;
    case "w": e.preventDefault(); if (window.__kioskOpenWidgets)  window.__kioskOpenWidgets();  break;
    case "l": e.preventDefault(); if (window.__kioskOpenLayouts)  window.__kioskOpenLayouts();  break;
    case "g": e.preventDefault(); if (typeof openGraphModal === "function") openGraphModal();   break;
    case "t": e.preventDefault(); if (typeof openThemeModal === "function") openThemeModal();   break;
    case "a": e.preventDefault(); if (typeof cycleTheme === "function") cycleTheme(-1); break;
    case "d": e.preventDefault(); if (typeof cycleTheme === "function") cycleTheme(+1); break;
    case "?": e.preventDefault(); openVtermHelp(); break;
    case "1": e.preventDefault(); applyLayout("default");   break;
    case "2": e.preventDefault(); applyLayout("gauges");    break;
    case "3": e.preventDefault(); applyLayout("heatmap");   break;
    case "4": e.preventDefault(); applyLayout("flowstrip"); break;
  }
}, true);

