/* =========================================
   Multi-Tasking OS Demo — Iteration 2 (v2)
   ========================================= */

/* ---------- Theme ---------- */
function getPreferredTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) {
    const isDark = theme === "dark";
    btn.setAttribute("aria-pressed", String(isDark));
    btn.textContent = isDark ? "☀️ Light" : "🌙 Dark";
  }
}

/* ---------- Navigation highlight ---------- */
function setupNavHighlight() {
  const links = Array.from(document.querySelectorAll(".navlink"));
  const sections = links.map(a => document.querySelector(a.getAttribute("href"))).filter(Boolean);

  const obs = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting).sort((a,b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    links.forEach(l => l.classList.remove("is-active"));
    const active = links.find(l => l.getAttribute("href") === "#" + visible.target.id);
    if (active) active.classList.add("is-active");
  }, { threshold: [0.2, 0.35, 0.5, 0.75] });

  sections.forEach(sec => obs.observe(sec));
}

/* ---------- Utilities ---------- */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/* ---------- Color palette (deterministic by label) ---------- */
const COLOR_PALETTE = [
  "#7c9dff", "#10b981", "#f59e0b", "#ef4444", "#a855f7",
  "#22c55e", "#06b6d4", "#e879f9", "#fb7185", "#f97316",
];

function colorForLabel(label) {
  // basic deterministic hash
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
}

/* ---------- Workload parsing ---------- */
function parseBurstString(s) {
  const raw = String(s ?? "").trim();
  if (!raw) return { ok: false, error: "Burst sequence is empty." };

  const tokens = raw.split(/\s+/);
  const bursts = [];

  for (const tok of tokens) {
    if (tok.toUpperCase() === "YIELD") {
      bursts.push({ type: "yield", dur: 0 });
      continue;
    }

    const m = tok.match(/^(CPU|IO)(\d+)$/i);
    if (!m) {
      return { ok: false, error: `Invalid token "${tok}". Use CPU<s>, IO<s>, or YIELD.` };
    }
    const type = m[1].toLowerCase() === "cpu" ? "cpu" : "io";
    const dur = Number(m[2]);
    if (!Number.isFinite(dur) || dur <= 0) return { ok: false, error: `Invalid duration in "${tok}".` };
    bursts.push({ type, dur });
  }

  // Must start with CPU (ignore any yield tokens)
  const firstReal = bursts.find(b => b.type !== "yield");
  if (!firstReal || firstReal.type !== "cpu") {
    return { ok: false, error: "A process must start with a CPU burst (e.g., CPU10 ...)." };
  }

  return { ok: true, bursts };
}

function getReportDefaultWorkload() {
  return [
    { id: "PA", label: "P_A", arrival: 0, priority: 1, burstStr: "CPU80" },
    { id: "PB", label: "P_B", arrival: 0, priority: 1, burstStr: "CPU10 IO40 CPU10" },
    { id: "PC1", label: "P_C", arrival: 0, priority: 2, burstStr: "CPU5" },
    { id: "PC2", label: "P_C", arrival: 60, priority: 2, burstStr: "CPU5" },
  ];
}

/* ---------- Scheduler engine ---------- */
/**
 * Policies:
 * - fcfs: choose earliest enqueued (ready queue)
 * - sjf: choose smallest next CPU burst remaining
 * - priority: choose highest priority (larger number = higher priority)
 * - rr: FIFO queue order, with time-slicing (preemptive) or yield-interval (cooperative)
 *
 * Modes:
 * - none: non-preemptive (switch only on block/yield/finish)
 * - coop: cooperative (switch on block/yield/finish, + optional voluntary yield interval)
 * - preemptive: timer quantum preemption
 */
class Proc {
  constructor({ id, label, arrival, priority, bursts, color, order }) {
    this.id = id;
    this.label = label;
    this.arrival = arrival;
    this.priority = priority;
    this.bursts = bursts.map(b => ({ ...b }));
    this.color = color;
    this.order = order;

    this.idx = 0;
    this.remaining = this.bursts[0]?.dur ?? 0;

    this.state = "new"; // new|ready|running|blocked|done
    this.core = null;

    this.sliceRemaining = Infinity; // for preemptive quantum or cooperative yield interval
    this.firstRun = null;
    this.finishTime = null;
  }

  currentBurst() {
    return this.bursts[this.idx] ?? null;
  }
}

class SchedulerEngine {
  constructor({ workload, cores, policy, mode, quantum, coopYield, priorityPreempt }) {
    this.cores = cores;
    this.policy = policy;
    this.mode = mode;
    this.quantum = quantum;
    this.coopYield = coopYield;
    this.priorityPreempt = priorityPreempt;

    this.t = 0;
    this.done = false;

    // Build procs
    this.procs = workload.map((w, i) => new Proc({
      id: w.id,
      label: w.label,
      arrival: w.arrival,
      priority: w.priority,
      bursts: w.bursts,
      color: w.color,
      order: i
    }));

    this.notArrived = this.procs.slice().sort((a,b) => (a.arrival - b.arrival) || (a.order - b.order));
    this.ready = [];     // enqueue order
    this.blocked = new Set();
    this.running = Array.from({ length: this.cores }, () => null);

    // For segments / log
    this.segmentsByCore = Array.from({ length: this.cores }, () => []);
    this.currentSeg = Array.from({ length: this.cores }, () => null);
    this.nextStartReason = Array.from({ length: this.cores }, () => "Initial dispatch");

    // Metrics tracking
    this.busyMsByCore = Array.from({ length: this.cores }, () => 0);
  }

  snapshot() {
    return {
      t: this.t,
      cores: this.cores,
      policy: this.policy,
      mode: this.mode,
      quantum: this.quantum,
      coopYield: this.coopYield,
      procs: this.procs.map(p => ({
        id: p.id, label: p.label, arrival: p.arrival, priority: p.priority,
        state: p.state, remaining: p.remaining, idx: p.idx, core: p.core, color: p.color
      })),
      ready: this.ready.map(p => p.id),
      running: this.running.map(p => p ? p.id : null),
      blocked: Array.from(this.blocked).map(p => ({ id: p.id, remaining: p.remaining })),
      done: this.procs.filter(p => p.state === "done").map(p => p.id),
    };
  }

  _enqueue(proc) {
    proc.state = "ready";
    proc.core = null;
    this.ready.push(proc);
  }

  _dequeueNext() {
    if (this.ready.length === 0) return null;

    if (this.policy === "fcfs" || this.policy === "rr") {
      return this.ready.shift();
    }

    if (this.policy === "priority") {
      // Highest priority first; FIFO tie-breaker by queue order.
      let bestIdx = 0;
      for (let i = 1; i < this.ready.length; i++) {
        const a = this.ready[i];
        const b = this.ready[bestIdx];
        if (a.priority > b.priority) bestIdx = i;
      }
      return this.ready.splice(bestIdx, 1)[0];
    }

    if (this.policy === "sjf") {
      let bestIdx = -1;
      let bestCpu = Infinity;
      for (let i = 0; i < this.ready.length; i++) {
        const p = this.ready[i];
        const b = p.currentBurst();
        if (!b || b.type !== "cpu") continue;
        if (p.remaining < bestCpu) {
          bestCpu = p.remaining;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) return this.ready.shift();
      return this.ready.splice(bestIdx, 1)[0];
    }

    return this.ready.shift();
  }

  _highestReadyPriority() {
    let maxP = -Infinity;
    for (const p of this.ready) maxP = Math.max(maxP, p.priority);
    return maxP;
  }

  _lowestRunningPriorityCore() {
    let worstCore = -1;
    let lowest = Infinity;
    for (let c = 0; c < this.cores; c++) {
      const p = this.running[c];
      if (!p) continue;
      if (p.priority < lowest) {
        lowest = p.priority;
        worstCore = c;
      }
    }
    return { worstCore, lowest };
  }

  _closeSegment(coreIdx, t) {
    const seg = this.currentSeg[coreIdx];
    if (seg && seg.start !== t) {
      seg.end = t;
      this.segmentsByCore[coreIdx].push(seg);
    }
    this.currentSeg[coreIdx] = null;
  }

  _startOrExtendSegment(coreIdx, label, t, reason) {
    const seg = this.currentSeg[coreIdx];
    if (!seg || seg.label !== label) {
      this._closeSegment(coreIdx, t);
      this.currentSeg[coreIdx] = { core: coreIdx, start: t, end: null, label, reason: reason || "Dispatched" };
    }
  }

  _setSlice(proc) {
    if (this.mode === "preemptive") {
      proc.sliceRemaining = this.quantum;
    } else if (this.mode === "coop") {
      proc.sliceRemaining = (this.coopYield > 0) ? this.coopYield : Infinity;
    } else {
      proc.sliceRemaining = Infinity;
    }
  }

  _dispatch(coreIdx, proc) {
    proc.state = "running";
    proc.core = coreIdx;
    if (proc.firstRun === null) proc.firstRun = this.t;
    this._setSlice(proc);
    this.running[coreIdx] = proc;
  }

  _preemptToReady(coreIdx, reason) {
    const proc = this.running[coreIdx];
    if (!proc) return;
    this.running[coreIdx] = null;
    proc.state = "ready";
    proc.core = null;
    this._enqueue(proc);
    this.nextStartReason[coreIdx] = reason;
  }

  _advanceAfterCpuEnd(coreIdx, proc, reasonForNextCore) {
    // Move proc to next burst or done
    proc.idx += 1;

    // If next bursts include YIELD tokens, treat as immediate voluntary yields.
    while (proc.idx < proc.bursts.length && proc.bursts[proc.idx].type === "yield") {
      proc.idx += 1;
      proc.state = "ready";
      proc.core = null;
      if (proc.idx < proc.bursts.length) proc.remaining = proc.bursts[proc.idx].dur;
      this._enqueue(proc);
      this.nextStartReason[coreIdx] = "Voluntary yield (YIELD token)";
      return;
    }

    const next = proc.currentBurst();
    if (!next) {
      proc.state = "done";
      proc.finishTime = this.t + 1;
      proc.core = null;
      this.nextStartReason[coreIdx] = reasonForNextCore;
      return;
    }

    proc.remaining = next.dur;

    if (next.type === "io") {
      proc.state = "blocked";
      proc.core = null;
      this.blocked.add(proc);
      this.nextStartReason[coreIdx] = reasonForNextCore;
      return;
    }

    // next is CPU
    proc.state = "ready";
    proc.core = null;
    this._enqueue(proc);
    this.nextStartReason[coreIdx] = reasonForNextCore;
  }


  // Prepare the system state at the current time boundary:
  // - admit arrivals at time t
  // - apply optional priority preemption
  // - dispatch to any idle cores (or extend IDLE)
  //
  // This is used by the UI so that after each tick, the "Running" queue is immediately populated
  // for the next tick (so the animation feels responsive at every displayed time).
  settle() {
    if (this.done) return;

    // Admit arrivals at time t (boundary event)
    while (this.notArrived.length > 0 && this.notArrived[0].arrival === this.t) {
      const p = this.notArrived.shift();
      // skip yield tokens at start
      while (p.currentBurst() && p.currentBurst().type === "yield") p.idx += 1;
      p.remaining = p.currentBurst()?.dur ?? 0;
      this._enqueue(p);
    }

    // Priority preemption (preemptive + enabled)
    if (this.mode === "preemptive" && this.priorityPreempt && this.ready.length > 0) {
      const highest = this._highestReadyPriority();
      const { worstCore, lowest } = this._lowestRunningPriorityCore();
      if (worstCore !== -1 && highest > lowest) {
        this._preemptToReady(worstCore, "Preempted by higher-priority task");
      }
    }

    // Dispatch to idle cores
    for (let c = 0; c < this.cores; c++) {
      if (this.running[c]) continue;

      const next = this._dequeueNext();
      if (next) {
        const reason = this.nextStartReason[c] || "Dispatched by scheduler";
        this._dispatch(c, next);
        this._startOrExtendSegment(c, next.label, this.t, reason);
        this.nextStartReason[c] = null;
      } else {
        const reason = this.nextStartReason[c] || "No ready tasks (idle)";
        this._startOrExtendSegment(c, "IDLE", this.t, reason);
        this.nextStartReason[c] = null;
      }
    }
  }

  step() {
    if (this.done) return { done: true, ran: [] };

    // 1) admit arrivals at time t
    while (this.notArrived.length > 0 && this.notArrived[0].arrival === this.t) {
      const p = this.notArrived.shift();
      // skip yield tokens at start
      while (p.currentBurst() && p.currentBurst().type === "yield") p.idx += 1;
      p.remaining = p.currentBurst()?.dur ?? 0;
      this._enqueue(p);
    }

    // 2) progress I/O
    for (const p of Array.from(this.blocked)) {
      p.remaining -= 1;
      if (p.remaining <= 0) {
        this.blocked.delete(p);
        p.idx += 1;

        while (p.currentBurst() && p.currentBurst().type === "yield") p.idx += 1;

        const next = p.currentBurst();
        if (!next) {
          p.state = "done";
          p.finishTime = this.t + 1;
          continue;
        }
        p.remaining = next.dur;
        if (next.type === "cpu") {
          this._enqueue(p);
        } else {
          // IO followed by IO (rare); keep blocked
          p.state = "blocked";
          this.blocked.add(p);
        }
      }
    }

    // 3) priority preemption (preemptive + enabled)
    if (this.mode === "preemptive" && this.priorityPreempt && this.ready.length > 0) {
      const highest = this._highestReadyPriority();
      const { worstCore, lowest } = this._lowestRunningPriorityCore();
      if (worstCore !== -1 && highest > lowest) {
        this._preemptToReady(worstCore, "Preempted by higher-priority task");
      }
    }

    // 4) dispatch to idle cores
    for (let c = 0; c < this.cores; c++) {
      if (this.running[c]) continue;

      const next = this._dequeueNext();
      if (next) {
        const reason = this.nextStartReason[c] || "Dispatched by scheduler";
        this._dispatch(c, next);
        this._startOrExtendSegment(c, next.label, this.t, reason);
        this.nextStartReason[c] = null;
      } else {
        const reason = this.nextStartReason[c] || "No ready tasks (idle)";
        this._startOrExtendSegment(c, "IDLE", this.t, reason);
        this.nextStartReason[c] = null;
      }
    }

    // Capture who will run during this 1ms tick (after dispatch, before execution)
    const ran = Array.from({ length: this.cores }, (_, c) => {
      const p = this.running[c];
      if (!p) return { id: null, label: "IDLE", color: null };
      return { id: p.id, label: p.label, color: p.color };
    });

    // 5) Execute 1 ms on each core (interval [t, t+1))
    for (let c = 0; c < this.cores; c++) {
      const p = this.running[c];
      if (!p) continue;

      // busy time
      this.busyMsByCore[c] += 1;

      p.remaining -= 1;
      p.sliceRemaining -= 1;

      // CPU burst finished?
      if (p.remaining <= 0) {
        this.running[c] = null;
        this._advanceAfterCpuEnd(c, p, "Previous task ended CPU burst");
        continue;
      }

      // preemptive: timer quantum expired
      if (this.mode === "preemptive" && p.sliceRemaining <= 0) {
        this._preemptToReady(c, "Time quantum expired (timer interrupt)");
        continue;
      }

      // cooperative: yield interval expired
      if (this.mode === "coop" && p.sliceRemaining <= 0 && this.coopYield > 0) {
        this._preemptToReady(c, "Voluntary yield (cooperative)");
        continue;
      }
    }

    this.t += 1;

    // stop if everything finished
    const anyRunning = this.running.some(Boolean);
    const anyReady = this.ready.length > 0;
    const anyBlocked = this.blocked.size > 0;
    const anyNotArrived = this.notArrived.length > 0;

    if (!anyRunning && !anyReady && !anyBlocked && !anyNotArrived) {
      for (let c = 0; c < this.cores; c++) this._closeSegment(c, this.t);
      this.done = true;
    }

    return { done: this.done, ran };
  }

  runToEnd(limit = 5000) {
    let steps = 0;
    while (!this.done && steps < limit) {
      this.step();
      steps += 1;
    }
    return this.snapshot();
  }

  metrics() {
    const makespan = this.t;
    const totalBusy = this.busyMsByCore.reduce((a,b) => a+b, 0);
    const util = totalBusy / Math.max(1, makespan * this.cores);

    const pcs = this.procs.filter(p => p.label === "P_C" && p.firstRun !== null);
    const resp = pcs
      .map(p => ({ id: p.id, arrival: p.arrival, firstRun: p.firstRun, response: p.firstRun - p.arrival }))
      .sort((a,b) => a.arrival - b.arrival);

    return { makespan, util, totalBusy, busyByCore: this.busyMsByCore.slice(), pcResponse: resp };
  }
}

/* ---------- DOM helpers: FLIP animation ---------- */
function flipMove(el, newParent, insertBefore = null) {
  if (!el || !newParent) return;

  const first = el.getBoundingClientRect();

  if (insertBefore) newParent.insertBefore(el, insertBefore);
  else newParent.appendChild(el);

  const last = el.getBoundingClientRect();

  const dx = first.left - last.left;
  const dy = first.top - last.top;

  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

  el.style.transform = `translate(${dx}px, ${dy}px)`;
  el.style.transition = "transform 0s";

  requestAnimationFrame(() => {
    el.style.transition = "transform 260ms ease";
    el.style.transform = "translate(0, 0)";
  });
}

/* ---------- App state ---------- */
const App = {
  workloadRows: getReportDefaultWorkload(),
  appliedWorkload: null,
  engine: null,
  playing: false,
  playTimer: null,
  compareCache: null,

  // Process chip elements
  chips: new Map(),

  // Live Gantt state (per core)
  gantt: {
    lastSegEl: [],
    lastLabel: [],
  }
};

/* ---------- Workload editor rendering ---------- */
function renderWorkloadEditor() {
  const body = document.getElementById("workloadBody");
  if (!body) return;

  body.innerHTML = "";
  for (const row of App.workloadRows) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td><input data-k="label" value="${escapeHtml(row.label)}" /></td>
      <td><input data-k="arrival" type="number" min="0" step="1" value="${row.arrival}" /></td>
      <td><input data-k="priority" type="number" min="0" step="1" value="${row.priority}" /></td>
      <td><input data-k="burstStr" value="${escapeHtml(row.burstStr)}" placeholder="CPU10 IO40 CPU10" /></td>
      <td><button class="btn btn--ghost" data-action="remove" title="Remove">✕</button></td>
    `;

    tr.querySelector('[data-action="remove"]').addEventListener("click", () => {
      App.workloadRows = App.workloadRows.filter(r => r.id !== row.id);
      renderWorkloadEditor();
    });

    // Update row model on input
    for (const inp of Array.from(tr.querySelectorAll("input[data-k]"))) {
      inp.addEventListener("input", () => {
        const k = inp.getAttribute("data-k");
        let v = inp.value;
        if (k === "arrival" || k === "priority") v = Number(v);
        row[k] = v;
      });
    }

    body.appendChild(tr);
  }
}

function addWorkloadRow() {
  const nextNum = App.workloadRows.length + 1;
  App.workloadRows.push({
    id: `P${Date.now()}_${Math.floor(Math.random()*1000)}`,
    label: `P_${nextNum}`,
    arrival: 0,
    priority: 1,
    burstStr: "CPU20"
  });
  renderWorkloadEditor();
}

function loadReportExample() {
  App.workloadRows = getReportDefaultWorkload();
  renderWorkloadEditor();
}

function applyWorkload() {
  const errorEl = document.getElementById("workloadError");
  if (errorEl) errorEl.textContent = "";

  const parsed = [];
  const seenIds = new Set();

  for (let i = 0; i < App.workloadRows.length; i++) {
    const r = App.workloadRows[i];
    const label = String(r.label ?? "").trim();
    if (!label) {
      if (errorEl) errorEl.textContent = `Row ${i+1}: label is required.`;
      return false;
    }

    let arrival = Number(r.arrival);
    let priority = Number(r.priority);
    if (!Number.isFinite(arrival) || arrival < 0) arrival = 0;
    if (!Number.isFinite(priority) || priority < 0) priority = 0;

    const burstRes = parseBurstString(r.burstStr);
    if (!burstRes.ok) {
      if (errorEl) errorEl.textContent = `Row ${i+1} (${label}): ${burstRes.error}`;
      return false;
    }

    const id = r.id || `${label}_${i}`;
    if (seenIds.has(id)) {
      if (errorEl) errorEl.textContent = `Duplicate process id detected at row ${i+1}. Try reloading or re-adding a row.`;
      return false;
    }
    seenIds.add(id);

    parsed.push({
      id,
      label,
      arrival: Math.floor(arrival),
      priority: Math.floor(priority),
      bursts: burstRes.bursts,
      color: colorForLabel(label),
    });
  }

  parsed.sort((a,b) => (a.arrival - b.arrival));

  App.appliedWorkload = parsed;

  // Reset simulation + comparison
  resetSimulation(true);
  refreshComparison();

  return true;
}

/* ---------- Presets ---------- */
const PRESETS = {
  report: {
    policy: "priority",
    mode: "preemptive",
    quantum: 20,
    coopYield: 20,
    cores: 1,
    priorityPreempt: true,
    note: "Matches the report: preemptive + priority + 20 s quantum. Interactive tasks (higher priority) should run quickly."
  },
  multiprogramming: {
    policy: "fcfs",
    mode: "none",
    quantum: 20,
    coopYield: 0,
    cores: 1,
    priorityPreempt: false,
    note: "Multiprogramming (batch style): no time slicing; switching mainly happens when a job blocks for I/O or finishes."
  },
  cooperative: {
    policy: "rr",
    mode: "coop",
    quantum: 20,
    coopYield: 20,
    cores: 1,
    priorityPreempt: false,
    note: "Cooperative multitasking: tasks must yield voluntarily. Set yield interval to 0 to simulate a CPU hog (unresponsive system)."
  },
  preemptive: {
    policy: "rr",
    mode: "preemptive",
    quantum: 20,
    coopYield: 20,
    cores: 1,
    priorityPreempt: false,
    note: "Preemptive multitasking: timer-based preemption (quantum) keeps the system responsive."
  },
  timesharing: {
    policy: "rr",
    mode: "preemptive",
    quantum: 20,
    coopYield: 20,
    cores: 1,
    priorityPreempt: false,
    note: "Time-sharing: Round Robin time slices so multiple users/tasks get a fair share of CPU time."
  },
  multiprocessing: {
    policy: "rr",
    mode: "preemptive",
    quantum: 20,
    coopYield: 20,
    cores: 2,
    priorityPreempt: false,
    note: "Multiprocessing: 2 CPU cores run tasks in parallel; each core still uses scheduling and (optional) preemption."
  }
};

function applyPreset(presetId) {
  const p = PRESETS[presetId] ?? PRESETS.report;

  const policySelect = document.getElementById("policySelect");
  const modeSelect = document.getElementById("modeSelect");
  const quantumInput = document.getElementById("quantumInput");
  const coopYieldInput = document.getElementById("coopYieldInput");
  const coresInput = document.getElementById("coresInput");
  const priToggle = document.getElementById("priorityPreemptToggle");

  if (policySelect) policySelect.value = p.policy;
  if (modeSelect) modeSelect.value = p.mode;
  if (quantumInput) quantumInput.value = String(p.quantum);
  if (coopYieldInput) coopYieldInput.value = String(p.coopYield);
  if (coresInput) coresInput.value = String(p.cores);
  if (priToggle) priToggle.checked = p.priorityPreempt;

  renderModelExplanation(p.note);

  resetSimulation(true);
  refreshComparison();
}

function readSettingsFromUI() {
  const policy = document.getElementById("policySelect")?.value ?? "priority";
  const mode = document.getElementById("modeSelect")?.value ?? "preemptive";
  const cores = clamp(Number(document.getElementById("coresInput")?.value ?? 1), 1, 8);
  const quantum = clamp(Number(document.getElementById("quantumInput")?.value ?? 20), 1, 500);
  const coopYield = clamp(Number(document.getElementById("coopYieldInput")?.value ?? 0), 0, 500);
  const priorityPreempt = Boolean(document.getElementById("priorityPreemptToggle")?.checked);

  return { policy, mode, cores, quantum, coopYield, priorityPreempt };
}

/* ---------- Simulation UI rendering ---------- */
function renderModelExplanation(text) {
  const box = document.getElementById("modelExplanation");
  if (!box) return;
  box.innerHTML = `
    <h4 style="margin:.2rem 0 .35rem 0;">Explanation</h4>
    <p class="mini muted">${escapeHtml(text)}</p>
  `;
}

function buildRunningCoreSlots(cores) {
  const runningBox = document.getElementById("qRunning");
  if (!runningBox) return;

  runningBox.innerHTML = "";
  for (let c = 0; c < cores; c++) {
    const slot = document.createElement("div");
    slot.className = "core-slot";
    slot.setAttribute("data-core", String(c));
    slot.innerHTML = `<div class="core-slot__label">CPU ${c}</div><div class="core-slot__body" id="coreBody_${c}"></div>`;
    runningBox.appendChild(slot);
  }
}

function ensureChipsForWorkload(workload) {
  const anyBox = document.getElementById("qNew") || document.getElementById("qReady");
  if (!anyBox) return;

  // Remove old chips not in workload
  const ids = new Set(workload.map(p => p.id));
  for (const [id, el] of Array.from(App.chips.entries())) {
    if (!ids.has(id)) {
      el.remove();
      App.chips.delete(id);
    }
  }

  for (const p of workload) {
    if (App.chips.has(p.id)) continue;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.id = `chip_${p.id}`;
    chip.style.setProperty("--chip", p.color);
    chip.innerHTML = `<span class="chip__dot" aria-hidden="true"></span><span class="chip__label">${escapeHtml(p.label)}</span><span class="chip__badge" style="display:none;"></span>`;
    anyBox.appendChild(chip);
    App.chips.set(p.id, chip);
  }
}

function placeChip(pid, parentEl, insertBefore = null) {
  const chip = App.chips.get(pid);
  if (!chip || !parentEl) return;
  flipMove(chip, parentEl, insertBefore);
}

/* Render process tokens into New/Ready/Running/Blocked/Done */
function renderQueues(snapshot) {
  const qNew = document.getElementById("qNew");
  const qReady = document.getElementById("qReady");
  const qBlocked = document.getElementById("qBlocked");
  const qDone = document.getElementById("qDone");
  const hint = document.getElementById("queueHint");
  if (!qNew || !qReady || !qBlocked || !qDone) return;

  // Running core bodies
  const coreBodies = Array.from({ length: snapshot.cores }, (_, c) => document.getElementById(`coreBody_${c}`));

  // Ensure chips exist
  ensureChipsForWorkload(App.appliedWorkload ?? []);

  // Place each process based on state
  for (const p of snapshot.procs) {
    const chip = App.chips.get(p.id);
    if (!chip) continue;

    const badge = chip.querySelector(".chip__badge");

    if (p.state === "new") {
      if (badge) {
        badge.style.display = "";
        badge.textContent = `t=${p.arrival}s`;
      }
      placeChip(p.id, qNew);
      continue;
    }

    if (p.state === "ready") {
      if (badge) badge.style.display = "none";
      // moved later in correct order using snapshot.ready
      continue;
    }

    if (p.state === "running") {
      if (badge) badge.style.display = "none";
      const body = coreBodies[p.core ?? 0];
      if (body) placeChip(p.id, body);
      continue;
    }

    if (p.state === "blocked") {
      if (badge) {
        badge.style.display = "";
        badge.textContent = `IO ${p.remaining}s`;
      }
      placeChip(p.id, qBlocked);
      continue;
    }

    if (p.state === "done") {
      if (badge) badge.style.display = "none";
      placeChip(p.id, qDone);
      continue;
    }
  }

  // READY: reorder by ready queue order (this also moves them into qReady)
  let insertPoint = null;
  for (let i = snapshot.ready.length - 1; i >= 0; i--) {
    const pid = snapshot.ready[i];
    placeChip(pid, qReady, insertPoint);
    insertPoint = App.chips.get(pid);
  }

  if (hint) {
    const newCount = snapshot.procs.filter(p => p.state === "new").length;
    const readyCount = snapshot.ready.length;
    const runCount = snapshot.running.filter(Boolean).length;
    const blockedCount = snapshot.procs.filter(p => p.state === "blocked").length;
    const doneCount = snapshot.procs.filter(p => p.state === "done").length;
    hint.textContent = `New: ${newCount} | Ready: ${readyCount} | Running: ${runCount}/${snapshot.cores} | Blocked: ${blockedCount} | Done: ${doneCount}`;
  }
}

/* ---------- Live Gantt stream ---------- */
const PX_PER_S = 20; // visual scale per simulated second (bigger = less cramped)

function resetGantt(cores) {
  const gantt = document.getElementById("ganttStream");
  if (!gantt) return;

  gantt.innerHTML = "";
  App.gantt.lastSegEl = Array.from({ length: cores }, () => null);
  App.gantt.lastLabel = Array.from({ length: cores }, () => null);

  for (let c = 0; c < cores; c++) {
    const row = document.createElement("div");
    row.className = "gantt-row";
    row.innerHTML = `<div class="gantt-row__label">CPU ${c}</div><div class="gantt-track" id="gTrack_${c}"></div>`;
    gantt.appendChild(row);
  }
}

/* Append one simulated millisecond to the live Gantt bar(s). */
function ganttAppend(ran, tickStartTime) {
  for (let c = 0; c < ran.length; c++) {
    const info = ran[c] || { label: "IDLE", color: null, id: null };
    const label = info.label || "IDLE";
    const track = document.getElementById(`gTrack_${c}`);
    if (!track) continue;

    const prev = App.gantt.lastLabel[c];
    const segEl = App.gantt.lastSegEl[c];

    if (prev === label && segEl) {
      const w = Number(segEl.getAttribute("data-w") ?? "0") + PX_PER_S;
      segEl.style.width = `${w}px`;
      segEl.setAttribute("data-w", String(w));
      continue;
    }

    const seg = document.createElement("div");
    seg.className = "seg seg--live " + (label === "IDLE" ? "idle" : "");
    seg.style.width = `${PX_PER_S}px`;
    seg.setAttribute("data-w", String(PX_PER_S));

    // Live timeline segments: show label text (scales are large enough to read).
    if (label !== "IDLE") {
      seg.style.background = info.color || "#7c9dff";
    }
    seg.title = `${label} (core ${c}) at t=${tickStartTime}s`;
    seg.innerHTML = `<span class="seg__txt" aria-hidden="true">${escapeHtml(label)}</span>`;

    track.appendChild(seg);
    App.gantt.lastLabel[c] = label;
    App.gantt.lastSegEl[c] = seg;
  }
}

/* ---------- Switch log table ---------- */
function renderSwitchLog(engine) {
  const wrap = document.getElementById("switchLogWrap");
  if (!wrap) return;

  const cores = engine.cores;
  let html = "";

  for (let c = 0; c < cores; c++) {
    const segs = engine.segmentsByCore[c].slice();
    const open = engine.currentSeg?.[c];
    if (open && open.end === null) segs.push({ ...open, end: engine.t });

    const visible = segs.filter(s => (s.end ?? engine.t) > s.start);

    html += `
      <table class="table" style="min-width: 720px; margin-bottom: .85rem;">
        <thead>
          <tr><th colspan="4">CPU ${c}</th></tr>
          <tr>
            <th style="width:120px;">Start (s)</th>
            <th style="width:120px;">End (s)</th>
            <th style="width:130px;">Runs</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map(s => `
            <tr>
              <td>${s.start}</td>
              <td>${s.end}</td>
              <td><strong>${escapeHtml(s.label)}</strong></td>
              <td>${escapeHtml(s.reason)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  wrap.innerHTML = html;
}

/* ---------- Metrics rendering ---------- */
function renderMetrics(engine) {
  const ul = document.getElementById("metricsList");
  const timeEl = document.getElementById("timeNow");
  if (!ul || !timeEl) return;

  timeEl.textContent = String(engine.t);

  const m = engine.metrics();
  ul.innerHTML = "";

  const utilPct = Math.round(m.util * 1000) / 10;
  ul.appendChild(li(`Cores: ${engine.cores}`));
  ul.appendChild(li(`Policy: ${engine.policy.toUpperCase()} | Mode: ${modeLabel(engine.mode)}`));
  if (engine.mode === "preemptive") ul.appendChild(li(`Quantum: ${engine.quantum} s`));
  if (engine.mode === "coop") ul.appendChild(li(`Cooperative yield interval: ${engine.coopYield} s`));
  ul.appendChild(li(`Makespan so far: ${m.makespan} s`));
  ul.appendChild(li(`CPU utilization so far: ${utilPct}%`));
  ul.appendChild(li(`Busy time: ${m.busyByCore.map((b,i)=>`CPU${i}=${b}s`).join(" | ")}`));

  if (m.pcResponse.length) {
    const parts = m.pcResponse.map(r => `arrival ${r.arrival} → first run ${r.firstRun} (response ${r.response} s)`).join("; ");
    ul.appendChild(li(`P_C response: ${parts}`));
  } else {
    ul.appendChild(li(`P_C response: (no P_C has run yet)`));
  }

  const doneCount = engine.procs.filter(p => p.state === "done").length;
  ul.appendChild(li(`Completed: ${doneCount}/${engine.procs.length}`));
}

function modeLabel(m) {
  if (m === "none") return "Non-preemptive";
  if (m === "coop") return "Cooperative";
  return "Preemptive";
}

function li(text) {
  const el = document.createElement("li");
  el.textContent = text;
  return el;
}

/* ---------- Simulation lifecycle ---------- */
function stopPlaying() {
  App.playing = false;
  if (App.playTimer) clearTimeout(App.playTimer);
  App.playTimer = null;
  setPlayButtons(false);
}

function resetSimulation(keepAppliedWorkload = true) {
  stopPlaying();

  const settings = readSettingsFromUI();
  const workload = keepAppliedWorkload && App.appliedWorkload ? App.appliedWorkload : buildAppliedFromRowsSilently();

  if (!workload) return;

  App.engine = new SchedulerEngine({
    workload,
    cores: settings.cores,
    policy: settings.policy,
    mode: settings.mode,
    quantum: settings.quantum,
    coopYield: settings.coopYield,
    priorityPreempt: settings.priorityPreempt && settings.policy === "priority"
  });

  buildRunningCoreSlots(settings.cores);
  ensureChipsForWorkload(workload);
  resetGantt(settings.cores);

  // At t=0, admit arrivals and dispatch so the initial state isn't empty.
  App.engine.settle();

  const snap = App.engine.snapshot();
  renderQueues(snap);
  renderMetrics(App.engine);
  renderSwitchLog(App.engine);

  setPlayButtons(false);
}

function buildAppliedFromRowsSilently() {
  try {
    const parsed = [];
    for (const r of App.workloadRows) {
      const burstRes = parseBurstString(r.burstStr);
      if (!burstRes.ok) return App.appliedWorkload;
      parsed.push({
        id: r.id,
        label: String(r.label).trim(),
        arrival: Math.floor(Number(r.arrival) || 0),
        priority: Math.floor(Number(r.priority) || 0),
        bursts: burstRes.bursts,
        color: colorForLabel(String(r.label).trim() || "P")
      });
    }
    parsed.sort((a,b) => a.arrival - b.arrival);
    App.appliedWorkload = parsed;
    return parsed;
  } catch {
    return App.appliedWorkload;
  }
}

function setPlayButtons(isPlaying) {
  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  if (playBtn) playBtn.disabled = isPlaying;
  if (pauseBtn) pauseBtn.disabled = !isPlaying;
}

function stepOnce() {
  if (!App.engine || App.engine.done) return;

  const tickStart = App.engine.t;
  const res = App.engine.step();
  ganttAppend(res.ran, tickStart);

  // Immediately prepare the next boundary so the Running queue updates at every displayed time.
  if (!App.engine.done) App.engine.settle();

  const snap = App.engine.snapshot();
  renderQueues(snap);
  renderMetrics(App.engine);

  if (App.engine.t % 5 === 0 || App.engine.done) renderSwitchLog(App.engine);

  if (App.engine.done) {
    stopPlaying();
    renderSwitchLog(App.engine);
  }
}

function play() {
  if (!App.engine || App.engine.done) return;

  App.playing = true;
  setPlayButtons(true);

  const speedInput = document.getElementById("speedInput");

  // Important UX fix:
  // We step ONE tick per loop and schedule the next tick with setTimeout.
  // This gives the browser time to paint every state transition so chips do not "teleport".
  const tickLoop = () => {
    if (!App.playing) return;

    if (!App.engine || App.engine.done) {
      stopPlaying();
      return;
    }

    stepOnce(); // stepOnce already updates gantt + queues + metrics

    if (!App.playing) return; // stepOnce may stop playback when finished

    const s = clamp(Number(speedInput?.value ?? 6), 1, 25);
    // Higher speed = shorter delay, but keep a floor so the browser can render animations.
    const delay = Math.max(16, Math.round(220 / s));
    App.playTimer = setTimeout(tickLoop, delay);
  };

  tickLoop();
}

function renderStaticGanttFromSegments(engine, containerIdPrefix = "gTrack_") {
  for (let c = 0; c < engine.cores; c++) {
    const track = document.getElementById(`${containerIdPrefix}${c}`);
    if (track) track.innerHTML = "";
  }

  const totalTime = Math.max(1, engine.t);
  const pxPerS = 16; // clearer (scroll horizontally if needed)
  for (let c = 0; c < engine.cores; c++) {
    const track = document.getElementById(`${containerIdPrefix}${c}`);
    if (!track) continue;

    for (const s of engine.segmentsByCore[c]) {
      const dur = Math.max(0, (s.end ?? totalTime) - s.start);
      const seg = document.createElement("div");
      seg.className = "seg " + (s.label === "IDLE" ? "idle" : "");
      seg.style.width = `${dur * pxPerS}px`;
      if (s.label !== "IDLE") {
        const col = colorForLabel(s.label);
        seg.style.background = col;
        seg.title = `${s.label} ${s.start}-${s.end}s\n${s.reason}`;
        seg.innerHTML = `<span class="seg__txt">${escapeHtml(s.label)}</span>`;
      } else {
        seg.title = `IDLE ${s.start}-${s.end}s\n${s.reason}`;
        seg.innerHTML = `<span class="seg__txt">IDLE</span>`;
      }
      track.appendChild(seg);
    }
  }
}

function runToEnd() {
  if (!App.engine) return;
  stopPlaying();

  App.engine.runToEnd(10000);

  // After running, rebuild the main gantt using segments (more accurate for the full run)
  resetGantt(App.engine.cores);
  renderStaticGanttFromSegments(App.engine);

  const snap = App.engine.snapshot();
  renderQueues(snap);
  renderMetrics(App.engine);
  renderSwitchLog(App.engine);
}

/* ---------- Policy comparison ---------- */
function refreshComparison() {
  const panel = document.getElementById("compareSingle");
  if (!panel) return;

  const settings = readSettingsFromUI();
  const workload = App.appliedWorkload ?? buildAppliedFromRowsSilently() ?? [];
  if (!workload.length) {
    panel.innerHTML = `<p class="muted">Add at least one process, then click <strong>Apply workload</strong>.</p>`;
    return;
  }

  const cases = [
    { key: "fcfs", title: "FCFS", desc: "Non-preemptive (runs a job until it blocks/finishes)", cores: 1, mode: "none", policy: "fcfs", quantum: settings.quantum, priPre: false },
    { key: "sjf", title: "SJF", desc: "Non-preemptive (shortest CPU burst first)", cores: 1, mode: "none", policy: "sjf", quantum: settings.quantum, priPre: false },
    { key: "priority", title: "Priority", desc: "Preemptive (higher priority can interrupt)", cores: 1, mode: "preemptive", policy: "priority", quantum: settings.quantum, priPre: true },
    { key: "rr", title: "RR", desc: `Preemptive (time quantum q=${settings.quantum}s)`, cores: 1, mode: "preemptive", policy: "rr", quantum: settings.quantum, priPre: false },
  ];

  const results = {};

  for (const cc of cases) {
    const eng = new SchedulerEngine({
      workload: workload.map(w => ({ ...w })), // shallow copy
      cores: cc.cores,
      policy: cc.policy,
      mode: cc.mode,
      quantum: cc.quantum,
      coopYield: settings.coopYield,
      priorityPreempt: cc.priPre
    });

    eng.runToEnd(10000);
    const met = eng.metrics();

    results[cc.key] = {
      ...cc,
      metrics: met,
      segments: eng.segmentsByCore?.[0] ?? []
    };
  }

  App.compareCache = { results, lastQuantum: settings.quantum, ts: Date.now() };

  const select = document.getElementById("comparePolicySelect");
  const selected = select?.value ?? "rr";
  renderCompareSelected(selected);
}


function renderCompareSelected(key) {
  const panel = document.getElementById("compareSingle");
  if (!panel) return;

  const res = App.compareCache?.results?.[key];
  if (!res) {
    panel.innerHTML = `<p class="muted">Click <strong>Refresh comparison</strong> to generate comparison results.</p>`;
    return;
  }

  const met = res.metrics;

  panel.innerHTML = `
    <div class="compare-card" aria-label="${escapeHtml(res.title)} comparison">
      <div class="compare-card__head">
        <div class="compare-card__title">${escapeHtml(res.title)}</div>
        <div class="mini muted">${escapeHtml(res.desc)}</div>
      </div>
      <div class="compare-card__body">
        <div class="mini-gantt" aria-label="${escapeHtml(res.title)} mini gantt">
          <div class="gantt-row">
            <div class="gantt-row__label">CPU</div>
            <div class="gantt-track" id="compareMiniTrack"></div>
          </div>
        </div>

        <div class="kv">Makespan: <strong>${met.makespan} s</strong></div>
        <div class="kv">Utilization: <strong>${Math.round(met.util * 1000) / 10}%</strong></div>
        <div class="kv">P_C response: <strong>${formatPcResponse(met.pcResponse)}</strong></div>

        <p class="hint" style="margin-top:.6rem;">
          Hover a segment to see why the CPU switched (e.g., quantum expired, I/O block, preemption).
        </p>
      </div>
    </div>
  `;

  const track = panel.querySelector("#compareMiniTrack");
  if (!track) return;

  const px = 10.0; // larger to avoid a cramped mini timeline

  for (const s of res.segments) {
    const dur = Math.max(0, (s.end ?? met.makespan) - s.start);
    const seg = document.createElement("div");
    seg.className = "seg " + (s.label === "IDLE" ? "idle" : "");
    seg.style.width = `${dur * px}px`;

    if (s.label !== "IDLE") {
      seg.style.background = colorForLabel(s.label);
      seg.title = `${s.label} ${s.start}-${s.end}s\n${s.reason}`;
      seg.innerHTML = `<span class="seg__txt">${escapeHtml(s.label)}</span>`;
    } else {
      seg.title = `IDLE ${s.start}-${s.end}s\n${s.reason}`;
      seg.innerHTML = `<span class="seg__txt">IDLE</span>`;
    }

    track.appendChild(seg);
  }
}

function formatPcResponse(list) {
  if (!list || !list.length) return "—";
  return list.map(r => `${r.arrival}→${r.firstRun} (${r.response}s)`).join(", ");
}

/* ---------- Race condition demo ---------- */
function setupRaceDemo() {
  const lockToggle = document.getElementById("raceLockToggle");
  const counterEl = document.getElementById("raceCounter");
  const stepEl = document.getElementById("raceStep");
  const aEl = document.getElementById("raceA");
  const bEl = document.getElementById("raceB");
  const noteEl = document.getElementById("raceNote");
  const stepBtn = document.getElementById("raceStepBtn");
  const resetBtn = document.getElementById("raceResetBtn");

  if (!lockToggle || !counterEl || !stepEl || !aEl || !bEl || !noteEl || !stepBtn || !resetBtn) return;

  const state = {
    counter: 0,
    step: 0,
    lockHeldBy: null, // "A" | "B" | null
    A: { reg: null, phase: 0 },
    B: { reg: null, phase: 0 },
  };

  function phaseLabel(p) {
    if (p === 0) return "READ";
    if (p === 1) return "ADD";
    if (p === 2) return "WRITE";
    return "DONE";
  }

  function render() {
    counterEl.textContent = String(state.counter);
    stepEl.textContent = String(state.step);

    aEl.textContent = [
      "A: counter = counter + 1",
      "",
      `phase: ${phaseLabel(state.A.phase)}`,
      `reg: ${state.A.reg === null ? "—" : state.A.reg}`,
    ].join("\n");

    bEl.textContent = [
      "B: counter = counter + 1",
      "",
      `phase: ${phaseLabel(state.B.phase)}`,
      `reg: ${state.B.reg === null ? "—" : state.B.reg}`,
    ].join("\n");

    if (state.step === 0) {
      noteEl.textContent = "Click Step. Without the lock, we use an interleaving that causes a lost update.";
      return;
    }

    if (state.step >= 6) {
      if (!lockToggle.checked && state.counter === 1) {
        noteEl.textContent = "Lost update! Two increments happened, but counter became 1 (race condition).";
      } else if (lockToggle.checked && state.counter === 2) {
        noteEl.textContent = "With a lock, increments serialize and counter becomes 2 (correct).";
      } else {
        noteEl.textContent = "Done.";
      }
      return;
    }

    noteEl.textContent = lockToggle.checked
      ? `Lock ON: ${state.lockHeldBy ? `lock held by ${state.lockHeldBy}` : "lock is free"}`
      : "Lock OFF: interleaving can change the result.";
  }

  function reset() {
    state.counter = 0;
    state.step = 0;
    state.lockHeldBy = null;
    state.A = { reg: null, phase: 0 };
    state.B = { reg: null, phase: 0 };
    render();
  }

  function canRun(threadId) {
    if (!lockToggle.checked) return true;
    return state.lockHeldBy === null || state.lockHeldBy === threadId;
  }

  function takeLock(threadId) {
    if (!lockToggle.checked) return;
    if (state.lockHeldBy === null) state.lockHeldBy = threadId;
  }

  function releaseLock(threadId) {
    if (!lockToggle.checked) return;
    if (state.lockHeldBy === threadId) state.lockHeldBy = null;
  }

  function runMicroStep(T, threadId) {
    if (!canRun(threadId)) return { progressed: false, note: `${threadId} blocked on lock` };
    if (lockToggle.checked && T.phase === 0) takeLock(threadId);

    if (T.phase === 0) { T.reg = state.counter; T.phase = 1; return { progressed: true, note: `${threadId} read counter` }; }
    if (T.phase === 1) { T.reg = (T.reg ?? 0) + 1; T.phase = 2; return { progressed: true, note: `${threadId} computed reg+1` }; }
    if (T.phase === 2) { state.counter = T.reg ?? state.counter; T.phase = 3; releaseLock(threadId); return { progressed: true, note: `${threadId} wrote counter` }; }
    return { progressed: false, note: `${threadId} already done` };
  }

  const seqNoLock = ["A","B","A","B","A","B"];
  const seqWithLock = ["A","A","A","B","B","B"];

  function step() {
    if (state.step >= 6) return;
    const seq = lockToggle.checked ? seqWithLock : seqNoLock;
    const who = seq[state.step];
    const res = (who === "A") ? runMicroStep(state.A, "A") : runMicroStep(state.B, "B");
    state.step += 1;
    if (res.note) noteEl.textContent = res.note;
    render();
  }

  stepBtn.addEventListener("click", step);
  resetBtn.addEventListener("click", reset);
  lockToggle.addEventListener("change", reset);

  reset();
}

/* ---------- Deadlock demo ---------- */
function setupDeadlockDemo() {
  const preventToggle = document.getElementById("deadlockPreventToggle");
  const stepEl = document.getElementById("deadStep");
  const statusEl = document.getElementById("deadStatus");
  const locksEl = document.getElementById("deadLocks");
  const procsEl = document.getElementById("deadProcs");
  const noteEl = document.getElementById("deadNote");
  const stepBtn = document.getElementById("deadStepBtn");
  const resetBtn = document.getElementById("deadResetBtn");

  if (!preventToggle || !stepEl || !statusEl || !locksEl || !procsEl || !noteEl || !stepBtn || !resetBtn) return;

  const state = {
    step: 0,
    locks: { L1: null, L2: null },
    procs: { P1: { holds: [], waitsFor: null }, P2: { holds: [], waitsFor: null } },
    status: "Ready"
  };

  function render() {
    stepEl.textContent = String(state.step);
    statusEl.textContent = state.status;

    locksEl.textContent = `L1 holder: ${state.locks.L1 ?? "—"}\nL2 holder: ${state.locks.L2 ?? "—"}`;
    procsEl.textContent =
`P1 holds: [${state.procs.P1.holds.join(", ") || "—"}]  waitsFor: ${state.procs.P1.waitsFor ?? "—"}
P2 holds: [${state.procs.P2.holds.join(", ") || "—"}]  waitsFor: ${state.procs.P2.waitsFor ?? "—"}`;

    if (state.status === "Deadlock!") {
      noteEl.textContent = "Deadlock occurred: each process is waiting for a lock held by the other (circular wait).";
    } else if (preventToggle.checked) {
      noteEl.textContent = "Prevention ON: both processes acquire locks in the same order (L1 then L2).";
    } else {
      noteEl.textContent = "Prevention OFF: P1 takes L1, P2 takes L2, then they wait on each other.";
    }
  }

  function reset() {
    state.step = 0;
    state.locks = { L1: null, L2: null };
    state.procs = { P1: { holds: [], waitsFor: null }, P2: { holds: [], waitsFor: null } };
    state.status = "Ready";
    render();
  }

  function acquire(proc, lock) {
    if (state.locks[lock] === null) {
      state.locks[lock] = proc;
      state.procs[proc].holds.push(lock);
      state.procs[proc].waitsFor = null;
      return true;
    }
    state.procs[proc].waitsFor = lock;
    return false;
  }

  function step() {
    if (state.step >= 4) return;

    const prevent = preventToggle.checked;

    if (!prevent) {
      if (state.step === 0) acquire("P1", "L1");
      if (state.step === 1) acquire("P2", "L2");
      if (state.step === 2) acquire("P1", "L2");
      if (state.step === 3) acquire("P2", "L1");

      state.step += 1;
      if (state.procs.P1.waitsFor && state.procs.P2.waitsFor) state.status = "Deadlock!";
      render();
      return;
    }

    if (state.step === 0) acquire("P1", "L1");
    if (state.step === 1) acquire("P2", "L1");
    if (state.step === 2) acquire("P1", "L2");
    if (state.step === 3) {
      for (const lk of state.procs.P1.holds) state.locks[lk] = null;
      state.procs.P1.holds = [];
      state.procs.P1.waitsFor = null;

      acquire("P2", "L1");
      state.status = "No deadlock (progress continues)";
    }

    state.step += 1;
    render();
  }

  stepBtn.addEventListener("click", step);
  resetBtn.addEventListener("click", reset);
  preventToggle.addEventListener("change", reset);

  reset();
}

/* ---------- Wiring ---------- */
function setupControls() {
  document.getElementById("addProcBtn")?.addEventListener("click", addWorkloadRow);
  document.getElementById("loadReportBtn")?.addEventListener("click", loadReportExample);
  document.getElementById("applyWorkloadBtn")?.addEventListener("click", applyWorkload);

  document.getElementById("presetSelect")?.addEventListener("change", (e) => applyPreset(e.target.value));

  document.getElementById("policySelect")?.addEventListener("change", () => resetSimulation(true));
  document.getElementById("modeSelect")?.addEventListener("change", () => resetSimulation(true));
  document.getElementById("coresInput")?.addEventListener("change", () => resetSimulation(true));
  document.getElementById("quantumInput")?.addEventListener("change", () => { resetSimulation(true); refreshComparison(); });
  document.getElementById("coopYieldInput")?.addEventListener("change", () => resetSimulation(true));
  document.getElementById("priorityPreemptToggle")?.addEventListener("change", () => resetSimulation(true));

  document.getElementById("playBtn")?.addEventListener("click", play);
  document.getElementById("pauseBtn")?.addEventListener("click", stopPlaying);
  document.getElementById("stepBtn")?.addEventListener("click", stepOnce);
  document.getElementById("resetSimBtn")?.addEventListener("click", () => resetSimulation(true));
  document.getElementById("runToEndBtn")?.addEventListener("click", runToEnd);

  document.getElementById("refreshCompareBtn")?.addEventListener("click", refreshComparison);
  document.getElementById("comparePolicySelect")?.addEventListener("change", (e) => renderCompareSelected(e.target.value));

  const speedInput = document.getElementById("speedInput");
  const speedLabel = document.getElementById("speedLabel");
  if (speedInput && speedLabel) {
    const update = () => speedLabel.textContent = `${speedInput.value}×`;
    speedInput.addEventListener("input", update);
    update();
  }
}

function main() {
  setTheme(getPreferredTheme());
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setTheme(current === "light" ? "dark" : "light");
  });

  setupNavHighlight();

  App.workloadRows = getReportDefaultWorkload();
  renderWorkloadEditor();
  applyWorkload();

  renderModelExplanation(PRESETS.report.note);

  setupControls();
  setupRaceDemo();
  setupDeadlockDemo();

  const presetSelect = document.getElementById("presetSelect");
  if (presetSelect) presetSelect.value = "report";
  applyPreset("report");
}

document.addEventListener("DOMContentLoaded", main);
