"use strict";

// ── Polling cadence and history ────────────────────────────────────
// TICK_MS is mutable (header +/- buttons); start from saved pref or default.
const DEFAULT_TICK_MS = 100;
const MIN_TICK_MS = 100;
const MAX_TICK_MS = 2000;
const TICK_STEP_MS = 100;
let TICK_MS = (() => {
  try {
    const v = parseInt(localStorage.getItem("kiosk.tickMs") || "", 10);
    if (Number.isFinite(v) && v >= MIN_TICK_MS && v <= MAX_TICK_MS) return v;
  } catch (e) {}
  return DEFAULT_TICK_MS;
})();
const PROC_EVERY = 8;                 // ~800 ms: rebuild process list
const HISTORY = 1200;                 // 120 s of 100ms samples

// ── Graph style (header chip toggle) ───────────────────────────────
// "braille" = the original Unicode braille graph (denser, glyph-y).
// "line"    = an inline SVG line + shaded area (smoother, classic look).
// Persisted across reloads so the kiosk comes back the way the user
// left it. The active style is also reflected as data-graph-style on
// <html> for CSS to drive any per-style tweaks (e.g. suppressing the
// braille text-shadow when the SVG path takes over).
const GRAPH_STYLES = ["braille", "line"];
const GRAPH_CHIP_LABEL = { braille: "BRA", line: "LIN" };
let currentGraphStyle = (() => {
  try {
    const v = localStorage.getItem("kiosk.graphStyle");
    if (GRAPH_STYLES.includes(v)) return v;
  } catch (e) {}
  return "braille";
})();

// ── Display smoothing ──────────────────────────────────────────────
// The server already returns cpu.avg as a 1s rolling-window mean, so the
// number/bars are smooth at source. The client EMA is just a final glide
// pass — α small ⇒ very slow change, α large ⇒ tracks server tightly.
// cpu.raw stays unfiltered and feeds the heartbeat graph for real-time look.
const SMOOTH_ALPHA = 0.10;
const cpuSm = { avg: 0, per: [] };
const memSm = { pct: 0, swap: 0, disk: 0 };
function ema(prev, next) {
  if (!Number.isFinite(prev)) return next;
  return prev + SMOOTH_ALPHA * (next - prev);
}

// ── Braille graph rendering ────────────────────────────────────────
// btop-style midline-spike: each subcolumn is a vertical bar centered on
// the middle of the panel. The middle pair of cells is always lit, and the
// bar grows symmetrically up and down as the value rises.
//
// Braille dot bit layout (Unicode block U+2800 base):
//   1 4   bit 0x01 / 0x08
//   2 5   bit 0x02 / 0x10
//   3 6   bit 0x04 / 0x20
//   7 8   bit 0x40 / 0x80
const LEVEL_LEFT  = [0, 0x40, 0x04, 0x02, 0x01];   // bottom→top within a row, left subcol
const LEVEL_RIGHT = [0, 0x80, 0x20, 0x10, 0x08];   // bottom→top within a row, right subcol

function brailleGraph(data, cols, rows, max) {
  const totalLevels = rows * 4;
  const halfTotal   = totalLevels / 2;
  const points = cols * 2;

  let out = "";
  for (let r = 0; r < rows; r++) {
    // rowFloor is the level just below this row's lowest cell.
    const rowFloor = (rows - 1 - r) * 4;
    for (let c = 0; c < cols; c++) {
      let bits = 0;
      for (let sc = 0; sc < 2; sc++) {
        const idx = data.length - points + (c * 2 + sc);
        const v = (idx >= 0 ? data[idx] : 0) || 0;
        // Bar height in cells: at least 1 so the midline is always saturated.
        let h = (v / max) * totalLevels;
        if (h < 1) h = 1;
        if (h > totalLevels) h = totalLevels;
        const barLo = halfTotal - h / 2;   // bottom edge in level units (0..totalLevels)
        const barHi = halfTotal + h / 2;   // top edge
        const table = sc === 0 ? LEVEL_LEFT : LEVEL_RIGHT;
        // For each of this row's 4 cells, light if its center is inside [barLo, barHi].
        for (let lv = 1; lv <= 4; lv++) {
          const cellMid = (rowFloor + lv) - 0.5;
          if (cellMid >= barLo && cellMid <= barHi) {
            bits |= table[lv];
          }
        }
      }
      out += String.fromCharCode(0x2800 + bits);
    }
    if (r < rows - 1) out += "\n";
  }
  return out;
}

// ── Ring buffers ───────────────────────────────────────────────────
const ring = (n) => {
  const buf = new Array(n).fill(0);
  return {
    push(v) { buf.push(v); if (buf.length > n) buf.shift(); },
    arr: () => buf,
  };
};

const hist = {
  cpu: ring(HISTORY),
  mem: ring(HISTORY),
  gpu: ring(HISTORY),
};
let peakRx = 0, peakTx = 0;

// Exposed for layouts.js so alternate layouts can render the same
// sparkline ring without re-fetching or re-computing the EMA.
window.__kioskHist = hist;
window.__kioskPeaks = () => ({ rx: peakRx, tx: peakTx });

// ── Formatters ─────────────────────────────────────────────────────
function fmtBytes(n) {
  //   = non-breaking space — keeps "11.6 G" together so the unit
  // never wraps to a new line under a narrow column.
  if (n < 1024) return n.toFixed(0) + " B";
  if (n < 1024**2) return (n/1024).toFixed(1) + " K";
  if (n < 1024**3) return (n/1024**2).toFixed(1) + " M";
  if (n < 1024**4) return (n/1024**3).toFixed(2) + " G";
  return (n/1024**4).toFixed(2) + " T";
}
function fmtRate(n) { return fmtBytes(n) + "/s"; }
function fmtUptime(s) {
  s = Math.floor(s);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function colorFor(pct) {
  if (pct < 50) return "var(--fg-bright)";
  if (pct < 75) return "var(--accent-2)";
  if (pct < 90) return "var(--warn)";
  return "var(--crit)";
}
function tempColor(t) {
  if (t == null) return "var(--dim)";
  if (t < 55) return "var(--fg-bright)";
  if (t < 70) return "var(--accent-2)";
  if (t < 85) return "var(--warn)";
  return "var(--crit)";
}

// ── Temperature unit (°C / °F) ─────────────────────────────────────
// Single source of truth for every temperature shown anywhere (CPU,
// GPU, all layouts). The server always reports Celsius; we convert
// only on display and never store both. Colour thresholds stay keyed
// off the raw Celsius value so the warn/crit bands are unit-agnostic.
const TEMP_UNITS = ["C", "F"];
let currentTempUnit = (() => {
  try {
    const v = localStorage.getItem("kiosk.tempUnit");
    if (TEMP_UNITS.includes(v)) return v;
  } catch (e) {}
  return "C";
})();
// fmtTemp(celsius, opts): opts.compact drops the space before °,
// opts.noUnit returns the bare number, opts.digits sets precision,
// opts.dash is the string used when celsius is null/undefined.
function fmtTemp(c, opts) {
  opts = opts || {};
  if (c == null) return opts.dash != null ? opts.dash : ("— °" + currentTempUnit);
  const digits = opts.digits != null ? opts.digits : 0;
  const val = currentTempUnit === "F" ? (c * 9 / 5 + 32) : c;
  const num = val.toFixed(digits);
  if (opts.noUnit) return num;
  return num + (opts.compact ? "" : " ") + "°" + currentTempUnit;
}
// Exposed so layouts.js renders temps through the same converter.
window.__kioskFmtTemp = (c, opts) => fmtTemp(c, opts);
window.__kioskTempUnit = () => currentTempUnit;

function setTempUnit(u) {
  currentTempUnit = (u === "F") ? "F" : "C";
  try { localStorage.setItem("kiosk.tempUnit", currentTempUnit); } catch (e) {}
  const valEl = document.getElementById("settings-temp-value");
  if (valEl) valEl.textContent = "°" + currentTempUnit;
}
function cycleTempUnit() { setTempUnit(currentTempUnit === "C" ? "F" : "C"); }

// ── Process sort (client-side over the server's top-N list) ────────
// The server returns the top processes already ranked by CPU; the user
// can re-sort the displayed list by CPU, MEM, or PID and toggle the
// direction by tapping the same column header again. cpu/mem default
// to high→low (most useful at a glance); pid defaults to low→high.
const PROC_SORT_FIELDS = ["cpu", "mem", "pid"];
const PROC_SORT_DEFAULT_DIR = { cpu: -1, mem: -1, pid: 1 }; // -1 = desc, +1 = asc
let procSortField = (() => {
  try {
    const v = localStorage.getItem("kiosk.procSort");
    if (PROC_SORT_FIELDS.includes(v)) return v;
  } catch (e) {}
  return "cpu";
})();
let procSortDir = (() => {
  try {
    const v = parseInt(localStorage.getItem("kiosk.procSortDir"), 10);
    if (v === 1 || v === -1) return v;
  } catch (e) {}
  return -1;
})();

function sortProcs(arr) {
  const f = procSortField, d = procSortDir;
  const copy = arr.slice();
  copy.sort((a, b) => {
    const av = f === "pid" ? a.pid : (f === "mem" ? a.mem : a.cpu);
    const bv = f === "pid" ? b.pid : (f === "mem" ? b.mem : b.cpu);
    if (av === bv) return a.pid - b.pid;     // stable tiebreak by PID
    return (av < bv ? -1 : 1) * d;
  });
  return copy;
}
// Exposed so the gauges layout's process card honours the same sort.
window.__kioskSortProcs = sortProcs;

function _updateProcSortIndicators() {
  document.querySelectorAll(".proc-sort").forEach((el) => {
    const base = el.dataset.label || (el.dataset.label = el.textContent.replace(/\s*[▲▼]\s*$/, ""));
    if (el.dataset.sort === procSortField) {
      el.classList.add("active");
      el.textContent = base + (procSortDir === 1 ? "▲" : "▼");
    } else {
      el.classList.remove("active");
      el.textContent = base;
    }
  });
}
function setProcSort(field) {
  if (!PROC_SORT_FIELDS.includes(field)) return;
  if (procSortField === field) procSortDir = -procSortDir;
  else { procSortField = field; procSortDir = PROC_SORT_DEFAULT_DIR[field]; }
  try {
    localStorage.setItem("kiosk.procSort", procSortField);
    localStorage.setItem("kiosk.procSortDir", String(procSortDir));
  } catch (e) {}
  _updateProcSortIndicators();
  if (_lastStats) renderProcs(_lastStats);   // re-render immediately
}

// ── DOM helpers ────────────────────────────────────────────────────
function setBar(fillEl, pct) {
  pct = Math.max(0, Math.min(100, pct));
  fillEl.style.right = (100 - pct) + "%";
}

function buildCores(n) {
  const root = document.getElementById("cores");
  root.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const row = document.createElement("div");
    row.className = "core";
    row.innerHTML = `
      <span class="id">c${String(i).padStart(2,"0")}</span>
      <div class="bar"><div class="fill" id="core-fill-${i}"></div></div>
      <span class="pct" id="core-pct-${i}">0%</span>
    `;
    root.appendChild(row);
  }
}

// Short labels for the four i915 engines so they fit the per-engine grid.
const GPU_ENGINE_LABEL = {
  "Render/3D": "rdr",
  "Blitter":   "blt",
  "Video":     "vid",
  "VideoEnhance": "vfx",
};
function gpuEngineKey(name) { return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase(); }

function buildGpuEngines(names) {
  const root = document.getElementById("gpu-engines");
  root.innerHTML = "";
  for (const name of names) {
    const key = gpuEngineKey(name);
    const row = document.createElement("div");
    row.className = "core";
    row.innerHTML = `
      <span class="id">${GPU_ENGINE_LABEL[name] || name.slice(0,3).toLowerCase()}</span>
      <div class="bar"><div class="fill" id="gpu-eng-fill-${key}"></div></div>
      <span class="pct" id="gpu-eng-pct-${key}">0%</span>
    `;
    root.appendChild(row);
  }
}

// Dynamic disk rows — one per real mount or LVM thin pool. Reused across ticks.
function ensureDiskRows(disks) {
  const root = document.getElementById("disk-stats");
  if (!root) return;
  if (root.childElementCount === disks.length
      && [...root.children].every((el, i) => el.dataset.label === disks[i].label)) {
    return;
  }
  root.innerHTML = "";
  disks.forEach((d, i) => {
    const wrap = document.createElement("div");
    wrap.dataset.label = d.label;
    wrap.innerHTML = `
      <div class="row"><span class="k">${d.label}</span><span class="v" id="disk-line-${i}"><span class="usage-bytes" id="disk-usage-${i}">—</span><span class="usage-pct" id="disk-pct-${i}"></span></span></div>
      <div class="bar"><div class="fill" id="disk-fill-${i}"></div></div>
    `;
    root.appendChild(wrap);
  });
}

// ── Compute braille-graph dimensions from the rendered <pre> size ──
function computeBrailleDims(el) {
  // One braille char ≈ font-size × ~0.6 wide, font-size × ~1.0 tall.
  const cs = window.getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 14;
  const charW = fs * 0.6;
  const charH = fs * 1.0;
  const w = el.clientWidth || el.parentElement.clientWidth;
  const h = el.clientHeight || el.parentElement.clientHeight;
  if (w < 4 || h < 4) return null;
  return {
    cols: Math.max(4, Math.floor(w / charW) - 1),
    rows: Math.max(1, Math.floor(h / charH)),
  };
}

// ── SVG line spark (scrolling) ────────────────────────────────────
// Naïvely re-rendering the path every tick at fixed x positions made
// each point's coordinates change between frames — even with
// transition:d, the curve "wobbled" because every control point was
// in motion at once. The fix: lay out points at fixed x positions in
// SVG user space and SCROLL the wrapping <g> left by exactly stepX
// over one tick. The path itself includes one extra sample to the
// left (about to exit) and one to the right (about to enter), so the
// snap from translateX(-stepX) at the end of frame N back to
// translateX(0) with the next frame's path is visually identical —
// the new sample appears at the right edge and slides in over the
// next TICK_MS at constant velocity.
const SVG_NS = "http://www.w3.org/2000/svg";
const SPARK_PX_PER_POINT = 3;          // sample density target

function _ensureSvgSpark(el) {
  if (el._svg) return el._svg;
  el.textContent = "";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spark-svg");
  svg.setAttribute("preserveAspectRatio", "none");
  // <g> is the scroll layer; we translateX it instead of mutating
  // the path so each frame's path is the new shape and the motion
  // comes from a single transform animation.
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "spark-scroll");
  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("class", "spark-area");
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "spark-line");
  g.appendChild(area);
  g.appendChild(line);
  svg.appendChild(g);
  el.appendChild(svg);
  el._svg = svg;
  el._scroll = g;
  el._line = line;
  el._area = area;
  el._w = 0; el._h = 0;
  el._initialized = false;
  el._sig = "";
  return svg;
}

function _clearSvgSpark(el) {
  if (!el._svg) return;
  el.removeChild(el._svg);
  el._svg = null; el._line = null; el._area = null; el._scroll = null;
  el._w = 0; el._h = 0; el._initialized = false; el._sig = "";
  el._lastUpdate = 0;
}

function renderLineSpark(el, data, max, version) {
  if (!el || !data || !data.length) return;
  const w = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 0;
  const h = el.clientHeight || (el.parentElement && el.parentElement.clientHeight) || 0;
  if (w < 4 || h < 4) return;

  const svg = _ensureSvgSpark(el);
  let dimsChanged = false;
  if (el._w !== w || el._h !== h) {
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width",  String(w));
    svg.setAttribute("height", String(h));
    el._w = w; el._h = h;
    dimsChanged = true;
  }

  // Visible point count (Nvis), step between points, and the total
  // count we actually render (Nvis + 2 — one offscreen left of x=0
  // and one offscreen right of x=W).
  const Nvis  = Math.max(8, Math.min(data.length, Math.floor(w / SPARK_PX_PER_POINT)));
  const stepX = w / (Nvis - 1);
  const total = Nvis + 2;

  // Pull the most recent `total` samples; if the buffer is shorter
  // (kiosk just started), pad on the LEFT by repeating the oldest
  // available value so the chart starts as a flat line and fills in
  // naturally rather than ramping up from 0.
  const start  = Math.max(0, data.length - total);
  const have   = data.length - start;
  const denom  = max > 0 ? max : 1;
  const xs = new Array(total);
  const ys = new Array(total);
  for (let k = 0; k < total; k++) {
    const idx = (k < total - have) ? start : (start + k - (total - have));
    const v   = Math.max(0, Math.min(denom, data[idx] || 0));
    xs[k] = (k - 1) * stepX;                    // first at -stepX, last at W+stepX
    ys[k] = h - 1 - (v / denom) * (h - 2);
  }

  // Catmull-Rom → cubic Bezier with tension 0.5. The path covers
  // [-stepX, W+stepX] in user space; the SVG root clips to [0, W].
  let lineD = "M" + xs[0].toFixed(1) + "," + ys[0].toFixed(1);
  for (let i = 1; i < total; i++) {
    const x0 = xs[i - 1], y0 = ys[i - 1];
    const x1 = xs[i],     y1 = ys[i];
    const xp = i >= 2          ? xs[i - 2] : x0;
    const yp = i >= 2          ? ys[i - 2] : y0;
    const xn = i < total - 1   ? xs[i + 1] : x1;
    const yn = i < total - 1   ? ys[i + 1] : y1;
    const cp1x = x0 + (x1 - xp) / 6;
    const cp1y = y0 + (y1 - yp) / 6;
    const cp2x = x1 - (xn - x0) / 6;
    const cp2y = y1 - (yn - y0) / 6;
    lineD += " C" + cp1x.toFixed(1) + "," + cp1y.toFixed(1)
           + " "  + cp2x.toFixed(1) + "," + cp2y.toFixed(1)
           + " "  + x1.toFixed(1)   + "," + y1.toFixed(1);
  }
  const areaD = lineD
    + " L" + xs[total - 1].toFixed(1) + "," + h
    + " L" + xs[0].toFixed(1)         + "," + h + " Z";

  // Detect whether the input data actually advanced. The base hash
  // is "len|last|second-last", but that's fooled by sources that
  // plateau at a single value (e.g. GPU sitting at 0% for many
  // ticks) — the sig stops mutating and the SVG freezes. When the
  // caller has a per-tick counter (frame number for local rings),
  // it passes it as `version` and the sig advances every tick.
  // Server-driven data (ping history) leaves version undefined so
  // the sig still falls back to content-based change detection,
  // preventing a 10 Hz client tick from scrolling a 1 Hz graph
  // ten times too fast.
  const len = data.length;
  const sig = (version != null ? version + "|" : "") +
              len + "|" + (data[len - 1] || 0) + "|" + (data[len - 2] || 0);
  const dataChanged = (el._sig !== sig);
  el._sig = sig;

  el._line.setAttribute("d", lineD);
  el._area.setAttribute("d", areaD);

  const g = el._scroll;
  const tickMs = (typeof TICK_MS === "number" && TICK_MS > 0) ? TICK_MS : 100;

  if (!el._initialized || dimsChanged) {
    // First frame on this element (or the container resized) — place
    // the scroll layer at 0 with no animation, then start the first
    // glide so the user sees motion immediately rather than a static
    // chart for one tick. Seed _lastUpdate now so the next sample's
    // interval calc has a baseline to subtract from.
    g.style.transition = "none";
    g.style.transform  = "translateX(0)";
    el._initialized = true;
    el._lastUpdate = performance.now();
    // Force the browser to commit the snap before re-arming the
    // transition; without this, both writes get coalesced and the
    // transition silently elides.
    void g.getBoundingClientRect();
    g.style.transition = "transform " + tickMs + "ms linear";
    g.style.transform  = "translateX(" + (-stepX).toFixed(2) + "px)";
  } else if (dataChanged) {
    // New sample(s) on the right — snap back to translateX(0) with
    // the freshly-computed (left-shifted by 1) path. Visually a no-op
    // because end-of-last-frame at translateX(-stepX) with the OLD
    // path renders pixel-for-pixel the same as start-of-this-frame at
    // translateX(0) with the NEW path. Then animate one stepX again.
    //
    // Animation duration follows the *source's* sample interval, not
    // TICK_MS — for a 1 Hz ping graph driven by a 10 Hz refresh loop
    // this stretches the slide across the full ~1000ms gap so the
    // graph reads as continuous motion instead of a 100ms scroll
    // followed by 900ms of stillness.
    const now = performance.now();
    const last = el._lastUpdate || 0;
    const interval = last ? Math.max(50, Math.min(2500, now - last)) : tickMs;
    el._lastUpdate = now;
    g.style.transition = "none";
    g.style.transform  = "translateX(0)";
    void g.getBoundingClientRect();
    g.style.transition = "transform " + interval.toFixed(0) + "ms linear";
    g.style.transform  = "translateX(" + (-stepX).toFixed(2) + "px)";
  }
  // else: no new data this tick — leave transform alone so the
  // existing animation keeps running. This prevents a 10 Hz client
  // tick from scrolling a 1 Hz ping graph ten times too fast.
}

function renderSpark(el, data, max, version) {
  if (!el) return;
  if (currentGraphStyle === "line") {
    renderLineSpark(el, data, max, version);
    return;
  }
  // Braille mode (default). If we just toggled away from line mode,
  // tear down the SVG so the pre is back to plain-text rendering.
  if (el._svg) _clearSvgSpark(el);
  const dims = computeBrailleDims(el);
  if (!dims) return;
  el.textContent = brailleGraph(data, dims.cols, dims.rows, max);
}
// Exposed for layouts.js so the gauges card can reuse the same renderer.
window.__kioskRenderSpark = renderSpark;

// Per-target ping renderer. Pushes target ip, latency text, and a sparkline
// from the server-provided history ring. ms === null ⇒ packet loss / down.
function renderPingSlot(slot, data, scale) {
  if (!data) return;
  setText(document.getElementById(`ping-${slot}-target`), data.target || "—");
  const msEl = document.getElementById(`ping-${slot}-ms`);
  if (data.ms == null) {
    setText(msEl, "↯");
    setStyle(msEl, "color", "var(--crit)");
  } else {
    setText(msEl, data.ms.toFixed(1) + " ms");
    setStyle(msEl, "color", data.ms > 60 ? "var(--warn)" : "var(--fg-bright)");
  }
  if (Array.isArray(data.hist)) {
    renderSpark(document.getElementById(`ping-${slot}-spark`), data.hist, scale);
  }
}

function tickClock() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  const s = String(d.getSeconds()).padStart(2,"0");
  document.getElementById("clock").textContent = `${h}:${m}:${s}`;
}

// ── Proc list rendering: reuse rows instead of innerHTML rebuild ───
function ensureProcRows(n) {
  const root = document.getElementById("proc-rows");
  while (root.children.length < n) {
    const row = document.createElement("div");
    row.className = "proc-row";
    const pid = document.createElement("span"); pid.className = "pid";
    const nm  = document.createElement("span"); nm.className  = "name";
    const cpu = document.createElement("span"); cpu.className = "cpu";
    const mem = document.createElement("span"); mem.className = "mem";
    row.append(pid, nm, cpu, mem);
    root.appendChild(row);
  }
  while (root.children.length > n) root.removeChild(root.lastChild);
}
function setText(el, v) { if (el && el.textContent !== v) el.textContent = v; }
function setStyle(el, prop, v) { if (el && el.style[prop] !== v) el.style[prop] = v; }

function renderProcs(s) {
  if (!Array.isArray(s.procs_top)) return;
  setText(document.getElementById("proc-meta"), s.procs + " total");
  const list = sortProcs(s.procs_top);
  ensureProcRows(list.length);
  const root = document.getElementById("proc-rows");
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const row = root.children[i];
    setText(row.children[0], String(p.pid));
    if (row.children[1].textContent !== p.name) {
      row.children[1].textContent = p.name;
      row.children[1].title = p.name;
    }
    const cpuColor = colorFor(Math.min(100, p.cpu));
    const memColor = colorFor(Math.min(100, p.mem));
    setText(row.children[2], p.cpu.toFixed(0));
    setStyle(row.children[2], "color", cpuColor);
    setText(row.children[3], p.mem.toFixed(1));
    setStyle(row.children[3], "color", memColor);
  }
}

// ── Container health rendering ─────────────────────────────────────
// The widget autohides (sets [hidden]) when nothing is configured, so
// the column applier collapses its slot — existing layouts are
// unchanged until the user adds container targets in Kiosk Settings.
// Rows are reused (no innerHTML churn): each shows a status dot, name,
// host, and the last RTT. up=green, down=red, pending(null)=neutral.
function ensureContainerRows(n) {
  const root = document.getElementById("containers-list");
  if (!root) return null;
  while (root.children.length < n) {
    const row = document.createElement("div");
    row.className = "ctr-row";
    const dot  = document.createElement("span"); dot.className  = "ctr-dot";
    const nm   = document.createElement("span"); nm.className   = "ctr-name";
    const host = document.createElement("span"); host.className = "ctr-host";
    const ms   = document.createElement("span"); ms.className   = "ctr-ms";
    row.append(dot, nm, host, ms);
    root.appendChild(row);
  }
  while (root.children.length > n) root.removeChild(root.lastChild);
  return root;
}

function renderContainers(c) {
  const half = document.getElementById("containers-half");
  if (!half) return;
  const list = (c && Array.isArray(c.list)) ? c.list : [];
  // Autohide when no targets are configured.
  if (list.length === 0) {
    if (!half.hidden) half.hidden = true;
    return;
  }
  if (half.hidden) half.hidden = false;

  let up = 0, down = 0;
  for (const it of list) {
    if (it.up === true) up++;
    else if (it.up === false) down++;
  }
  const metaEl = document.getElementById("containers-meta");
  const metaTxt = down > 0 ? `${up} up · ${down} down` : `${up} up`;
  setText(metaEl, metaTxt);
  setStyle(metaEl, "color", down > 0 ? "var(--crit)" : "var(--good)");

  const root = ensureContainerRows(list.length);
  if (!root) return;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const row = root.children[i];
    // state: up | down | pending
    const state = it.up === true ? "up" : (it.up === false ? "down" : "pending");
    if (row.dataset.state !== state) {
      row.dataset.state = state;
      row.className = "ctr-row ctr-" + state;
    }
    if (row.children[1].textContent !== it.name) {
      row.children[1].textContent = it.name;
      row.children[1].title = it.name;
    }
    setText(row.children[2], it.host || "");
    // Status text: live RTT when up, an explicit DOWN when the ping
    // failed, and CNR ("can't reach" — not yet pinged this sweep) while
    // the result is still pending. Down/unreachable containers stay
    // listed so the user always sees the full watch list, not just the
    // hosts that happen to be answering.
    let ms;
    if (it.up === true) ms = (it.ms != null ? it.ms.toFixed(1) + " ms" : "UP");
    else if (it.up === false) ms = "DOWN";
    else ms = "CNR";
    setText(row.children[3], ms);
  }
}

// ── Refresh loop ───────────────────────────────────────────────────
let coresBuilt = false;
let lastClockSec = -1;
let frame = 0;
// Last stats snapshot — lets a sort-control tap re-render the process
// list instantly without waiting for the next poll.
let _lastStats = null;
// Exposed so layouts.js can pass the same per-tick counter to its own
// renderSpark calls — needed to keep flat-value graphs (GPU at 0%,
// idle disk i/o, …) advancing every tick instead of freezing on
// repeating last-two-samples.
window.__kioskFrame = 0;

async function refresh() {
  let s;
  try {
    const r = await fetch("api/stats", { cache: "no-store" });
    s = await r.json();
    _lastStats = s;
  } catch (e) { return; }

  try {
    if (!coresBuilt) {
      buildCores(s.cpu.count);
      coresBuilt = true;
    }

    // ── Smoothing: EMA every tick keeps numbers and bars from snapping ──
    cpuSm.avg = ema(cpuSm.avg, s.cpu.avg);
    s.cpu.per.forEach((v, i) => { cpuSm.per[i] = ema(cpuSm.per[i], v); });
    memSm.pct  = ema(memSm.pct,  s.mem.percent);
    memSm.swap = ema(memSm.swap, s.swap.percent);
    memSm.disk = ema(memSm.disk, s.disk.percent);

    // ── History push for sparklines: graph uses raw values for a real-time
    //    heartbeat look; the number+bars use the smoothed values above. ──
    const cpuRaw = (typeof s.cpu.raw === "number") ? s.cpu.raw : s.cpu.avg;
    hist.cpu.push(cpuRaw);
    hist.mem.push(s.mem.percent);
    // Push GPU on the same fast tick as CPU/MEM so all sparklines scroll
    // in sync. The latest server-side value is held between intel_gpu_top
    // frames (~1 Hz upstream), giving the chart a stair-step shape but
    // matching the cadence of the others.
    hist.gpu.push((s.gpu && s.gpu.available) ? (s.gpu.busy || 0) : 0);
    if (s.net.rx > peakRx) peakRx = s.net.rx;
    if (s.net.tx > peakTx) peakTx = s.net.tx;

    window.__kioskFrame = ++frame;
    renderSpark(document.getElementById("cpu-spark"), hist.cpu.arr(), 100, frame);
    renderSpark(document.getElementById("mem-spark"), hist.mem.arr(), 100, frame);

    // ── Clock + uptime (1Hz) ──
    const now = Math.floor(s.ts);
    if (now !== lastClockSec) {
      lastClockSec = now;
      tickClock();
      setText(document.getElementById("uptime"), fmtUptime(s.uptime));
    }

    // ── Header ──
    setText(document.getElementById("host"), s.host);
    setText(document.getElementById("load"), s.load.map(x => x.toFixed(2)).join(" "));

    // CPU temperature display (inside CPU panel, next to big %).
    const tempEl = document.getElementById("cpu-temp");
    if (tempEl) {
      const t = s.cpu.temp_c;
      setText(tempEl, fmtTemp(t));
      setStyle(tempEl, "color", tempColor(t));
      setStyle(tempEl, "borderColor", tempColor(t));
    }

    // ── CPU ──
    const cpuPct = cpuSm.avg;
    const cpuEl = document.getElementById("cpu-pct");
    setText(cpuEl, cpuPct.toFixed(0) + "%");
    setStyle(cpuEl, "color", colorFor(cpuPct));

    setText(document.getElementById("cpu-meta-model"), s.cpu.model || "—");
    setText(document.getElementById("cpu-meta-freq"),
      s.cpu.freq_mhz ? (s.cpu.freq_mhz/1000).toFixed(2) + " GHz" : "—");
    setText(document.getElementById("cpu-meta-cores"), s.cpu.count + "c");

    for (let i = 0; i < s.cpu.per.length; i++) {
      const sv = cpuSm.per[i];
      const f = document.getElementById(`core-fill-${i}`);
      const p = document.getElementById(`core-pct-${i}`);
      if (f && p) {
        setBar(f, sv);
        setText(p, sv.toFixed(0) + "%");
        setStyle(p, "color", colorFor(sv));
      }
    }

    // ── GPU (panel auto-shows when intel_gpu_top is producing data) ──
    const gpuHalf = document.getElementById("gpu-half");
    const gpu = s.gpu;
    if (gpu && gpu.available) {
      gpuHalf.hidden = false;
      const engineNames = Object.keys(gpu.engines || {});
      // Rebuild engine grid only if the engine set changes (~once at startup).
      if (engineNames.length !== gpuHalf._engineCount
          || engineNames.join("|") !== gpuHalf._engineKey) {
        buildGpuEngines(engineNames);
        gpuHalf._engineCount = engineNames.length;
        gpuHalf._engineKey = engineNames.join("|");
      }
      const gpuPctEl = document.getElementById("gpu-pct");
      setText(gpuPctEl, gpu.busy.toFixed(0) + "%");
      setStyle(gpuPctEl, "color", colorFor(gpu.busy));
      setText(document.getElementById("gpu-meta-model"), gpu.model || "GPU");
      setText(document.getElementById("gpu-meta-freq"),
        gpu.freq_mhz ? gpu.freq_mhz.toFixed(0) + " MHz" : "—");
      // Display rule: prefer a *dedicated* GPU temp when the host exposes
      // one; otherwise show power. Avoids printing the same number as the
      // CPU panel on integrated GPUs (where there's no separate sensor).
      const goEl = document.getElementById("gpu-readout");
      if (gpu.temp_c != null) {
        setText(goEl, fmtTemp(gpu.temp_c));
        setStyle(goEl, "color", tempColor(gpu.temp_c));
        setStyle(goEl, "borderColor", tempColor(gpu.temp_c));
      } else if (gpu.power_w != null) {
        setText(goEl, gpu.power_w.toFixed(1) + " W");
        // Power readout uses fg-bright (no thermal threshold) and a neutral
        // border so the panel doesn't pretend to be a temperature.
        setStyle(goEl, "color", "var(--fg-bright)");
        setStyle(goEl, "borderColor", "var(--accent-3)");
      } else {
        setText(goEl, "—");
        setStyle(goEl, "color", "var(--dim)");
        setStyle(goEl, "borderColor", "var(--dim-2)");
      }
      renderSpark(document.getElementById("gpu-spark"), hist.gpu.arr(), 100, frame);
      for (const name of engineNames) {
        const key = gpuEngineKey(name);
        const v = gpu.engines[name] || 0;
        setBar(document.getElementById(`gpu-eng-fill-${key}`), v);
        const pe = document.getElementById(`gpu-eng-pct-${key}`);
        setText(pe, v.toFixed(0) + "%");
        setStyle(pe, "color", colorFor(v));
      }
    } else if (gpu && !gpu.available && !gpuHalf.hidden) {
      gpuHalf.hidden = true;
    }

    // ── Memory ──
    const mPct = memSm.pct;
    const memEl = document.getElementById("mem-pct");
    setText(memEl, mPct.toFixed(0) + "%");
    setStyle(memEl, "color", colorFor(mPct));

    setText(document.getElementById("mem-meta"),
      fmtBytes(s.mem.used) + " / " + fmtBytes(s.mem.total));
    setText(document.getElementById("ram-usage"),
      fmtBytes(s.mem.used) + " / " + fmtBytes(s.mem.total) + "  ");
    setText(document.getElementById("ram-pct"),
      mPct.toFixed(0) + "%");
    setBar(document.getElementById("ram-fill"), mPct);

    setText(document.getElementById("cached"),  fmtBytes(s.mem.cached));
    setText(document.getElementById("buffers"), fmtBytes(s.mem.buffers));
    setText(document.getElementById("avail"),   fmtBytes(s.mem.available));

    // ── Disks (dynamic — one row per mount + optional LVM thin pool) ──
    const disks = Array.isArray(s.disks) && s.disks.length
      ? s.disks
      : [{ label: "/", total: s.disk.total, used: s.disk.used, percent: s.disk.percent, kind: "fs" }];
    ensureDiskRows(disks);
    disks.forEach((d, i) => {
      // Split into two spans so a narrow viewport can drop the
      // used/total fragment via CSS without a JS layout pass —
      // see `.usage-bytes` rule in style.css (shared with RAM/SWAP).
      setText(document.getElementById(`disk-usage-${i}`),
        fmtBytes(d.used) + " / " + fmtBytes(d.total) + "  ");
      setText(document.getElementById(`disk-pct-${i}`),
        d.percent.toFixed(0) + "%");
      setBar(document.getElementById(`disk-fill-${i}`), d.percent);
    });

    // Swap line + bar in disk panel
    const swapTotal = s.swap.total || 0;
    setText(document.getElementById("swap-usage"),
      fmtBytes(s.swap.used) + " / " + (swapTotal > 0 ? fmtBytes(swapTotal) : "—") + "  ");
    setText(document.getElementById("swap-pct"),
      memSm.swap.toFixed(0) + "%");
    setBar(document.getElementById("swap-fill"), memSm.swap);

    // Disk I/O rates
    setText(document.getElementById("disk-read"),  fmtRate(s.disk.read_rate || 0));
    setText(document.getElementById("disk-write"), fmtRate(s.disk.write_rate || 0));

    // Proc count in disk panel sub
    setText(document.getElementById("proc-count"), s.procs + " procs");

    // ── Net peaks (shown in disk half) ──
    setText(document.getElementById("rx-peak"), fmtRate(peakRx));
    setText(document.getElementById("tx-peak"), fmtRate(peakTx));

    // ── WAN / LAN breakdown — hide blocks entirely when an iface is missing
    // so this works on hosts without a vmbr2-style LAN bridge. ──
    const fmtIface = (name, ip) => (ip ? `${name} · ${ip}` : name);

    const wanBlock = document.getElementById("wan-block");
    const wan = s.net && s.net.wan;
    if (wan && wan.iface) {
      wanBlock.hidden = false;
      setText(document.getElementById("wan-iface"), fmtIface(wan.iface, wan.ip));
      setText(document.getElementById("wan-rx"),    fmtRate(wan.rx || 0));
      setText(document.getElementById("wan-tx"),    fmtRate(wan.tx || 0));
    } else {
      wanBlock.hidden = true;
    }

    const lanBlock = document.getElementById("lan-block");
    const lan = s.net && s.net.lan;
    const lanIfs = (lan && Array.isArray(lan.ifaces)) ? lan.ifaces : [];
    if (lanIfs.length) {
      const ips = (lan && Array.isArray(lan.ips)) ? lan.ips : [];
      lanBlock.hidden = false;
      setText(document.getElementById("lan-iface"),
              lanIfs.map((nm, i) => fmtIface(nm, ips[i])).join(", "));
      setText(document.getElementById("lan-rx"), fmtRate(lan.rx || 0));
      setText(document.getElementById("lan-tx"), fmtRate(lan.tx || 0));
    } else {
      lanBlock.hidden = true;
    }

    // ── PING (server keeps the ring; we just render) ──
    const ping = s.net && s.net.ping;
    if (ping) {
      const scale = ping.gw && ping.gw.scale_ms || 100;
      setText(document.getElementById("ping-meta"), "0–" + scale + " ms");
      renderPingSlot("gw",  ping.gw,  scale);
      renderPingSlot("ext", ping.ext, scale);
    }

    // ── Procs (throttled — heaviest DOM op; frame already advanced
    // at the top of refresh so the modulo check counts every tick). ──
    if (frame % PROC_EVERY === 0) renderProcs(s);

    // ── Container health ──
    renderContainers(s.containers);

    // ── Alternate layouts (gauges, …) — hand off the same smoothed
    // values rendered above so dial numbers match the default panels. ──
    if (typeof window.layoutOnTick === "function") {
      window.layoutOnTick(s, {
        cpuPct:  cpuSm.avg,
        cpuPer:  cpuSm.per,
        memPct:  memSm.pct,
        diskPct: memSm.disk,
      });
    }

    // After every widget's `hidden` state is up to date for this tick,
    // let the column layout re-claim any autohide widget (GPU,
    // containers) whose availability just changed.
    if (typeof window.__kioskReapplyColumns === "function") {
      window.__kioskReapplyColumns();
    }
  } catch (e) {
    showErr("refresh: " + (e && e.message ? e.message : e));
  }
}

function showErr(msg) {
  let el = document.getElementById("__err");
  if (!el) {
    el = document.createElement("div");
    el.id = "__err";
    el.style.cssText = "position:fixed;left:5px;bottom:5px;right:5px;background:#330000;color:#ff7676;font:11px monospace;padding:4px 8px;z-index:9999;border:1px solid #882222;border-radius:3px;white-space:pre-wrap;";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}
window.addEventListener("error", (e) => showErr("JS error: " + e.message + " (" + e.filename + ":" + e.lineno + ")"));

// Re-measure braille dims on resize so the graphs adapt.
window.addEventListener("resize", () => { /* layout reflows; next refresh recomputes */ });

// ── Tick interval control ──────────────────────────────────────────
let _refreshTimer = null;
function armRefresh() {
  if (_refreshTimer != null) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(refresh, TICK_MS);
  const el = document.getElementById("tick-val");
  if (el) el.textContent = TICK_MS + "ms";
}
function adjustTick(deltaMs) {
  let next = TICK_MS + deltaMs;
  // Snap to TICK_STEP_MS grid so a stale 50ms value can't strand us at 150/250/...
  next = Math.round(next / TICK_STEP_MS) * TICK_STEP_MS;
  if (next < MIN_TICK_MS) next = MIN_TICK_MS;
  if (next > MAX_TICK_MS) next = MAX_TICK_MS;
  if (next === TICK_MS) return;
  TICK_MS = next;
  try { localStorage.setItem("kiosk.tickMs", String(TICK_MS)); } catch (e) {}
  armRefresh();
}
const tickDownEl = document.getElementById("tick-down");
const tickUpEl   = document.getElementById("tick-up");
if (tickDownEl) {
  // "−" decreases the displayed ms (= faster polling).
  const f = (e) => { e.stopPropagation(); e.preventDefault(); adjustTick(-TICK_STEP_MS); };
  tickDownEl.addEventListener("click", f);
  tickDownEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  tickDownEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}
if (tickUpEl) {
  // "+" increases the displayed ms (= slower polling).
  const f = (e) => { e.stopPropagation(); e.preventDefault(); adjustTick(+TICK_STEP_MS); };
  tickUpEl.addEventListener("click", f);
  tickUpEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  tickUpEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}

// ── Graph-style chip ──────────────────────────────────────────────
// Tap toggles braille ↔ line. We don't redraw immediately — the next
// refresh() (≤ TICK_MS away) calls renderSpark for every graph and
// the dispatch picks up the new style automatically. The chip label
// reflects the *current* style so the user can tell what they're on.
const GRAPH_LABELS = { braille: "BRAILLE", line: "LINE" };

function applyGraphStyle(name) {
  if (!GRAPH_STYLES.includes(name)) name = "braille";
  currentGraphStyle = name;
  document.documentElement.setAttribute("data-graph-style", name);
  try { localStorage.setItem("kiosk.graphStyle", name); } catch (e) {}
  const valEl = document.getElementById("settings-graph-value");
  if (valEl) valEl.textContent = GRAPH_LABELS[name];
  document.querySelectorAll(".graph-swatch").forEach((el) => {
    el.classList.toggle("selected", el.dataset.graph === name);
  });
}
applyGraphStyle(currentGraphStyle);

// ── Graph-style (line mode) picker modal ──────────────────────────
function buildGraphGrid() {
  const root = document.getElementById("graph-grid");
  if (!root) return;
  root.innerHTML = "";
  for (const name of GRAPH_STYLES) {
    const sw = document.createElement("div");
    sw.className = "graph-swatch theme-swatch";
    sw.dataset.graph = name;
    if (name === currentGraphStyle) sw.classList.add("selected");
    // Tiny preview SVG: braille mode shows a stair pattern of dots,
    // line mode shows a smooth curved path — same visual shorthand
    // the live graphs render at full size.
    const preview = document.createElement("div");
    preview.className = "graph-preview graph-preview-" + name;
    if (name === "braille") {
      preview.textContent = "⠈⠐⠠⢀⡀⠠⠐⠈⠐⠠⢀⡀⠄⠂⠁";
    } else {
      preview.innerHTML = '<svg viewBox="0 0 80 24" preserveAspectRatio="none">' +
        '<path d="M0,18 C10,6 18,4 26,10 S42,22 50,14 64,2 80,8" ' +
        'fill="none" stroke="currentColor" stroke-width="1.4" ' +
        'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    const label = document.createElement("div");
    label.textContent = GRAPH_LABELS[name];
    sw.append(preview, label);
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      applyGraphStyle(name);
      // Stay open — user closes via ← BACK or backdrop tap.
      buildGraphGrid();
    });
    sw.addEventListener("pointerdown", (e) => e.stopPropagation());
    sw.addEventListener("pointerup",   (e) => e.stopPropagation());
    root.appendChild(sw);
  }
}
function openGraphModal() {
  buildGraphGrid();
  const m = document.getElementById("graph-modal");
  if (m) m.classList.add("show");
}
function closeGraphModal() {
  const m = document.getElementById("graph-modal");
  if (m) m.classList.remove("show");
}
const graphModalEl = document.getElementById("graph-modal");
if (graphModalEl) {
  graphModalEl.addEventListener("click", (e) => {
    if (e.target === graphModalEl) closeGraphModal();
  });
  graphModalEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  graphModalEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}

// ── Settings modal ────────────────────────────────────────────────
// Single header chip → modal with three rows. Tapping a row closes
// settings and hands off to the corresponding picker.
function openSettingsModal() {
  const valTheme  = document.getElementById("settings-theme-value");
  const valGraph  = document.getElementById("settings-graph-value");
  const valLayout = document.getElementById("settings-layout-value");
  const valTemp   = document.getElementById("settings-temp-value");
  if (valTheme)  valTheme.textContent  = THEME_LABELS[currentTheme] || "—";
  if (valGraph)  valGraph.textContent  = GRAPH_LABELS[currentGraphStyle] || "—";
  if (valTemp)   valTemp.textContent   = "°" + currentTempUnit;
  if (valLayout && typeof window.__kioskCurrentLayoutLabel === "function") {
    valLayout.textContent = window.__kioskCurrentLayoutLabel() || "—";
  }
  const m = document.getElementById("settings-modal");
  if (m) m.classList.add("show");
}
function closeSettingsModal() {
  const m = document.getElementById("settings-modal");
  if (m) m.classList.remove("show");
}
window.__kioskOpenSettings = openSettingsModal;
window.__kioskCloseSettings = closeSettingsModal;

const settingsModalEl = document.getElementById("settings-modal");
if (settingsModalEl) {
  settingsModalEl.addEventListener("click", (e) => {
    if (e.target === settingsModalEl) closeSettingsModal();
  });
  settingsModalEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  settingsModalEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}
const settingsChipEl = document.getElementById("settings-chip");
if (settingsChipEl) {
  const tap = (e) => { e.stopPropagation(); e.preventDefault(); openSettingsModal(); };
  settingsChipEl.addEventListener("click", tap);
  settingsChipEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  settingsChipEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}

function _wireSettingsBtn(id, opener) {
  const el = document.getElementById(id);
  if (!el) return;
  const tap = (e) => {
    e.stopPropagation();
    e.preventDefault();
    closeSettingsModal();
    opener();
  };
  el.addEventListener("click", tap);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("pointerup",   (e) => e.stopPropagation());
}
_wireSettingsBtn("settings-layout-btn", () => {
  if (typeof window.__kioskOpenLayouts === "function") window.__kioskOpenLayouts();
});
_wireSettingsBtn("settings-graph-btn",  openGraphModal);
_wireSettingsBtn("settings-widgets-btn", () => {
  if (typeof window.__kioskOpenWidgets === "function") window.__kioskOpenWidgets();
});

// THEME row cycles inline instead of opening a modal — selecting it
// advances to the next theme (wrapping at the end) and applies
// immediately, with the current theme name shown in the row's value.
// A modal of swatches doesn't scale as themes are added; inline
// cycling does. The theme picker modal is still reachable via the `t`
// keyboard shortcut for users who want the full grid. The settings
// modal stays open so taps can keep cycling.
function _wireInlineSettingsBtn(id, onTap) {
  const el = document.getElementById(id);
  if (!el) return;
  const tap = (e) => { e.stopPropagation(); e.preventDefault(); onTap(); };
  el.addEventListener("click", tap);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("pointerup",   (e) => e.stopPropagation());
}
_wireInlineSettingsBtn("settings-theme-btn", () => cycleTheme(+1));
// TEMP UNIT row toggles °C ↔ °F inline — applied everywhere on the
// next tick since every temperature renders through fmtTemp().
_wireInlineSettingsBtn("settings-temp-btn", () => cycleTempUnit());

// X close on the settings modal — single tap fully dismisses settings,
// no chained reopen. Background tap still works (existing handler).
const settingsCloseEl = document.getElementById("settings-close");
if (settingsCloseEl) {
  const tap = (e) => { e.stopPropagation(); e.preventDefault(); closeSettingsModal(); };
  settingsCloseEl.addEventListener("click", tap);
  settingsCloseEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  settingsCloseEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}

// Back arrows on each sub-modal — close current modal and reopen the
// settings modal so the user lands back on the menu they came from.
function _wireBackBtn(modalId, closer) {
  const m = document.getElementById(modalId);
  if (!m) return;
  const back = m.querySelector(".modal-back");
  if (!back) return;
  const tap = (e) => {
    e.stopPropagation();
    e.preventDefault();
    closer();
    openSettingsModal();
  };
  back.addEventListener("click", tap);
  back.addEventListener("pointerdown", (e) => e.stopPropagation());
  back.addEventListener("pointerup",   (e) => e.stopPropagation());
}
_wireBackBtn("theme-modal",   closeThemeModal);
_wireBackBtn("graph-modal",   closeGraphModal);
_wireBackBtn("layouts-modal", () => {
  if (typeof window.__kioskCloseLayouts === "function") window.__kioskCloseLayouts();
});
_wireBackBtn("widgets-modal", () => {
  if (typeof window.__kioskCloseWidgets === "function") window.__kioskCloseWidgets();
});

// ══════════════════════════════════════════════════════════════════
// Runtime config: ping targets + container watch list
// ──────────────────────────────────────────────────────────────────
// These live server-side (the pings happen in metrics.py) but are
// edited here. We cache the last-known config, POST edits to
// /api/config, and reconcile from the sanitized config the server
// echoes back (it may drop an invalid host the user typed).
// ══════════════════════════════════════════════════════════════════
let _kioskConfig = {
  ping: { gw: "", ext: "1.1.1.1" },
  containers: { interval_s: 5, max_per_cycle: 8, targets: [] },
};
// Working copy for the containers editor (committed on SAVE).
let _ctrDraft = { interval_s: 5, max_per_cycle: 8, targets: [] };

// Client-side host check — mirrors the server's _valid_host so we can
// flag bad input before the round-trip. IPv4 or DNS-style hostname.
function _validHost(s) {
  s = (s || "").trim();
  if (!s || s.length > 253) return false;
  if (/[\s;|&$`'"\\<>]/.test(s)) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) {
    return s.split(".").every((o) => +o >= 0 && +o <= 255);
  }
  return /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/.test(s);
}

function _modalShow(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add("show");
}
function _modalHide(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove("show");
}

function _applyConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  if (cfg.ping) _kioskConfig.ping = { gw: cfg.ping.gw || "", ext: cfg.ping.ext || "1.1.1.1" };
  if (cfg.containers) {
    _kioskConfig.containers = {
      interval_s: cfg.containers.interval_s || 5,
      max_per_cycle: cfg.containers.max_per_cycle || 8,
      targets: Array.isArray(cfg.containers.targets) ? cfg.containers.targets : [],
    };
  }
}

async function loadKioskConfig() {
  try {
    const r = await fetch("api/config", { cache: "no-store" });
    _applyConfig(await r.json());
  } catch (e) { /* keep defaults; server may be mid-start */ }
}

async function saveKioskConfig(patch) {
  const body = {
    ping: { ..._kioskConfig.ping, ...(patch.ping || {}) },
    containers: { ..._kioskConfig.containers, ...(patch.containers || {}) },
  };
  const r = await fetch("api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  _applyConfig(await r.json());
  return _kioskConfig;
}

// ── Network ping-targets modal ─────────────────────────────────────
function openNetworkModal() {
  document.getElementById("net-gw-input").value  = _kioskConfig.ping.gw || "";
  document.getElementById("net-ext-input").value = _kioskConfig.ping.ext || "";
  const msg = document.getElementById("net-msg");
  if (msg) { msg.textContent = ""; msg.className = "kform-msg"; }
  _modalShow("network-modal");
}
function closeNetworkModal() { _modalHide("network-modal"); }

(function _wireNetworkModal() {
  const save = document.getElementById("net-save");
  if (!save) return;
  const onSave = async (e) => {
    e.stopPropagation(); e.preventDefault();
    const gw  = document.getElementById("net-gw-input").value.trim();
    const ext = document.getElementById("net-ext-input").value.trim();
    const msg = document.getElementById("net-msg");
    if (gw && !_validHost(gw)) { _formMsg(msg, "Invalid gateway host", true); return; }
    if (!_validHost(ext))      { _formMsg(msg, "Invalid external host", true); return; }
    try {
      await saveKioskConfig({ ping: { gw, ext } });
      _formMsg(msg, "Saved ✓", false);
    } catch (err) { _formMsg(msg, "Save failed", true); }
  };
  save.addEventListener("click", onSave);
  save.addEventListener("pointerdown", (e) => e.stopPropagation());
  save.addEventListener("pointerup",   (e) => e.stopPropagation());
  const nm = document.getElementById("network-modal");
  if (nm) {
    nm.addEventListener("click", (e) => { if (e.target === nm) closeNetworkModal(); });
    nm.addEventListener("pointerdown", (e) => e.stopPropagation());
    nm.addEventListener("pointerup",   (e) => e.stopPropagation());
  }
})();

function _formMsg(el, text, isErr) {
  if (!el) return;
  el.textContent = text;
  el.className = "kform-msg" + (isErr ? " err" : " ok");
}

// ── Container health modal ─────────────────────────────────────────
const CTR_IV_MIN = 1, CTR_IV_MAX = 600, CTR_CAP_MIN = 1, CTR_CAP_MAX = 64;

function _ctrSyncSteppers() {
  setText(document.getElementById("ctr-iv-val"), Math.round(_ctrDraft.interval_s) + "s");
  setText(document.getElementById("ctr-cap-val"), String(_ctrDraft.max_per_cycle));
}
function _ctrRenderList() {
  const root = document.getElementById("ctr-edit-list");
  if (!root) return;
  root.innerHTML = "";
  if (_ctrDraft.targets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ctr-edit-empty";
    empty.textContent = "no containers — add one below";
    root.appendChild(empty);
    return;
  }
  _ctrDraft.targets.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "ctr-edit-row";
    const nm = document.createElement("span");
    nm.className = "ctr-edit-name"; nm.textContent = t.name || t.host;
    const host = document.createElement("span");
    host.className = "ctr-edit-host"; host.textContent = t.host;
    const del = document.createElement("button");
    del.className = "ctr-edit-del"; del.textContent = "✕";
    del.setAttribute("aria-label", "Remove " + (t.name || t.host));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      _ctrDraft.targets.splice(i, 1);
      _ctrRenderList();
    });
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("pointerup",   (e) => e.stopPropagation());
    row.append(nm, host, del);
    root.appendChild(row);
  });
}
function openContainersModal() {
  // Deep-copy the live config into the editor draft.
  _ctrDraft = {
    interval_s: _kioskConfig.containers.interval_s || 5,
    max_per_cycle: _kioskConfig.containers.max_per_cycle || 8,
    targets: (_kioskConfig.containers.targets || []).map((t) => ({ name: t.name, host: t.host })),
  };
  const msg = document.getElementById("ctr-msg");
  if (msg) { msg.textContent = ""; msg.className = "kform-msg"; }
  document.getElementById("ctr-add-name").value = "";
  document.getElementById("ctr-add-host").value = "";
  _ctrSyncSteppers();
  _ctrRenderList();
  _modalShow("containers-modal");
}
function closeContainersModal() { _modalHide("containers-modal"); }

(function _wireContainersModal() {
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); fn(); });
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("pointerup",   (e) => e.stopPropagation());
  };
  const clampIv  = (v) => Math.max(CTR_IV_MIN, Math.min(CTR_IV_MAX, v));
  const clampCap = (v) => Math.max(CTR_CAP_MIN, Math.min(CTR_CAP_MAX, v));
  wire("ctr-iv-down",  () => { _ctrDraft.interval_s = clampIv(_ctrDraft.interval_s - 1); _ctrSyncSteppers(); });
  wire("ctr-iv-up",    () => { _ctrDraft.interval_s = clampIv(_ctrDraft.interval_s + 1); _ctrSyncSteppers(); });
  wire("ctr-cap-down", () => { _ctrDraft.max_per_cycle = clampCap(_ctrDraft.max_per_cycle - 1); _ctrSyncSteppers(); });
  wire("ctr-cap-up",   () => { _ctrDraft.max_per_cycle = clampCap(_ctrDraft.max_per_cycle + 1); _ctrSyncSteppers(); });
  const ctrAdd = () => {
    const nameEl = document.getElementById("ctr-add-name");
    const hostEl = document.getElementById("ctr-add-host");
    const host = hostEl.value.trim();
    const name = nameEl.value.trim().slice(0, 32) || host;
    const msg = document.getElementById("ctr-msg");
    if (!_validHost(host)) { _formMsg(msg, "Invalid host / IP", true); hostEl.focus(); return; }
    if (_ctrDraft.targets.some((t) => t.host === host)) { _formMsg(msg, "Host already listed", true); hostEl.focus(); return; }
    if (_ctrDraft.targets.length >= 128) { _formMsg(msg, "Too many containers", true); return; }
    _ctrDraft.targets.push({ name, host });
    nameEl.value = ""; hostEl.value = "";
    if (msg) { msg.textContent = ""; msg.className = "kform-msg"; }
    _ctrRenderList();
    nameEl.focus();  // ready for the next entry
  };
  wire("ctr-add-btn", ctrAdd);
  // Keyboard flow: Enter in NAME jumps to HOST, Enter in HOST adds the
  // row — so a whole list can be typed without reaching for the button.
  const nameInput = document.getElementById("ctr-add-name");
  const hostInput = document.getElementById("ctr-add-host");
  if (nameInput) nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); hostInput && hostInput.focus(); }
  });
  if (hostInput) hostInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); ctrAdd(); }
  });
  wire("ctr-save", async () => {
    const msg = document.getElementById("ctr-msg");
    try {
      await saveKioskConfig({ containers: {
        interval_s: _ctrDraft.interval_s,
        max_per_cycle: _ctrDraft.max_per_cycle,
        targets: _ctrDraft.targets,
      } });
      _formMsg(msg, "Saved ✓", false);
    } catch (err) { _formMsg(msg, "Save failed", true); }
  });
  const cm = document.getElementById("containers-modal");
  if (cm) {
    cm.addEventListener("click", (e) => { if (e.target === cm) closeContainersModal(); });
    cm.addEventListener("pointerdown", (e) => e.stopPropagation());
    cm.addEventListener("pointerup",   (e) => e.stopPropagation());
  }
})();

_wireSettingsBtn("settings-network-btn",    openNetworkModal);
_wireSettingsBtn("settings-containers-btn", openContainersModal);
_wireBackBtn("network-modal",    closeNetworkModal);
_wireBackBtn("containers-modal", closeContainersModal);

// ── Process sort controls ──────────────────────────────────────────
// PID / CPU% / MEM% headers are tappable: first tap selects that
// field (using its natural default direction), repeat taps flip the
// direction. The active header shows a ▲/▼ arrow.
(function _wireProcSort() {
  document.querySelectorAll(".proc-sort").forEach((el) => {
    const tap = (e) => { e.stopPropagation(); e.preventDefault(); setProcSort(el.dataset.sort); };
    el.addEventListener("click", tap);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("pointerup",   (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") tap(e);
    });
  });
  _updateProcSortIndicators();
})();

// Reflect persisted temp unit in the settings row label on load.
setTempUnit(currentTempUnit);

loadKioskConfig();
armRefresh();
refresh();

// ── Theme switching: swipe horizontally OR tap the header chip ─────
const THEMES = ["cyberpunk", "wireframe", "eink", "amber", "matrix", "solarized", "pink", "purple", "midnight"];
const THEME_LABELS = {
  cyberpunk: "CYBERPUNK",
  wireframe: "WIREFRAME",
  eink:      "E-INK",
  amber:     "AMBER",
  matrix:    "MATRIX",
  solarized: "SOLARIZED",
  pink:      "PINK",
  purple:    "PURPLE",
  midnight:  "MIDNIGHT",
};
const THEME_CHIP = {
  cyberpunk: "CPK",
  wireframe: "WIRE",
  eink:      "EINK",
  amber:     "AMBR",
  matrix:    "MTRX",
  solarized: "SOLR",
  pink:      "PINK",
  purple:    "PRPL",
  midnight:  "MDNT",
};
// Swatch palette previews for the picker modal.
const THEME_SWATCH = {
  cyberpunk: ["#07090e", "#6ab0ff", "#9fc8ec", "#7bb89c", "#c9a76e", "#d97676"],
  wireframe: ["#060504", "#ffffff", "#ebe5d6", "#d6d0c2", "#948f80", "#4a463e"],
  eink:      ["#ebe7dc", "#1a1410", "#2a2520", "#5a5550", "#a8a090", "#000000"],
  amber:     ["#1a0f00", "#ffb86b", "#ff9933", "#ffcc77", "#cc6600", "#ff5050"],
  matrix:    ["#000800", "#00ff66", "#33ff99", "#66ffaa", "#aaff66", "#ff5577"],
  solarized: ["#002b36", "#268bd2", "#2aa198", "#859900", "#b58900", "#dc322f"],
  pink:      ["#1a0e18", "#ffb3d1", "#d9b3ff", "#ff80b3", "#ffd9a8", "#ff8a9f"],
  purple:    ["#0a0518", "#a062ff", "#c084ff", "#6a3fb8", "#88e8b8", "#ff6a90"],
  midnight:  ["#04030c", "#c0bbe0", "#8a83b8", "#4a4478", "#d4b87a", "#d47a7a"],
};

let currentTheme = (() => {
  try { return localStorage.getItem("kiosk.theme") || "cyberpunk"; }
  catch (e) { return "cyberpunk"; }
})();

function applyTheme(t, opts) {
  if (!THEMES.includes(t)) t = "cyberpunk";
  currentTheme = t;
  if (t === "cyberpunk") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("kiosk.theme", t); } catch (e) {}
  const valEl = document.getElementById("settings-theme-value");
  if (valEl) valEl.textContent = THEME_LABELS[t];
  // Update modal selection state if present.
  document.querySelectorAll(".theme-swatch[data-theme]").forEach((el) => {
    el.classList.toggle("selected", el.dataset.theme === t);
  });
  if (!opts || !opts.silent) showThemeToast(THEME_LABELS[t]);
}

let _toastTimer = null;
function showThemeToast(text) {
  const el = document.getElementById("theme-toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 1100);
}

function cycleTheme(dir) {
  const i = THEMES.indexOf(currentTheme);
  const j = (i + dir + THEMES.length) % THEMES.length;
  applyTheme(THEMES[j]);
}

// ── Theme picker modal ─────────────────────────────────────────────
function buildThemeGrid() {
  const root = document.getElementById("theme-grid");
  if (!root) return;
  root.innerHTML = "";
  for (const t of THEMES) {
    const sw = document.createElement("div");
    sw.className = "theme-swatch";
    sw.dataset.theme = t;
    if (t === currentTheme) sw.classList.add("selected");
    const palette = THEME_SWATCH[t] || [];
    const row = document.createElement("div");
    row.className = "swatch-row";
    for (const hex of palette) {
      const sp = document.createElement("span");
      sp.style.background = hex;
      row.appendChild(sp);
    }
    const label = document.createElement("div");
    label.textContent = THEME_LABELS[t];
    sw.append(row, label);
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      applyTheme(t);
      // Stay open — user closes via ← BACK or backdrop tap.
      buildThemeGrid();
    });
    sw.addEventListener("pointerdown", (e) => e.stopPropagation());
    sw.addEventListener("pointerup",   (e) => e.stopPropagation());
    root.appendChild(sw);
  }
}
function openThemeModal() {
  buildThemeGrid();
  const m = document.getElementById("theme-modal");
  if (m) m.classList.add("show");
}
function closeThemeModal() {
  const m = document.getElementById("theme-modal");
  if (m) m.classList.remove("show");
}
const themeModalEl = document.getElementById("theme-modal");
if (themeModalEl) {
  themeModalEl.addEventListener("click", (e) => {
    if (e.target === themeModalEl) closeThemeModal();
  });
  themeModalEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  themeModalEl.addEventListener("pointerup",   (e) => e.stopPropagation());
}

// Pointer-based swipe (works for touch + mouse drag in kiosk).
let _swipe = null;
const SWIPE_THRESHOLD = 60;   // px
const SWIPE_MAX_OFF_AXIS = 50; // px

function onPointerDown(e) {
  _swipe = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
}
function onPointerUp(e) {
  if (!_swipe || _swipe.id !== e.pointerId) { _swipe = null; return; }
  const dx = e.clientX - _swipe.x;
  const dy = e.clientY - _swipe.y;
  _swipe = null;
  if (Math.abs(dy) > SWIPE_MAX_OFF_AXIS) return;
  if (Math.abs(dx) < SWIPE_THRESHOLD) return;
  cycleTheme(dx < 0 ? 1 : -1);
}
function onPointerCancel() { _swipe = null; }

window.addEventListener("pointerdown",   onPointerDown);
window.addEventListener("pointerup",     onPointerUp);
window.addEventListener("pointercancel", onPointerCancel);

// Escape still closes the current picker — the unified key router
// in layouts.js handles all other shortcuts so we don't end up with
// two listeners fighting for the same key.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeThemeModal();
    closeGraphModal();
    closeNetworkModal();
    closeContainersModal();
    closeSettingsModal();
  }
});

// Apply persisted theme silently on initial load (no toast).
applyTheme(currentTheme, { silent: true });
