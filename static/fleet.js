"use strict";

// ══════════════════════════════════════════════════════════════════
// FLEET + HUB · FLEET layouts — every paired machine on one screen.
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
// HUB · FLEET (key 9) puts the same machines on the hub clock screen:
// the clock stays on the left and each machine becomes a card on the
// right. The card grid re-picks its rows × columns whenever a machine
// is added or the screen size changes, so everything always fits, and
// each card sheds detail (graph → rows → big numbers) as it gets
// smaller. The FLEET list view shrinks its rows the same way and flows
// into extra columns once rows would get too small to read.
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
  const cards = new Map();  // node id -> HUB · FLEET card DOM refs
  let cardSig = "";

  const $ = (id) => document.getElementById(id);
  const FLEET_LAYOUTS = ["fleet", "hubfleet"];
  const activeLayout = () => {
    const l = document.documentElement.getAttribute("data-layout");
    return FLEET_LAYOUTS.includes(l) ? l : null;
  };
  const isActive = () => !!activeLayout();

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
  // Fleet-wide totals, shared by both layouts. CPU is weighted by core
  // count (a busy 4-core Pi shouldn't outweigh an idle 32-core server).
  function aggregate(nodes) {
    const a = { on: 0, total: nodes.length, down: [], cores: 0, busy: 0, memU: 0, memT: 0,
                rx: 0, tx: 0, ct: 0, vm: 0, pve: false, fullest: null, hottest: null };
    for (const n of nodes) {
      if (!live(n)) { if (n.status !== "pending") a.down.push(n.name); continue; }
      a.on++;
      const m = n.m, c = (n.sys && n.sys.cores) || (m.cpu.per && m.cpu.per.length) || 1;
      a.cores += c; a.busy += m.cpu.pct * c / 100;
      a.memU += m.mem.used || 0; a.memT += m.mem.total || 0;
      a.rx += m.net.rx || 0; a.tx += m.net.tx || 0;
      if (n.guests) { a.pve = true; a.ct += n.guests.ct || 0; a.vm += n.guests.vm || 0; }
      for (const d of (m.disks || [])) if (!a.fullest || d.pct > a.fullest.pct) a.fullest = { ...d, node: n.name };
      if (m.cpu.temp != null && (!a.hottest || m.cpu.temp > a.hottest.t)) a.hottest = { t: m.cpu.temp, node: n.name };
    }
    a.cpuPct = a.cores ? 100 * a.busy / a.cores : 0;
    a.memPct = a.memT ? 100 * a.memU / a.memT : 0;
    return a;
  }
  // The one thing most worth a look, most urgent first.
  function alertOf(a, hub) {
    const f = a.fullest, h = a.hottest;
    if (hub && hub.error) return { txt: "hub: " + hub.error, col: "var(--crit)", urgent: true };
    if (a.down.length) return { txt: a.down.join(", ") + (a.down.length > 1 ? " are" : " is") + " offline", col: "var(--crit)", urgent: true };
    if (f && f.pct >= 85) return { txt: f.label + " @ " + f.node + " " + f.pct.toFixed(0) + "%", col: f.pct >= 95 ? "var(--crit)" : "var(--warn)", urgent: true };
    if (h && h.t >= 80) return { txt: h.node + " " + fmtTemp(h.t), col: h.t >= 90 ? "var(--crit)" : "var(--warn)", urgent: true };
    if (f) return { txt: "fullest " + f.label + " @ " + f.node + " " + f.pct.toFixed(0) + "%", col: "var(--dim)", urgent: false };
    return { txt: "all nominal", col: "var(--dim)", urgent: false };
  }

  function renderSummary(nodes, hub) {
    const a = aggregate(nodes);
    const nodesEl = $("fl-sum-nodes");
    setText(nodesEl, a.on + "/" + a.total);
    setColor(nodesEl, a.down.length ? "var(--crit)" : "var(--fg-bright)");
    setText($("fl-sum-cpu"), a.cpuPct.toFixed(0) + "%"); setColor($("fl-sum-cpu"), colorFor(a.cpuPct));
    setText($("fl-sum-cores"), a.busy.toFixed(1) + " of " + a.cores + " cores");
    setText($("fl-sum-mem"), a.memPct.toFixed(0) + "%"); setColor($("fl-sum-mem"), colorFor(a.memPct));
    setText($("fl-sum-memb"), fmtBytes(a.memU) + " / " + fmtBytes(a.memT));
    setText($("fl-sum-net"), "▼ " + fmtRate(a.rx) + "  ▲ " + fmtRate(a.tx));
    const g = $("fl-sum-guests-item");
    if (g) g.hidden = !a.pve;
    setText($("fl-sum-guests"), a.ct + " CT" + (a.vm ? " · " + a.vm + " VM" : ""));
    const al = alertOf(a, hub);
    setText($("fl-sum-alert"), al.txt); setColor($("fl-sum-alert"), al.col);
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

  // Ledger auto-fit: every machine stays on screen. Rows shrink from
  // 30 px toward 15 px as machines are added; past that the list flows
  // into 2–4 side-by-side columns (each with its own header), and the
  // narrower columns drop the less important cells (see fleet.css).
  const LEDGER_HEAD = ["NODE", "CPU", "MEM", "FULLEST DISK", "NET", "TEMP", "LOAD", "STATE"];
  function fitLedger() {
    const body = document.querySelector("#fl-grid .fl-lbody");
    if (!body || !rows.size) return;
    const H = body.clientHeight;
    if (!H) return;
    const n = rows.size, HEAD = 18, MIN = 15, MAX = 30;
    let c = 1;
    while (c < 4 && (H - HEAD) / Math.ceil(n / c) < MIN) c++;
    const per = Math.ceil(n / c);
    const rowH = Math.max(11, Math.min(MAX, Math.floor((H - HEAD) / per)));
    body.style.setProperty("--fl-row-h", rowH + "px");
    const layoutSig = c + "x" + per;
    if (body.dataset.fit !== layoutSig) {
      body.dataset.fit = layoutSig;
      body.dataset.cols = String(c);
      body.style.gridTemplateColumns = "repeat(" + c + ", minmax(0, 1fr))";
      body.style.gridTemplateRows = HEAD + "px repeat(" + per + ", var(--fl-row-h))";
      body.textContent = "";
      const list = [...rows.values()];
      for (let k = 0; k < c; k++) {
        const head = el("div", "fl-lhead");
        LEDGER_HEAD.forEach((t) => head.appendChild(el("span", null, t)));
        body.appendChild(head);
        list.slice(k * per, (k + 1) * per).forEach((x) => body.appendChild(x.r));
        // pad short last column so the next header lands at the top
        for (let pad = list.slice(k * per, (k + 1) * per).length; pad < per && k < c - 1; pad++) body.appendChild(el("div"));
      }
    }
  }

  // ── HUB · FLEET: one card per machine beside the clock ──────────
  function buildCard(n) {
    const root = el("section", "hf-card");
    const head = el("div", "hf-card-head");
    const dot = el("span", "fl-dot");
    const name = el("span", "hf-name", n.name);
    head.append(dot, name);
    if (n.role === "hub") head.append(el("span", "fl-tag", "HUB"));
    const state = el("span", "hf-state");
    head.append(state);
    const vit = el("div", "hf-vitals");
    const vital = (label) => {
      const v = el("div", "hf-vital");
      const k = el("span", "hf-k", label);
      const big = el("span", "hf-big", "—");
      const { b, f } = bar();
      v.append(k, big, b);
      vit.appendChild(v);
      return { big, f };
    };
    const cpu = vital("CPU"), mem = vital("MEM");
    const sp = el("pre", "braille cpu hf-spark");
    const rowsEl = el("div", "hf-rows");
    const disk = el("div", "hf-row hf-disk");
    const dk = el("span", "hf-rk"), db = bar(), dv = el("span", "hf-rv");
    disk.append(dk, db.b, dv);
    const info = el("div", "hf-row hf-info");
    const net = el("span", "hf-net"), temp = el("span", "hf-temp");
    info.append(net, temp);
    rowsEl.append(disk, info);
    // Compact line for small cards: "14% · 48%" (CPU · MEM).
    const mini = el("div", "hf-mini");
    const mc = el("span", null, "—"), mm = el("span", null, "—");
    mini.append(el("span", "hf-k", "CPU"), mc, el("span", "hf-k", "MEM"), mm);
    const off = el("div", "hf-off");
    root.append(head, off, vit, sp, rowsEl, mini);
    tappable(root, () => openDetail(n.id));
    return { root, name, state, off, cpu, mem, sp, disk, dk, df: db.f, dv, net, temp, mc, mm };
  }

  function updateCard(c, n) {
    const m = n.m;
    if (c.root.dataset.status !== n.status) c.root.dataset.status = n.status;
    setText(c.name, n.name);
    setText(c.state, stateText(n));
    setText(c.off, n.status === "offline"
      ? (n.seen ? "OFFLINE · " + fmtDur(n.age) : "OFFLINE")
      : (n.status === "pending" ? "WAITING FOR AGENT" : ""));
    if (!m) {
      [c.cpu, c.mem].forEach((v) => { setText(v.big, "—"); setBar(v.f, 0); });
      setText(c.mc, "—"); setText(c.mm, "—");
      c.disk.hidden = true;
      setText(c.net, ""); setText(c.temp, "");
      return;
    }
    const put = (v, pct) => { setText(v.big, pct.toFixed(0) + "%"); setColor(v.big, colorFor(pct)); setBar(v.f, pct); };
    put(c.cpu, m.cpu.pct); put(c.mem, m.mem.pct);
    setText(c.mc, m.cpu.pct.toFixed(0) + "%"); setColor(c.mc, colorFor(m.cpu.pct));
    setText(c.mm, m.mem.pct.toFixed(0) + "%"); setColor(c.mm, colorFor(m.mem.pct));
    const h = hist.get(n.id);
    if (h && c.sp.offsetParent !== null) spark(c.sp, h.cpu, h.seq);   // skip hidden (small-card) graphs
    const d = worstDisks(m, 1)[0];
    c.disk.hidden = !d;
    if (d) {
      setText(c.dk, d.label); c.dk.title = d.label + (d.mount ? " (" + d.mount + ")" : "");
      setBar(c.df, d.pct); setText(c.dv, d.pct.toFixed(0) + "%"); setColor(c.dv, colorFor(d.pct));
    }
    setText(c.net, "▼ " + fmtRate(m.net.rx) + "  ▲ " + fmtRate(m.net.tx));
    setText(c.temp, m.cpu.temp != null ? fmtTemp(m.cpu.temp) : "");
    setColor(c.temp, tempColor(m.cpu.temp));
  }

  function ghostCard() {
    const g = el("section", "hf-card hf-ghost");
    g.append(el("div", "hf-ghost-title", "+ ADD A MACHINE"),
             el("div", "hf-ghost-cmd", "sudo vigosk node add <name>"),
             el("div", "hf-ghost-sub", "then paste the printed command on it"));
    return g;
  }

  // Pick rows × columns so the cards are as large as possible while
  // keeping a ~3:2 shape, for whatever space the clock leaves. Runs on
  // every add/remove and on resize, so a new machine simply re-tiles.
  function fitCards() {
    const root = $("hf-cards");
    if (!root) return;
    const n = root.childElementCount;
    const W = root.clientWidth, H = root.clientHeight;
    if (!n || !W || !H) return;
    const gap = n > 12 ? 5 : n > 6 ? 7 : n > 2 ? 10 : 14;
    let best = null;
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const cw = (W - (c - 1) * gap) / c, ch = (H - (r - 1) * gap) / r;
      // Prefer grids without holes: near-equal fits go to the one with
      // fewer empty cells (3 machines → 3×1, not 2×2 with a gap).
      const score = Math.min(cw, ch * 1.5) * (1 - 0.15 * (c * r - n) / (c * r));
      if (!best || score > best.score + 0.5) best = { c, r, score };
    }
    const sig = best.c + "x" + best.r + "@" + gap;
    if (root.dataset.fit !== sig) {
      root.dataset.fit = sig;
      root.style.gridTemplateColumns = "repeat(" + best.c + ", minmax(0, 1fr))";
      root.style.gridTemplateRows = "repeat(" + best.r + ", minmax(0, 1fr))";
      root.style.gap = gap + "px";
    }
  }

  function renderHubFleet(d) {
    const nodes = d.nodes || [];
    const root = $("hf-cards");
    if (!root) return;
    const ghost = nodes.length <= 1;
    const sig = nodes.map((n) => n.id).join(",") + (ghost ? "|+" : "");
    if (sig !== cardSig) {
      cardSig = sig;
      root.textContent = "";
      cards.clear();
      for (const n of nodes) { const c = buildCard(n); cards.set(n.id, c); root.appendChild(c.root); }
      if (ghost) root.appendChild(ghostCard());
      // More machines → the clock column gives up width to the cards.
      const lay = $("layout-hubfleet");
      if (lay) lay.dataset.density = nodes.length <= 2 ? "roomy" : nodes.length <= 4 ? "normal"
        : nodes.length <= 9 ? "dense" : "tight";
      requestAnimationFrame(fitCards);
    }
    for (const n of nodes) if (cards.has(n.id)) updateCard(cards.get(n.id), n);
    // Fleet summary under the date.
    const a = aggregate(nodes);
    const on = $("hf-f-online");
    setText(on, a.on + "/" + a.total + " online");
    setColor(on, a.down.length ? "var(--crit)" : "var(--fg)");
    const dot = $("hf-f-dot");
    if (dot) dot.parentElement.dataset.status = a.down.length ? "offline" : "online";
    setText($("hf-f-cpu"), a.cpuPct.toFixed(0) + "%"); setColor($("hf-f-cpu"), colorFor(a.cpuPct));
    setText($("hf-f-mem"), a.memPct.toFixed(0) + "%"); setColor($("hf-f-mem"), colorFor(a.memPct));
    const al = alertOf(a, d.hub || {});
    const alEl = $("hf-f-alert");
    setText(alEl, al.urgent ? al.txt : "");
    setColor(alEl, al.col);
  }

  // ── main render ──────────────────────────────────────────────────
  function render(d) {
    if (activeLayout() === "hubfleet") renderHubFleet(d);
    else renderFleet(d);
    if (detailId) renderDetail();
  }

  function renderFleet(d) {
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
        const body = el("div", "fl-lbody");
        body.dataset.cols = "0";                      // fitLedger() lays it out
        for (const n of nodes) { const x = buildRow(n); rows.set(n.id, x); }
        grid.appendChild(body);
      }
    }
    if (mode === "ledger") fitLedger();
    for (const n of nodes) {
      if (cols.has(n.id)) updateColumn(cols.get(n.id), n);
      if (rows.has(n.id)) updateRow(rows.get(n.id), n);
    }
    const hint = $("fl-add-hub-state");
    if (hint) setText(hint, d.hub && d.hub.enabled
      ? "hub is listening at " + (d.hub.url || "?")
      : "the hub service isn't running yet — see docs/MULTINODE.md");
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
      else if (lastData) render(lastData);            // fleet ⇄ hub·fleet swap
      requestAnimationFrame(() => { fitCards(); fitLedger(); });
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
  // Re-fit whenever the available space changes (window resize, the
  // clock column narrowing, a phone rotating).
  if (typeof ResizeObserver === "function") {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { fitCards(); fitLedger(); });
    });
    ["hf-cards", "fl-grid"].forEach((id) => { const e = $(id); if (e) ro.observe(e); });
  }
  new MutationObserver(syncActive).observe(document.documentElement, { attributes: true, attributeFilter: ["data-layout"] });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isActive()) poll(); });
  syncActive();
})();
