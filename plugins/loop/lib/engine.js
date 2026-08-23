// engine — loop scheduling brain. Adapters supply ports; this file owns policy.
// Ports: now(), log(...), sendWork(sid,text)->bool, sendNote(sid,text),
//        isBusy(sid)->bool, goalActive(sid)->bool
import {
  loadStore, saveStore, newLoop, findLoop, mostRecentActive,
  shortId, describeInterval, nextDelayMs,
  MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_MAX_FIRES,
  BUSY_BACKOFF_INITIAL_MS, BUSY_BACKOFF_MAX_MS,
} from "./store.js";
import { parseLoopArgs } from "./parse.js";

const LOOP_COMPLETE_RE = /^LOOP_COMPLETE\s*$/m;

export class LoopEngine {
  constructor(ports) {
    this.ports = ports;
    this.timers = new Map(); // loopId -> timeout
    this.firing = new Set(); // sessionIds with a fire in flight
  }

  // ---- persistence + timers ----

  armAll() {
    const loops = loadStore();
    const now = this.ports.now();
    for (const loop of loops) {
      if (loop.status !== "active" || loop.interval.kind !== "time") continue;
      const due = loop.nextRunAt ?? now;
      if (now - due > loop.interval.ms) {
        // Missed while the process was down: fire once now, then resume cadence.
        void this.tick(loop.id);
      } else {
        this.#arm(loop);
      }
    }
  }

  #arm(loop) {
    if (this.timers.has(loop.id)) clearTimeout(this.timers.get(loop.id));
    const now = this.ports.now();
    const delay = Math.max(0, Math.min((loop.nextRunAt ?? now) - now, 2 ** 31 - 1));
    const t = setTimeout(() => void this.tick(loop.id), delay);
    if (typeof t.unref === "function") t.unref();
    this.timers.set(loop.id, t);
  }

  #disarm(loopId) {
    const t = this.timers.get(loopId);
    if (t) clearTimeout(t);
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

    // An active /goal owns the session; loops defer.
    let goalActive = false;
    try { goalActive = await this.ports.goalActive(sid); } catch {}
    if (goalActive) {
      loop.nextRunAt = this.ports.now() + (loop.interval.kind === "time" ? loop.interval.ms : 60_000);
      saveStore(loops);
      this.#arm(loop);
      return;
    }

    let busy = false;
    try { busy = await this.ports.isBusy(sid); } catch {}

    if (busy || this.firing.has(sid)) {
      const backoff = Math.min(BUSY_BACKOFF_MAX_MS, (loop.backoffMs ?? BUSY_BACKOFF_INITIAL_MS) * 2);
      loop.backoffMs = backoff;
      loop.nextRunAt = this.ports.now() + backoff;
      saveStore(loops);
      this.#arm(loop);
      return;
    }
    if (loop.interval.kind === "turns") {
      // Turn loops only fire from onTurnCompleted; a timer tick here means resume.
      loop.turnsUntilNext = loop.interval.n;
      saveStore(loops);
      return;
    }
    await this.#fire(loop);
  }

  async #fire(loop) {
    const sid = loop.sessionId;
    this.firing.add(sid);
    try {
      // Re-read under the fire lock so concurrent state changes are never clobbered.
      const loops = loadStore();
      const cur = loops.find((l) => l.id === loop.id);
      if (!cur || cur.status !== "active") return;
      cur.backoffMs = BUSY_BACKOFF_INITIAL_MS;
      cur.fires += 1;
      cur.lastRunAt = new Date().toISOString();
      if (cur.interval.kind === "time") {
        cur.nextRunAt = this.ports.now() + nextDelayMs(cur);
      } else {
        cur.turnsUntilNext = cur.interval.n;
      }
      const finishAfterFire = cur.maxFires != null && cur.fires >= cur.maxFires;
      if (finishAfterFire) cur.status = "done";
      saveStore(loops);

      const name = cur.label ?? `#${shortId(cur.id)}`;
      const fireCount = cur.maxFires != null ? `${cur.fires}/${cur.maxFires}` : String(cur.fires);
      const text =
        `[loop ${name} fire ${fireCount}] ${cur.prompt}\n\n` +
        `(When this recurring task is finished or moot, end your reply with a line containing exactly: LOOP_COMPLETE)`;
      let sent = false;
      try { sent = await this.ports.sendWork(sid, text); } catch (err) { /* recorded below */ }

      const loops2 = loadStore();
      const cur2 = loops2.find((l) => l.id === loop.id);
      if (!cur2) return;
      if (!sent) {
        cur2.consecutiveErrors = (cur2.consecutiveErrors ?? 0) + 1;
        cur2.lastError = "could not inject turn";
        if (cur2.consecutiveErrors >= 3 && cur2.status === "active") {
          cur2.status = "error";
          void this.ports.sendNote(sid, `[loop ${name}] stopped: injection failed ${cur2.consecutiveErrors} times.`);
        }
        if (cur2.interval.kind === "time" && cur2.status === "active") {
          cur2.nextRunAt = this.ports.now() + cur2.interval.ms;
        }
      } else {
        cur2.consecutiveErrors = 0;
        if (finishAfterFire && cur2.status === "done") {
          void this.ports.sendNote(sid, `[loop ${name}] reached its fire cap (${cur2.maxFires}) and is done.`);
        }
      }
      saveStore(loops2);
    } finally {
      this.firing.delete(sid);
    }
    const fresh = loadStore().find((l) => l.id === loop.id);
    if (fresh && fresh.status === "active" && fresh.interval.kind === "time") this.#arm(fresh);
  }

  // ---- turn boundary ----

  // Adapter calls when a turn finishes: drives turn-cadence loops and the sentinel.
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
        void this.ports.sendNote(sid, `[loop ${loop.label ?? "#" + shortId(loop.id)}] finished via LOOP_COMPLETE after ${loop.fires} fire(s).`);
      }
    }

    for (const loop of loops) {
      if (loop.sessionId !== sid || loop.status !== "active" || loop.interval.kind !== "turns") continue;
      loop.turnsUntilNext = (loop.turnsUntilNext ?? loop.interval.n) - 1;
      changed = true;
      if (loop.turnsUntilNext <= 0) {
        loop.turnsUntilNext = 0;
        dueFires.push(loop.id);
      }
    }
    if (changed) saveStore(loops);

    for (const id of dueFires) {
      const fresh = loadStore().find((l) => l.id === id);
      if (fresh && fresh.status === "active" && !this.firing.has(sid)) await this.#fire(fresh);
    }
  }

  // ---- commands ----

  async handleCommand(sid, rawArgs) {
    const cmd = parseLoopArgs(rawArgs);
    if (cmd.action === "invalid") return [`[loop] ${cmd.error}`];
    if (cmd.action === "help") return [HELP];

    const loops = loadStore();

    if (cmd.action === "status") {
      const loop = mostRecentActive(loops, sid) ?? findLoop(loops, sid, undefined);
      if (!loop) return ["No active loop in this session. Start one: /loop 5m check CI status"];
      return [this.#describe(loop)];
    }

    if (cmd.action === "list") {
      const mine = loops.filter((l) => l.sessionId === sid && (cmd.all || l.status === "active" || l.status === "paused"));
      if (!mine.length) return [cmd.all ? "No loops recorded for this session." : "No active loops in this session. /loop list --all shows history."];
      return [mine.map((l) => this.#describe(l)).join("\n")];
    }

    if (cmd.action === "stop") {
      const loop = cmd.idOrLabel ? findLoop(loops, sid, cmd.idOrLabel) : mostRecentActive(loops, sid);
      if (!loop) return ["No matching active loop."];
      loop.status = "done";
      loop.updatedAt = new Date().toISOString();
      saveStore(loops);
      this.#disarm(loop.id);
      return [`Loop ${loop.label ?? "#" + shortId(loop.id)} stopped after ${loop.fires} fire(s).`];
    }

    if (cmd.action === "pause") {
      const loop = cmd.idOrLabel ? findLoop(loops, sid, cmd.idOrLabel) : mostRecentActive(loops, sid);
      if (!loop || loop.status !== "active") return ["No matching active loop to pause."];
      loop.status = "paused";
      loop.updatedAt = new Date().toISOString();
      saveStore(loops);
      this.#disarm(loop.id);
      return [`Loop ${loop.label ?? "#" + shortId(loop.id)} paused at ${loop.fires}${loop.maxFires != null ? "/" + loop.maxFires : ""} fires. /loop resume to continue.`];
    }

    if (cmd.action === "resume") {
      const loop = cmd.idOrLabel ? findLoop(loops, sid, cmd.idOrLabel) : mostRecentActive(loops, sid);
      if (!loop) return ["No matching loop."];
      if (loop.status === "active") return [`Loop ${loop.label ?? "#" + shortId(loop.id)} is already active.`];
      if (loop.status === "done" && loop.maxFires != null && loop.fires >= loop.maxFires) {
        loop.fires = 0; // resuming a capped loop grants a fresh run
      }
      loop.status = "active";
      loop.consecutiveErrors = 0;
      loop.updatedAt = new Date().toISOString();
      if (loop.interval.kind === "time") loop.nextRunAt = this.ports.now() + loop.interval.ms;
      else loop.turnsUntilNext = loop.interval.n;
      saveStore(loops);
      if (loop.interval.kind === "time") this.#arm(loop);
      return [`Loop ${loop.label ?? "#" + shortId(loop.id)} resumed (${describeInterval(loop.interval)}).`];
    }

    if (cmd.action === "create") {
      // Idempotent create: an identical active loop in this session is returned, not duplicated.
      const twin = loops.find(
        (l) => l.sessionId === sid && l.status === "active" && l.prompt === cmd.prompt && describeInterval(l.interval) === cmd.interval.raw,
      );
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
        immediate: cmd.immediate,
      });
      if (loop.interval.kind === "time") loop.nextRunAt = this.ports.now() + loop.interval.ms;
      loops.push(loop);
      saveStore(loops);

      const name = loop.label ?? "#" + shortId(loop.id);
      const capText = maxFires != null ? `max ${maxFires} fires` : "runs until stopped";
      const replies = [
        `Loop ${name} set (${describeInterval(loop.interval)}, ${capText}).`,
        cmd.immediate ? "" : null,
      ].filter(Boolean);

      let goalActive = false;
      try { goalActive = await this.ports.goalActive(sid); } catch {}
      let busy = false;
      try { busy = await this.ports.isBusy(sid); } catch {}
      // Immediate-first applies to time cadence; turn loops count turns, starting now.
      if (cmd.immediate && cmd.interval.kind === "time" && !goalActive && !busy) {
        const fresh = loadStore().find((l) => l.id === loop.id);
        if (fresh) await this.#fire(fresh);
        replies.push(`First fire sent. Next due per ${describeInterval(loop.interval)}.`);
      } else if (goalActive) {
        replies.push("Deferred: an active /goal owns this session; the loop fires when the goal pauses or completes.");
      } else if (cmd.interval.kind === "turns") {
        replies.push(`Fires every ${loop.interval.n} turn(s); counting from the next completed turn.`);
      }
      if (loop.interval.kind === "time") this.#arm(loadStore().find((l) => l.id === loop.id));
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
      bits.push(`next after ${(loop.turnsUntilNext ?? loop.interval.n)} more turn(s)`);
    }
    if (loop.lastError) bits.push(`last error: ${loop.lastError}`);
    return bits.join(" | ");
  }

  toolStop(sid, idOrLabel) {
    const loops = loadStore();
    const loop = idOrLabel ? findLoop(loops, sid, idOrLabel) : mostRecentActive(loops, sid);
    if (!loop) return "No matching active loop to stop.";
    loop.status = "done";
    loop.updatedAt = new Date().toISOString();
    saveStore(loops);
    this.#disarm(loop.id);
    return `Stopped loop ${loop.label ?? "#" + shortId(loop.id)} after ${loop.fires} fire(s).`;
  }

  forgetSession(sid) {
    const loops = loadStore();
    const keep = loops.filter((l) => l.sessionId !== sid);
    for (const l of loops) if (l.sessionId === sid) this.#disarm(l.id);
    if (keep.length !== loops.length) saveStore(keep);
  }
}

export const HELP = `usage:
  /loop <interval> <prompt>            repeat a prompt on a cadence (fires once immediately)
                                         intervals: 30s 5m 2h 1d 1h30m | turns: 3t
  /loop --label ci --times 20 5m ...   optional label and fire cap — no cap by default;
                                         runs until LOOP_COMPLETE or /loop stop
  /loop                                show most recent loop in this session
  /loop list [--all]                   list loops
  /loop stop | pause | resume [id|label]
examples:
  /loop 5m check my PR, address review comments, fix failing CI
  /loop 1t triage new inbox items`;
