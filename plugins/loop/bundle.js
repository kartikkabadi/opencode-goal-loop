// @bun
// lib/store.js
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
var STORE_VERSION = 1;
var MIN_INTERVAL_MS = 1e4;
var MAX_INTERVAL_MS = 7 * 24 * 3600000;
var DEFAULT_MAX_FIRES = null;
var EXPIRY_MS = 7 * 24 * 3600000;
var BUSY_BACKOFF_INITIAL_MS = 2000;
var BUSY_BACKOFF_MAX_MS = 30000;
function storePath() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "goal-loop", "loop", "loops.json");
}
function shortId(id) {
  return String(id ?? "").slice(0, 8);
}
function loadStore() {
  const p = storePath();
  if (!existsSync(p))
    return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const loops = Array.isArray(parsed.loops) ? parsed.loops : [];
    return gcLoops(loops);
  } catch {
    try {
      renameSync(p, `${p}.corrupt`);
    } catch {}
    return [];
  }
}
function gcLoops(loops) {
  const now = Date.now();
  const kept = loops.filter((l) => now - Date.parse(l.updatedAt ?? l.createdAt ?? 0) < EXPIRY_MS);
  if (kept.length !== loops.length)
    saveStore(kept);
  return kept;
}
function saveStore(loops) {
  const p = storePath();
  mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, loops }, null, 2));
  renameSync(tmp, p);
}
function newLoop({ sessionId, prompt, interval, label = null, maxFires = DEFAULT_MAX_FIRES, immediate = true }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    label,
    sessionId,
    prompt,
    interval,
    maxFires,
    fires: 0,
    immediate,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    turnsUntilNext: interval.kind === "turns" ? interval.n : null,
    lastRunAt: null,
    lastError: null,
    consecutiveErrors: 0,
    backoffMs: BUSY_BACKOFF_INITIAL_MS
  };
}
function findLoop(loops, sessionId, idOrLabel) {
  if (!idOrLabel)
    return null;
  const score = (l) => (l.sessionId === sessionId ? 0 : 1) + (l.status === "active" || l.status === "paused" ? 0 : 2);
  let best = null;
  for (const l of loops) {
    if (l.id !== idOrLabel && l.label !== idOrLabel)
      continue;
    if (!best || score(l) < score(best))
      best = l;
  }
  return best;
}
function mostRecentActive(loops, sessionId) {
  let best = null;
  for (const l of loops) {
    if (l.sessionId !== sessionId || l.status !== "active")
      continue;
    if (!best || Date.parse(l.updatedAt) > Date.parse(best.updatedAt))
      best = l;
  }
  return best;
}
function describeInterval(interval) {
  return interval.raw;
}
function nextDelayMs(loop, now = Date.now()) {
  if (loop.interval.kind !== "time")
    return null;
  let ms = loop.interval.ms;
  if (ms >= 60000)
    ms = Math.round(ms * (0.95 + Math.random() * 0.1));
  return ms;
}

// lib/parse.js
var ACTIONS = ["list", "stop", "pause", "resume", "status", "help"];
function parseInterval(token) {
  if (/^\d+t(urns?)?$/i.test(token)) {
    const n = parseInt(token, 10);
    return Number.isSafeInteger(n) && n >= 1 ? { kind: "turns", n, raw: token.toLowerCase() } : null;
  }
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(token.toLowerCase());
  if (!m || token === "")
    return null;
  const [, d, h, min, s] = m;
  if (d == null && h == null && min == null && s == null)
    return null;
  const ms = ((+d || 0) * 86400 + (+h || 0) * 3600 + (+min || 0) * 60 + (+s || 0)) * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0)
    return null;
  return { kind: "time", ms, raw: token.toLowerCase() };
}
function parseLoopArgs(rawArgs) {
  let input = String(rawArgs ?? "").trim();
  if (input.length > 1 && (input.startsWith('"') && input.endsWith('"') || input.startsWith("'") && input.endsWith("'"))) {
    input = input.slice(1, -1).trim();
  }
  if (!input)
    return { action: "status" };
  if (input === "help" || input === "--help" || input === "-h")
    return { action: "help" };
  const firstToken = input.split(/\s+/)[0];
  if (ACTIONS.includes(firstToken)) {
    const rest = input.slice(firstToken.length).trim();
    if (firstToken === "list")
      return { action: "list", all: rest === "--all" || rest === "-a" };
    if (firstToken === "help")
      return { action: "help" };
    return { action: firstToken, idOrLabel: rest || undefined };
  }
  let text = input;
  let label;
  let times;
  let immediate = true;
  const labelM = /--label\s+([A-Za-z0-9._-]{1,32})/.exec(text);
  if (labelM) {
    label = labelM[1];
    text = text.replace(labelM[0], "");
  } else if (/--label/.test(text)) {
    return { action: "invalid", error: "--label needs a value: letters, digits, dot, dash, underscore (max 32 chars)" };
  }
  const timesM = /--times\s+(\d+)/.exec(text);
  if (timesM) {
    times = parseInt(timesM[1], 10);
    text = text.replace(timesM[0], "");
  } else if (/--times/.test(text)) {
    return { action: "invalid", error: "--times needs a number (max 1000)" };
  }
  if (/--no-immediate/.test(text)) {
    immediate = false;
    text = text.replace(/--no-immediate/g, "");
  }
  text = text.trim();
  const tokens = text.split(/\s+/);
  if (tokens[0])
    tokens[0] = tokens[0].replace(/^["']+|["']+$/g, "");
  const maybeInterval = parseInterval(tokens[0] ?? "");
  if (!maybeInterval) {
    if (/^\d+$/.test(tokens[0] ?? "")) {
      return { action: "invalid", error: `bare number "${tokens[0]}" has no unit - use e.g. 5m or 3t` };
    }
    return {
      action: "invalid",
      error: "first token must be an interval like 30s / 5m / 2h / 1d / 1h30m or a turn count like 3t, followed by the prompt. Example: /loop 5m check CI status"
    };
  }
  const prompt = tokens.slice(1).join(" ").trim();
  if (!prompt)
    return { action: "invalid", error: "prompt required after the interval: /loop 5m check CI status" };
  return { action: "create", prompt, interval: maybeInterval, label: label ?? null, times: times ?? null, immediate };
}

// lib/engine.js
var LOOP_COMPLETE_RE = /^LOOP_COMPLETE\s*$/m;

class LoopEngine {
  constructor(ports) {
    this.ports = ports;
    this.timers = new Map;
    this.firing = new Set;
  }
  armAll() {
    const loops = loadStore();
    const now = this.ports.now();
    for (const loop of loops) {
      if (loop.status !== "active" || loop.interval.kind !== "time")
        continue;
      const due = loop.nextRunAt ?? now;
      if (now - due > loop.interval.ms) {
        this.tick(loop.id);
      } else {
        this.#arm(loop);
      }
    }
  }
  #arm(loop) {
    if (this.timers.has(loop.id))
      clearTimeout(this.timers.get(loop.id));
    const now = this.ports.now();
    const delay = Math.max(0, Math.min((loop.nextRunAt ?? now) - now, 2 ** 31 - 1));
    const t = setTimeout(() => void this.tick(loop.id), delay);
    if (typeof t.unref === "function")
      t.unref();
    this.timers.set(loop.id, t);
  }
  #disarm(loopId) {
    const t = this.timers.get(loopId);
    if (t)
      clearTimeout(t);
    this.timers.delete(loopId);
  }
  async tick(loopId) {
    const loops = loadStore();
    const loop = loops.find((l) => l.id === loopId);
    if (!loop || loop.status !== "active") {
      this.#disarm(loopId);
      return;
    }
    const sid = loop.sessionId;
    let goalActive = false;
    try {
      goalActive = await this.ports.goalActive(sid);
    } catch {}
    if (goalActive) {
      loop.nextRunAt = this.ports.now() + (loop.interval.kind === "time" ? loop.interval.ms : 60000);
      saveStore(loops);
      this.#arm(loop);
      return;
    }
    let busy = false;
    try {
      busy = await this.ports.isBusy(sid);
    } catch {}
    if (busy || this.firing.has(sid)) {
      const backoff = Math.min(BUSY_BACKOFF_MAX_MS, (loop.backoffMs ?? BUSY_BACKOFF_INITIAL_MS) * 2);
      loop.backoffMs = backoff;
      loop.nextRunAt = this.ports.now() + backoff;
      saveStore(loops);
      this.#arm(loop);
      return;
    }
    if (loop.interval.kind === "turns") {
      loop.turnsUntilNext = loop.interval.n;
      saveStore(loops);
      return;
    }
    await this.#fire(loop);
  }
  async#fire(loop) {
    const sid = loop.sessionId;
    this.firing.add(sid);
    try {
      const loops = loadStore();
      const cur = loops.find((l) => l.id === loop.id);
      if (!cur || cur.status !== "active")
        return;
      cur.backoffMs = BUSY_BACKOFF_INITIAL_MS;
      cur.fires += 1;
      cur.lastRunAt = new Date().toISOString();
      if (cur.interval.kind === "time") {
        cur.nextRunAt = this.ports.now() + nextDelayMs(cur);
      } else {
        cur.turnsUntilNext = cur.interval.n;
      }
      const finishAfterFire = cur.maxFires != null && cur.fires >= cur.maxFires;
      if (finishAfterFire)
        cur.status = "done";
      saveStore(loops);
      const name = cur.label ?? `#${shortId(cur.id)}`;
      const fireCount = cur.maxFires != null ? `${cur.fires}/${cur.maxFires}` : String(cur.fires);
      const text = `[loop ${name} fire ${fireCount}] ${cur.prompt}

` + `(When this recurring task is finished or moot, end your reply with a line containing exactly: LOOP_COMPLETE)`;
      let sent = false;
      try {
        sent = await this.ports.sendWork(sid, text);
      } catch (err) {}
      const loops2 = loadStore();
      const cur2 = loops2.find((l) => l.id === loop.id);
      if (!cur2)
        return;
      if (!sent) {
        cur2.consecutiveErrors = (cur2.consecutiveErrors ?? 0) + 1;
        cur2.lastError = "could not inject turn";
        if (cur2.consecutiveErrors >= 3 && cur2.status === "active") {
          cur2.status = "error";
          this.ports.sendNote(sid, `[loop ${name}] stopped: injection failed ${cur2.consecutiveErrors} times.`);
        }
        if (cur2.interval.kind === "time" && cur2.status === "active") {
          cur2.nextRunAt = this.ports.now() + cur2.interval.ms;
        }
      } else {
        cur2.consecutiveErrors = 0;
        if (finishAfterFire && cur2.status === "done") {
          this.ports.sendNote(sid, `[loop ${name}] reached its fire cap (${cur2.maxFires}) and is done.`);
        }
      }
      saveStore(loops2);
    } finally {
      this.firing.delete(sid);
    }
    const fresh = loadStore().find((l) => l.id === loop.id);
    if (fresh && fresh.status === "active" && fresh.interval.kind === "time")
      this.#arm(fresh);
  }
  async onTurnCompleted(sid, { lastText = "" } = {}) {
    const loops = loadStore();
    const dueFires = [];
    let changed = false;
    if (lastText && LOOP_COMPLETE_RE.test(lastText)) {
      const loop = mostRecentActive(loops, sid);
      if (loop) {
        loop.status = "done";
        loop.updatedAt = new Date().toISOString();
        changed = true;
        this.#disarm(loop.id);
        this.ports.sendNote(sid, `[loop ${loop.label ?? "#" + shortId(loop.id)}] finished via LOOP_COMPLETE after ${loop.fires} fire(s).`);
      }
    }
    for (const loop of loops) {
      if (loop.sessionId !== sid || loop.status !== "active" || loop.interval.kind !== "turns")
        continue;
      loop.turnsUntilNext = (loop.turnsUntilNext ?? loop.interval.n) - 1;
      changed = true;
      if (loop.turnsUntilNext <= 0) {
        loop.turnsUntilNext = 0;
        dueFires.push(loop.id);
      }
    }
    if (changed)
      saveStore(loops);
    for (const id of dueFires) {
      const fresh = loadStore().find((l) => l.id === id);
      if (fresh && fresh.status === "active" && !this.firing.has(sid))
        await this.#fire(fresh);
    }
  }
  async handleCommand(sid, rawArgs) {
    const cmd = parseLoopArgs(rawArgs);
    if (cmd.action === "invalid")
      return [`[loop] ${cmd.error}`];
    if (cmd.action === "help")
      return [HELP];
    const loops = loadStore();
    if (cmd.action === "status") {
      const loop = mostRecentActive(loops, sid) ?? findLoop(loops, sid, undefined);
      if (!loop)
        return ["No active loop in this session. Start one: /loop 5m check CI status"];
      return [this.#describe(loop)];
    }
    if (cmd.action === "list") {
      const mine = loops.filter((l) => l.sessionId === sid && (cmd.all || l.status === "active" || l.status === "paused"));
      if (!mine.length)
        return [cmd.all ? "No loops recorded for this session." : "No active loops in this session. /loop list --all shows history."];
      return [mine.map((l) => this.#describe(l)).join(`
`)];
    }
    if (cmd.action === "stop") {
      const loop = cmd.idOrLabel ? findLoop(loops, sid, cmd.idOrLabel) : mostRecentActive(loops, sid);
      if (!loop)
        return ["No matching active loop."];
      loop.status = "done";
      loop.updatedAt = new Date().toISOString();
      saveStore(loops);
      this.#disarm(loop.id);
      return [`Loop ${loop.label ?? "#" + shortId(loop.id)} stopped after ${loop.fires} fire(s).`];
    }
    if (cmd.action === "pause") {
      const loop = cmd.idOrLabel ? findLoop(loops, sid, cmd.idOrLabel) : mostRecentActive(loops, sid);
      if (!loop || loop.status !== "active")
        return ["No matching active loop to pause."];
      loop.status = "paused";
      loop.updatedAt = new Date().toISOString();
      saveStore(loops);
      this.#disarm(loop.id);
      return [`Loop ${loop.label ?? "#" + shortId(loop.id)} paused at ${loop.fires}${loop.maxFires != null ? "/" + loop.maxFires : ""} fires. /loop resume to continue.`];
    }
    if (cmd.action === "resume") {
      const loop = cmd.idOrLabel ? findLoop(loops, sid, cmd.idOrLabel) : mostRecentActive(loops, sid);
      if (!loop)
        return ["No matching loop."];
      if (loop.status === "active")
        return [`Loop ${loop.label ?? "#" + shortId(loop.id)} is already active.`];
      if (loop.status === "done" && loop.maxFires != null && loop.fires >= loop.maxFires) {
        loop.fires = 0;
      }
      loop.status = "active";
      loop.consecutiveErrors = 0;
      loop.updatedAt = new Date().toISOString();
      if (loop.interval.kind === "time")
        loop.nextRunAt = this.ports.now() + loop.interval.ms;
      else
        loop.turnsUntilNext = loop.interval.n;
      saveStore(loops);
      if (loop.interval.kind === "time")
        this.#arm(loop);
      return [`Loop ${loop.label ?? "#" + shortId(loop.id)} resumed (${describeInterval(loop.interval)}).`];
    }
    if (cmd.action === "create") {
      const twin = loops.find((l) => l.sessionId === sid && l.status === "active" && l.prompt === cmd.prompt && describeInterval(l.interval) === cmd.interval.raw);
      if (twin) {
        const twinCount = twin.maxFires != null ? `${twin.fires}/${twin.maxFires}` : String(twin.fires);
        return [`Loop ${twin.label ?? "#" + shortId(twin.id)} is already active (${describeInterval(twin.interval)}, ${twinCount} fires). /loop stop to end it.`];
      }
      if (cmd.interval.ms != null && (cmd.interval.ms < MIN_INTERVAL_MS || cmd.interval.ms > MAX_INTERVAL_MS)) {
        return [`[loop] Interval must be between ${MIN_INTERVAL_MS / 1000}s and 7d.`];
      }
      if (cmd.label && loops.some((l) => l.sessionId === sid && l.label === cmd.label && l.status === "active")) {
        return [`[loop] Label "${cmd.label}" is already active in this session.`];
      }
      const maxFires = cmd.times ?? DEFAULT_MAX_FIRES;
      const loop = newLoop({
        sessionId: sid,
        prompt: cmd.prompt,
        interval: cmd.interval,
        label: cmd.label,
        maxFires,
        immediate: cmd.immediate
      });
      if (loop.interval.kind === "time")
        loop.nextRunAt = this.ports.now() + loop.interval.ms;
      loops.push(loop);
      saveStore(loops);
      const name = loop.label ?? "#" + shortId(loop.id);
      const capText = maxFires != null ? `max ${maxFires} fires` : "runs until stopped";
      const replies = [
        `Loop ${name} set (${describeInterval(loop.interval)}, ${capText}).`,
        cmd.immediate ? "" : null
      ].filter(Boolean);
      let goalActive = false;
      try {
        goalActive = await this.ports.goalActive(sid);
      } catch {}
      let busy = false;
      try {
        busy = await this.ports.isBusy(sid);
      } catch {}
      if (cmd.immediate && cmd.interval.kind === "time" && !goalActive && !busy) {
        const fresh = loadStore().find((l) => l.id === loop.id);
        if (fresh)
          await this.#fire(fresh);
        replies.push(`First fire sent. Next due per ${describeInterval(loop.interval)}.`);
      } else if (goalActive) {
        replies.push("Deferred: an active /goal owns this session; the loop fires when the goal pauses or completes.");
      } else if (cmd.interval.kind === "turns") {
        replies.push(`Fires every ${loop.interval.n} turn(s); counting from the next completed turn.`);
      }
      if (loop.interval.kind === "time")
        this.#arm(loadStore().find((l) => l.id === loop.id));
      return replies.filter(Boolean);
    }
    return [HELP];
  }
  #describe(loop) {
    const name = loop.label ?? "#" + shortId(loop.id);
    const fireStr = loop.maxFires != null ? `${loop.fires}/${loop.maxFires}` : String(loop.fires);
    const bits = [`[${loop.status}] ${name}`, `"${loop.prompt.slice(0, 80)}${loop.prompt.length > 80 ? "..." : ""}"`, `${describeInterval(loop.interval)}`, `${fireStr} fires`];
    if (loop.status === "active" && loop.interval.kind === "time" && loop.nextRunAt) {
      const s = Math.max(0, Math.round((loop.nextRunAt - this.ports.now()) / 1000));
      bits.push(`next in ~${s}s`);
    }
    if (loop.status === "active" && loop.interval.kind === "turns") {
      bits.push(`next after ${loop.turnsUntilNext ?? loop.interval.n} more turn(s)`);
    }
    if (loop.lastError)
      bits.push(`last error: ${loop.lastError}`);
    return bits.join(" | ");
  }
  toolStop(sid, idOrLabel) {
    const loops = loadStore();
    const loop = idOrLabel ? findLoop(loops, sid, idOrLabel) : mostRecentActive(loops, sid);
    if (!loop)
      return "No matching active loop to stop.";
    loop.status = "done";
    loop.updatedAt = new Date().toISOString();
    saveStore(loops);
    this.#disarm(loop.id);
    return `Stopped loop ${loop.label ?? "#" + shortId(loop.id)} after ${loop.fires} fire(s).`;
  }
  forgetSession(sid) {
    const loops = loadStore();
    const keep = loops.filter((l) => l.sessionId !== sid);
    for (const l of loops)
      if (l.sessionId === sid)
        this.#disarm(l.id);
    if (keep.length !== loops.length)
      saveStore(keep);
  }
}
var HELP = `usage:
  /loop <interval> <prompt>            repeat a prompt on a cadence (fires once immediately)
                                         intervals: 30s 5m 2h 1d 1h30m | turns: 3t
  /loop --label ci --times 20 5m ...   optional label and fire cap \u2014 no cap by default;
                                         runs until LOOP_COMPLETE or /loop stop
  /loop                                show most recent loop in this session
  /loop list [--all]                   list loops
  /loop stop | pause | resume [id|label]
examples:
  /loop 5m check my PR, address review comments, fix failing CI
  /loop 1t triage new inbox items`;

// index.js
var log = (...a) => console.error("[opencode-loop]", ...a);
var NEUTRAL = "(loop command handled by the loop plugin)";
var loop_default = {
  id: "opencode-loop",
  setup: async (ctx) => {
    if (globalThis.__opencode_loop_active)
      return;
    const trackers = new Map;
    const busy = new Map;
    const seenInbox = new Set;
    let loadGoal = null;
    for (const cand of ["../goal/lib/state.js", "../goal-fresh/lib/state.js", "../opencode-goal/lib/state.js"]) {
      try {
        ({ loadGoal } = await import(cand));
        break;
      } catch {}
    }
    const ports = {
      now: Date.now,
      log,
      async sendWork(sid, text) {
        try {
          await ctx.session.prompt({ sessionID: sid, text });
          return true;
        } catch (err) {
          log("sendWork failed:", err?.message ?? err);
          return false;
        }
      },
      async sendNote(sid, text) {
        try {
          await ctx.session.synthetic({ sessionID: sid, text, description: "loop" });
        } catch {
          try {
            await ctx.session.prompt({ sessionID: sid, text });
          } catch {}
        }
      },
      async isBusy(sid) {
        return busy.get(sid) ?? false;
      },
      async goalActive(sid) {
        if (!loadGoal)
          return false;
        try {
          return loadGoal(sid)?.status === "active";
        } catch {
          return false;
        }
      }
    };
    const engine = new LoopEngine(ports);
    const seenEvent = (id) => {
      if (id == null)
        return false;
      if (seenInbox.has(id))
        return true;
      if (seenInbox.size >= 500)
        seenInbox.delete(seenInbox.values().next().value);
      seenInbox.add(id);
      return false;
    };
    async function handleEvent(evt) {
      const type = String(evt?.type ?? "");
      const d = evt?.data ?? {};
      const p = evt?.properties ?? {};
      const sid = d.sessionID ?? p.sessionID;
      if (type === "session.execution.started") {
        if (sid)
          busy.set(sid, true);
        return;
      }
      if (type === "session.text.ended") {
        const text = d.text ?? d.part?.text;
        if (sid && typeof text === "string" && text) {
          const t = trackers.get(sid) ?? { lastText: "", saw: false };
          t.lastText = text;
          t.saw = true;
          trackers.set(sid, t);
        }
        return;
      }
      if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
        if (sid) {
          const t = trackers.get(sid) ?? { lastText: "", saw: false };
          t.saw = true;
          trackers.set(sid, t);
        }
        return;
      }
      if (type === "session.idle" || type === "session.execution.succeeded") {
        if (!sid)
          return;
        busy.set(sid, false);
        const t = trackers.get(sid);
        trackers.delete(sid);
        if (t?.saw)
          await engine.onTurnCompleted(sid, { lastText: t.lastText });
        return;
      }
      if (type === "session.execution.failed" || type === "session.execution.interrupted") {
        if (!sid)
          return;
        busy.set(sid, false);
        await engine.onTurnCompleted(sid, { lastText: "" });
        return;
      }
      if (type === "session.deleted") {
        if (sid) {
          trackers.delete(sid);
          busy.delete(sid);
          engine.forgetSession(sid);
        }
        return;
      }
      if (type === "session.inbox.enqueued" || type === "session.inbox.delivered") {
        const text = String(d.text ?? d.message?.text ?? "").trim();
        if (!sid || text !== "/loop" && !text.startsWith("/loop "))
          return;
        if (seenEvent(evt?.id))
          return;
        const replies = await engine.handleCommand(sid, text.slice(5));
        for (const r of replies)
          await ports.sendNote(sid, r);
      }
    }
    const stream = ctx.event.subscribe();
    (async () => {
      for await (const evt of stream) {
        try {
          await handleEvent(evt);
        } catch {}
      }
    })();
    await ctx.session.hook("context", async (sc) => {
      try {
        const sid = sc?.sessionID;
        if (!sid)
          return;
        const msgs = Array.isArray(sc.messages) ? sc.messages : [];
        for (const m of msgs) {
          if (m?.role !== "user")
            continue;
          const content = m.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((pt) => pt?.type === "text").map((pt) => pt.text ?? "").join("") : "";
          const t = text.trim();
          if (t === "/loop" || t.startsWith("/loop ")) {
            if (typeof content === "string")
              m.content = NEUTRAL;
            else if (Array.isArray(content)) {
              for (const pt of content)
                if (pt?.type === "text")
                  pt.text = NEUTRAL;
            }
          }
        }
      } catch {}
    });
    await ctx.tool.transform((draft) => draft.add({
      name: "loop_stop",
      description: "Stop an active /loop in this session (most recent one, or match by label/id). Use when the recurring task is finished.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Loop id prefix or label; omit for the most recent loop" }
        }
      },
      execute: async (args, tctx) => {
        const sid = tctx?.sessionID ?? tctx?.sessionId;
        return engine.toolStop(sid, args?.id);
      }
    }));
    engine.armAll();
    globalThis.__opencode_loop_active = true;
  }
};
export {
  loop_default as default
};
