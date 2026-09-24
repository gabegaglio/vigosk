"use strict";

// ══════════════════════════════════════════════════════════════════
// FLEET layout — every paired machine on one screen.
// ──────────────────────────────────────────────────────────────────
// Data: GET api/fleet (this machine + every node the hub knows about),
// polled at 1 Hz and ONLY while this layout is visible, so the other
// layouts pay nothing for it. The first poll after the layout opens
// asks for ?hist=1 to seed the sparklines from the hub's history.
//
// Two views, picked automatically by node count (or pinned by the
// user with the view chip / `V` key):
//   • columns — up to 4 machines side by side. Rows line up across
//     columns (CPU next to CPU, MEM next to MEM) and every graph uses
//     the same 0–100 % scale and time window, so comparing machines is
//     a glance across, not a mental conversion.
//   • ledger  — one dense row per machine, for 5+ nodes.
// A summary strip on top combines the fleet: core-weighted CPU, total
// memory, total throughput, guests, and the single most urgent thing.
//
// Security: every string shown here (hostnames, disk labels, process
// names) comes from another machine. It is only ever written with
// textContent — this file never uses innerHTML — so a compromised
// agent can't inject markup into the kiosk.
// ══════════════════════════════════════════════════════════════════
(function () {
  const POLL_MS = 1000;
  const COLUMNS_MAX = 4;
  const HIST_MAX = 180;
  const VIEWS = ["auto", "columns", "ledger"];
  const VIEW_LABEL = { auto: "AUTO", columns: "COLS", ledger: "LIST" };

  let view = (() => {
    try { const v = localStorage.getItem("kiosk.fleet.view"); if (VIEWS.includes(v)) return v; } catch (e) {}
    return "auto";
  })();

  let timer = null, inflight = false, seeded = false;
  let lastData = null;
  let builtSig = "";
  let detailId = null;
  const hist = new Map();   // node id -> { seq, cpu: [], mem: [] }
  const cols = new Map();   // node id -> column DOM refs
  const rows = new Map();   // node id -> ledger row DOM refs

  const $ = (id) => document.getElementById(id);
  const isActive = () => document.documentElement.getAttribute("data-layout") === "fleet";

  // ── formatting ───────────────────────────────────────────────────
  function fmtBytes(n, d) {
    n = n || 0;
    const u = ["B", "K", "M", "G", "T", "P"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(d != null ? d : (n < 10 ? 1 : 0))) + " " + u[i];
  }
  const fmtRate = (n) => fmtBytes(n) + "/s";
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s || 0));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return s + "s";
  }
  const fmtTemp = (c) => (typeof window.__kioskFmtTemp === "function"
    ? window.__kioskFmtTemp(c, { compact: true, dash: "—" })
    : (c == null ? "—" : Math.round(c) + "°C"));
  function colorFor(p) {
    if (p == null) return "var(--dim)";
    if (p < 50) return "var(--fg-bright)";
    if (p < 75) return "var(--accent-2)";
    if (p < 90) return "var(--warn)";
    return "var(--crit)";
  }
  function tempColor(t) {
    if (t == null) return "var(--dim)";
    if (t < 70) return "var(--fg)";
    if (t < 85) return "var(--warn)";
    return "var(--crit)";
  }

  // ── tiny DOM helpers (textContent only) ─────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setText(e, v) { if (e && e.textContent !== v) e.textContent = v; }
  function setColor(e, c) { if (e && e.style.color !== c) e.style.color = c; }
  function setBar(fill, pct) {
    if (!fill) return;
    const r = (100 - Math.max(0, Math.min(100, pct || 0))) + "%";
    if (fill.style.right !== r) fill.style.right = r;
  }
  function bar() {
    const b = el("div", "bar");
    const f = el("div", "fill");
    b.appendChild(f);
    return { b, f };
  }
  // Taps on fleet elements must not start the global swipe-to-change-theme.
  function tappable(e, fn) {
    e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    e.addEventListener("pointerup", (ev) => ev.stopPropagation());
    e.addEventListener("click", (ev) => { ev.stopPropagation(); ev.preventDefault(); fn(); });
  }

  // ── derived values ───────────────────────────────────────────────
  function worstDisks(m, n) {
    const d = (m && Array.isArray(m.disks)) ? m.disks.slice() : [];
    d.sort((a, b) => (b.pct || 0) - (a.pct || 0));
    return d.slice(0, n);
  }
  function metaLine(n) {
    const s = n.sys || {};
    const parts = [];
    if (s.pve) parts.push("PVE " + s.pve);
    else if (s.os) parts.push(s.os.replace(/\s*\(.*\)\s*$/, "").replace(/ GNU\/Linux/, ""));
    if (s.cpu_model) parts.push(s.cpu_model);
    if (s.cores) parts.push(s.cores + "c");
    return parts.join(" · ");
  }
  function stateText(n) {
    const m = n.m;
    if (n.status === "online") return m && m.up != null ? "up " + fmtDur(m.up) : "online";
    if (n.status === "stale") return "stale · " + fmtDur(n.age);
    if (n.status === "offline") return n.seen ? "offline · " + fmtDur(n.age) + " ago" : "offline";
    return "waiting for agent";
  }
  const live = (n) => n.m && (n.status === "online" || n.status === "stale");

  // ── history ──────────────────────────────────────────────────────
  function ingest(nodes, withHist) {
    const seen = new Set();
    for (const n of nodes) {
      seen.add(n.id);
      let h = hist.get(n.id);
      if (!h || (withHist && n.hist)) {
        h = { seq: n.seq || 0, cpu: [], mem: [] };
        if (n.hist) { h.cpu = n.hist.cpu.slice(-HIST_MAX); h.mem = n.hist.mem.slice(-HIST_MAX); }
        hist.set(n.id, h);
        continue;
      }
      if (n.m && n.seq > h.seq) {
        if (n.seq - h.seq > 3) seeded = false;          // missed a lot (tab hidden) → reseed next poll
        h.cpu.push(n.m.cpu.pct); h.mem.push(n.m.mem.pct);
        if (h.cpu.length > HIST_MAX) { h.cpu.shift(); h.mem.shift(); }
        h.seq = n.seq;
      }
    }
    for (const id of [...hist.keys()]) if (!seen.has(id)) hist.delete(id);
  }

  function spark(elm, data, version) {
    if (!elm || typeof window.__kioskRenderSpark !== "function") return;
    window.__kioskRenderSpark(elm, data && data.length ? data : [0], 100, version);
  }

  // ── summary strip ────────────────────────────────────────────────
  function renderSummary(nodes, hub) {
    let on = 0, cores = 0, busy = 0, memU = 0, memT = 0, rx = 0, tx = 0, ct = 0, vm = 0, pve = false;
    let fullest = null, hottest = null, down = [];
    for (const n of nodes) {
      if (!live(n)) { if (n.status !== "pending") down.push(n.name); continue; }
      on++;
      const m = n.m, c = (n.sys && n.sys.cores) || (m.cpu.per && m.cpu.per.length) || 1;
      cores += c; busy += m.cpu.pct * c / 100;
      memU += m.mem.used || 0; memT += m.mem.total || 0;
      rx += m.net.rx || 0; tx += m.net.tx || 0;
      if (n.guests) { pve = true; ct += n.guests.ct || 0; vm += n.guests.vm || 0; }
      for (const d of (m.disks || [])) if (!fullest || d.pct > fullest.pct) fullest = { ...d, node: n.name };
      if (m.cpu.temp != null && (!hottest || m.cpu.temp > hottest.t)) hottest = { t: m.cpu.temp, node: n.name };
    }
    const nodesEl = $("fl-sum-nodes");
    setText(nodesEl, on + "/" + nodes.length);
    setColor(nodesEl, down.length ? "var(--crit)" : "var(--fg-bright)");
    const cpuPct = cores ? 100 * busy / cores : 0;
    setText($("fl-sum-cpu"), cpuPct.toFixed(0) + "%"); setColor($("fl-sum-cpu"), colorFor(cpuPct));
    setText($("fl-sum-cores"), busy.toFixed(1) + " of " + cores + " cores");
    const memPct = memT ? 100 * memU / memT : 0;
    setText($("fl-sum-mem"), memPct.toFixed(0) + "%"); setColor($("fl-sum-mem"), colorFor(memPct));
    setText($("fl-sum-memb"), fmtBytes(memU) + " / " + fmtBytes(memT));
    setText($("fl-sum-net"), "▼ " + fmtRate(rx) + "  ▲ " + fmtRate(tx));
    const g = $("fl-sum-guests-item");
    if (g) g.hidden = !pve;
    setText($("fl-sum-guests"), ct + " CT" + (vm ? " · " + vm + " VM" : ""));
    // The one thing most worth a look, most urgent first.
    const alertEl = $("fl-sum-alert");
    let txt = "all nominal", col = "var(--dim)";
    if (hub && hub.error) { txt = "hub: " + hub.error; col = "var(--crit)"; }
    else if (down.length) { txt = down.join(", ") + (down.length > 1 ? " are" : " is") + " offline"; col = "var(--crit)"; }
    else if (fullest && fullest.pct >= 85) { txt = fullest.label + " @ " + fullest.node + " " + fullest.pct.toFixed(0) + "%"; col = fullest.pct >= 95 ? "var(--crit)" : "var(--warn)"; }
    else if (hottest && hottest.t >= 80) { txt = hottest.node + " " + fmtTemp(hottest.t); col = hottest.t >= 90 ? "var(--crit)" : "var(--warn)"; }
    else if (fullest) { txt = "fullest " + fullest.label + " @ " + fullest.node + " " + fullest.pct.toFixed(0) + "%"; }
    setText(alertEl, txt); setColor(alertEl, col);
    setText($("fl-view-btn"), VIEW_LABEL[view]);
  }

  // ── columns view ─────────────────────────────────────────────────
  function buildColumn(n) {
    const root = el("section", "fl-node");
    const head = el("header", "fl-head");
    const dot = el("span", "fl-dot");
    const name = el("span", "fl-name", n.name);
    const tag = el("span", "fl-tag", n.role === "hub" ? "HUB" : "");
    tag.hidden = n.role !== "hub";
    const meta = el("span", "fl-meta");
    const state = el("span", "fl-state");
    head.append(dot, name, tag, meta, state);

    const vit = el("div", "fl-vitals");
    const mk = (label, cls) => {
      const v = el("div", "fl-vital");
      const k = el("div", "fl-vk");
      k.append(el("span", null, label));
      const sub = el("span", "fl-vsub");
      k.append(sub);
      const big = el("div", "fl-vbig", "—");
      const sp = el("pre", "braille fl-spark " + cls);
      v.append(k, big, sp);
      vit.appendChild(v);
      return { sub, big, sp };
    };
    const cpu = mk("CPU", "cpu"), mem = mk("MEM", "mem");

    const list = el("div", "fl-rows");
    const disks = [];
    for (let i = 0; i < 2; i++) {
      const r = el("div", "fl-row fl-disk");
      const k = el("span", "fl-k");
      const { b, f } = bar();
      const v = el("span", "fl-v");
      r.append(k, b, v);
      list.appendChild(r);
      disks.push({ r, k, f, v });
    }
    const line = (label, cls) => {
      const r = el("div", "fl-row fl-kv " + cls);
      r.append(el("span", "fl-k", label));
      const v = el("span", "fl-v");
      r.append(v);
      list.appendChild(r);
      return { r, v };
    };
    const net = line("NET", "fl-net"), io = line("DISK I/O", "fl-io"), load = line("LOAD", "fl-load");
    root.append(head, vit, list);
    tappable(root, () => openDetail(n.id));
    return { root, dot, name, meta, state, cpu, mem, disks, net, io, load };
  }

  function updateColumn(c, n) {
    const m = n.m;
    if (c.root.dataset.status !== n.status) c.root.dataset.status = n.status;
    setText(c.name, n.name);
    setText(c.meta, metaLine(n));
    setText(c.state, stateText(n));
    const h = hist.get(n.id) || { cpu: [], mem: [], seq: 0 };
    if (!m) {
      setText(c.cpu.big, "—"); setText(c.mem.big, "—");
      setText(c.cpu.sub, ""); setText(c.mem.sub, "");
      c.disks.forEach((d) => { d.r.hidden = true; });
      setText(c.net.v, "—"); setText(c.io.v, "—"); setText(c.load.v, "—");
      return;
    }
    setText(c.cpu.big, m.cpu.pct.toFixed(0) + "%"); setColor(c.cpu.big, colorFor(m.cpu.pct));
    setText(c.cpu.sub, [m.cpu.temp != null ? fmtTemp(m.cpu.temp) : "", m.cpu.mhz ? (m.cpu.mhz / 1000).toFixed(1) + " GHz" : ""].filter(Boolean).join(" · "));
    setColor(c.cpu.sub, tempColor(m.cpu.temp));
    setText(c.mem.big, m.mem.pct.toFixed(0) + "%"); setColor(c.mem.big, colorFor(m.mem.pct));
    setText(c.mem.sub, fmtBytes(m.mem.used) + " / " + fmtBytes(m.mem.total));
    spark(c.cpu.sp, h.cpu, h.seq);
    spark(c.mem.sp, h.mem, h.seq);
    const wd = worstDisks(m, 2);
    c.disks.forEach((d, i) => {
      const x = wd[i];
      d.r.hidden = !x;
      if (!x) return;
      setText(d.k, x.label);
      d.k.title = x.label + (x.mount ? " (" + x.mount + ")" : "");
      setBar(d.f, x.pct);
      setText(d.v, x.pct.toFixed(0) + "%");
      setColor(d.v, colorFor(x.pct));
    });
    setText(c.net.v, "▼ " + fmtRate(m.net.rx) + "  ▲ " + fmtRate(m.net.tx));
    setText(c.io.v, "R " + fmtRate(m.dio.r) + "  W " + fmtRate(m.dio.w));
    const ld = (m.cpu.load || []).map((x) => (x == null ? "—" : x.toFixed(2))).join(" ");
    const g = n.guests ? "  ·  " + n.guests.ct + " CT" + (n.guests.vm ? " · " + n.guests.vm + " VM" : "") : "";
    setText(c.load.v, ld + g);
  }

  // ── ledger view ──────────────────────────────────────────────────
  function buildRow(n) {
    const r = el("div", "fl-lrow");
    const nm = el("span", "fl-lname");
    const dot = el("span", "fl-dot");
    const name = el("span", "fl-name", n.name);
    nm.append(dot, name);
    if (n.role === "hub") nm.append(el("span", "fl-tag", "HUB"));
    const cell = () => { const c = el("span", "fl-lcell"); const { b, f } = bar(); const v = el("span", "fl-lv"); c.append(b, v); return { c, f, v }; };
    const cpu = cell(), mem = cell(), disk = cell();
    const net = el("span", "fl-lnet"), temp = el("span", "fl-ltemp"), load = el("span", "fl-lload"), state = el("span", "fl-lstate");
    r.append(nm, cpu.c, mem.c, disk.c, net, temp, load, state);
    tappable(r, () => openDetail(n.id));
    return { r, name, cpu, mem, disk, net, temp, load, state };
  }

  function updateRow(x, n) {
    const m = n.m;
    if (x.r.dataset.status !== n.status) x.r.dataset.status = n.status;
    setText(x.name, n.name);
    setText(x.state, stateText(n));
    if (!m) {
      [x.cpu, x.mem, x.disk].forEach((c) => { setBar(c.f, 0); setText(c.v, "—"); });
      setText(x.net, "—"); setText(x.temp, "—"); setText(x.load, "—");
      return;
    }
    const put = (c, pct, label) => { setBar(c.f, pct); setText(c.v, (label ? label + " " : "") + pct.toFixed(0) + "%"); setColor(c.v, colorFor(pct)); };
    put(x.cpu, m.cpu.pct); put(x.mem, m.mem.pct);
    const d = worstDisks(m, 1)[0];
    if (d) put(x.disk, d.pct, d.label); else { setBar(x.disk.f, 0); setText(x.disk.v, "—"); }
    setText(x.net, "▼ " + fmtRate(m.net.rx) + "  ▲ " + fmtRate(m.net.tx));
    setText(x.temp, fmtTemp(m.cpu.temp)); setColor(x.temp, tempColor(m.cpu.temp));
    setText(x.load, m.cpu.load && m.cpu.load[0] != null ? m.cpu.load[0].toFixed(2) : "—");
  }

  // ── main render ──────────────────────────────────────────────────
  function render(d) {
    const nodes = d.nodes || [];
    renderSummary(nodes, d.hub || {});
    const grid = $("fl-grid");
    if (!grid) return;
    const mode = view === "auto" ? (nodes.length <= COLUMNS_MAX ? "columns" : "ledger") : view;
    const sig = mode + "|" + nodes.map((n) => n.id).join(",");
    if (sig !== builtSig) {
      builtSig = sig;
      grid.textContent = "";
      cols.clear(); rows.clear();
      grid.dataset.view = mode;
      if (mode === "columns") {
        grid.style.setProperty("--fl-n", String(Math.min(COLUMNS_MAX, Math.max(1, nodes.length + (nodes.length === 1 ? 1 : 0)))));
        for (const n of nodes) { const c = buildColumn(n); cols.set(n.id, c); grid.appendChild(c.root); }
        if (nodes.length === 1) grid.appendChild($("fl-add-tpl").content.cloneNode(true));
      } else {
        const head = el("div", "fl-lhead");
        ["NODE", "CPU", "MEM", "FULLEST DISK", "NET", "TEMP", "LOAD", "STATE"].forEach((t) => head.appendChild(el("span", null, t)));
        grid.appendChild(head);
        const body = el("div", "fl-lbody");
        for (const n of nodes) { const x = buildRow(n); rows.set(n.id, x); body.appendChild(x.r); }
        grid.appendChild(body);
      }
    }
    for (const n of nodes) {
      if (cols.has(n.id)) updateColumn(cols.get(n.id), n);
      if (rows.has(n.id)) updateRow(rows.get(n.id), n);
    }
    const hint = $("fl-add-hub-state");
    if (hint) setText(hint, d.hub && d.hub.enabled
      ? "hub is listening at " + (d.hub.url || "?")
      : "the hub service isn't running yet — see docs/MULTINODE.md");
    if (detailId) renderDetail();
  }

  // ── node detail modal ────────────────────────────────────────────
  function openDetail(id) {
    detailId = id;
    renderDetail();
    const m = $("fleet-modal");
    if (m) m.classList.add("show");
  }
  function closeDetail() {
    detailId = null;
    const m = $("fleet-modal");
    if (m) m.classList.remove("show");
  }
  window.__kioskCloseFleetDetail = closeDetail;

  function renderDetail() {
    const n = lastData && (lastData.nodes || []).find((x) => x.id === detailId);
    if (!n) { closeDetail(); return; }
    const s = n.sys || {}, m = n.m;
    setText($("flm-title"), n.name.toUpperCase() + (n.role === "hub" ? " · HUB" : ""));
    const sub = [s.os, s.kernel, s.cpu_model && (s.cpu_model + " · " + s.cores + "c"),
      n.addr, s.agent && ("agent " + s.agent), stateText(n)].filter(Boolean).join("  ·  ");
    setText($("flm-sub"), sub);

    const cores = $("flm-cores");
    const per = (m && m.cpu.per) || [];
    if (cores.childElementCount !== per.length) {
      cores.textContent = "";
      per.forEach((_, i) => {
        const r = el("div", "flm-core");
        const { b, f } = bar();
        r.append(el("span", "fl-k", "c" + String(i).padStart(2, "0")), b, el("span", "fl-v"));
        r._f = f;
        cores.appendChild(r);
      });
    }
    per.forEach((v, i) => {
      const r = cores.children[i];
      setBar(r._f, v); setText(r.children[2], v + "%"); setColor(r.children[2], colorFor(v));
    });

    const disks = $("flm-disks");
    disks.textContent = "";
    for (const d of (m && m.disks) || []) {
      const r = el("div", "flm-disk");
      const { b, f } = bar();
      setBar(f, d.pct);
      const v = el("span", "fl-v", fmtBytes(d.used) + " / " + fmtBytes(d.total) + "  " + d.pct.toFixed(0) + "%");
      setColor(v, colorFor(d.pct));
      r.append(el("span", "fl-k", d.label + (d.kind === "thin" ? " (thin)" : "")), b, v);
      disks.appendChild(r);
    }
    if (m && m.mem.swap_total) {
      const r = el("div", "flm-disk");
      const { b, f } = bar();
      const pct = 100 * m.mem.swap_used / m.mem.swap_total;
      setBar(f, pct);
      r.append(el("span", "fl-k", "swap"), b, el("span", "fl-v", fmtBytes(m.mem.swap_used) + " / " + fmtBytes(m.mem.swap_total)));
      disks.appendChild(r);
    }

    const procs = $("flm-procs");
    procs.textContent = "";
    const top = (n.procs && n.procs.top) || [];
    const ph = el("div", "flm-proc flm-proc-head");
    ["PID", "NAME", "CPU%", "MEM%"].forEach((t) => ph.appendChild(el("span", null, t)));
    procs.appendChild(ph);
    for (const p of top) {
      const r = el("div", "flm-proc");
      const c = el("span", null, p.cpu.toFixed(0)); setColor(c, colorFor(Math.min(100, p.cpu)));
      r.append(el("span", null, String(p.pid)), el("span", "flm-pname", p.name), c, el("span", null, p.mem.toFixed(1)));
      procs.appendChild(r);
    }
    if (!top.length) procs.appendChild(el("div", "fl-k", "process list disabled or not sampled yet"));

    const net = $("flm-net");
    net.textContent = "";
    const kv = (k, v) => { const r = el("div", "flm-kv"); r.append(el("span", "fl-k", k), el("span", "fl-v", v)); net.appendChild(r); };
    if (m) {
      kv("NET", "▼ " + fmtRate(m.net.rx) + "   ▲ " + fmtRate(m.net.tx));
      kv("IFACES", (m.net.ifaces || []).join(", ") || "—");
      kv("DISK I/O", "R " + fmtRate(m.dio.r) + "   W " + fmtRate(m.dio.w));
      kv("LOAD", (m.cpu.load || []).map((x) => (x == null ? "—" : x.toFixed(2))).join("  "));
      kv("IOWAIT", m.cpu.iow != null ? m.cpu.iow.toFixed(1) + "%" : "—");
      kv("TEMP", fmtTemp(m.cpu.temp));
      kv("UPTIME", m.up != null ? fmtDur(m.up) : "—");
      if (n.guests) kv("GUESTS", n.guests.ct + " containers · " + n.guests.vm + " VMs running");
      if (n.procs) kv("PROCS", String(n.procs.n));
    } else {
      kv("STATUS", stateText(n));
    }
  }

  // ── polling ──────────────────────────────────────────────────────
  async function poll() {
    if (!isActive()) { seeded = false; return; }
    if (inflight || document.hidden) return;
    inflight = true;
    try {
      const r = await fetch("api/fleet" + (seeded ? "" : "?hist=1"), { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) { setText($("fl-sum-alert"), d.error || ("fleet API " + r.status)); setColor($("fl-sum-alert"), "var(--crit)"); return; }
      const withHist = !seeded;
      seeded = true;                  // ingest() may flip this back to force a reseed
      ingest(d.nodes || [], withHist);
      lastData = d;
      render(d);
    } catch (e) {
      setText($("fl-sum-alert"), "dashboard server unreachable");
      setColor($("fl-sum-alert"), "var(--crit)");
    } finally {
      inflight = false;
    }
  }

  function syncActive() {
    if (isActive()) {
      if (!timer) { timer = setInterval(poll, POLL_MS); poll(); }
    } else if (timer) {
      clearInterval(timer); timer = null; seeded = false;
      closeDetail();
    }
  }

  function cycleView() {
    view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
    try { localStorage.setItem("kiosk.fleet.view", view); } catch (e) {}
    builtSig = "";
    if (lastData) render(lastData);
    setText($("fl-view-btn"), VIEW_LABEL[view]);
  }
  window.__kioskFleetCycleView = cycleView;

  // ── wiring ───────────────────────────────────────────────────────
  const vb = $("fl-view-btn");
  if (vb) tappable(vb, cycleView);
  const modal = $("fleet-modal");
  if (modal) {
    modal.addEventListener("click", (e) => { if (e.target === modal) closeDetail(); });
    modal.addEventListener("pointerdown", (e) => e.stopPropagation());
    modal.addEventListener("pointerup", (e) => e.stopPropagation());
    const back = modal.querySelector(".modal-back");
    if (back) tappable(back, closeDetail);
  }
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && detailId) closeDetail(); });
  new MutationObserver(syncActive).observe(document.documentElement, { attributes: true, attributeFilter: ["data-layout"] });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isActive()) poll(); });
  syncActive();
})();
