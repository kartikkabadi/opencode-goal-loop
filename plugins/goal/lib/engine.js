// engine — runtime-agnostic /goal brain. Adapters supply ports; this file owns policy.
//
// Ports:
//   now() -> number                       ms timestamp
//   log(...)                              debug logging (adapter decides where)
//   sendWork(sid, text) -> Promise<bool>  inject a real user turn (the work prompt)
//   sendNote(sid, text) -> Promise<void>  inject a visible status note
//   getUsage(sid) -> Promise<{input,output}|null>  cumulative session token totals
//   getCwd() -> string                    working dir for quality gates
import { createHash } from "node:crypto";
import { loadGoal, saveGoal, clearGoal, newGoal } from "./state.js";
import { parseGoalArgs } from "./parse.js";
import { systemBlock, continuationPrompt, gateFailurePrompt, statusText, HELP, startedNote } from "./prompts.js";
import { runGates, makeGate } from "./gates.js";

const RETRYABLE = /rate.?limit|429|timeout|timed out|network|econn|socket hang up|overloaded|502|503|529|fetch failed/i;
const NO_PROGRESS_LIMIT = 3;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX = 3;
const IDLE_BURST_MS = 1200; // session.idle + session.status + execution.* fire together; collapse the burst
const SEND_RACE_MS = 3000; // idles within 3s of an injection are echoes of the pre-turn state

export class GoalEngine {
  constructor(ports) {
    this.ports = ports;
    this.cache = new Map(); // sid -> {cycles:[{hash,tools}], retries, lastCycleHadGates}
  }

  meta(sid) {
    let m = this.cache.get(sid);
    if (!m) this.cache.set(sid, (m = { cycles: [], retries: 0, lastCycleHadGates: false, noToolStreak: 0, lastSendAt: 0, lastIdleAt: 0, sending: null }));
    return m;
  }

  // Serialize decision+send per session; collapse event-burst echoes.
  async #locked(sid, fn) {
    const meta = this.meta(sid);
    const t = this.ports.now();
    if (t - meta.lastIdleAt < IDLE_BURST_MS) return { action: "noop" };
    if (t - meta.lastSendAt < SEND_RACE_MS) return { action: "noop" };
    while (meta.sending) await meta.sending.catch(() => {});
    const job = fn()
      .catch((err) => {
        this.ports.log("onIdle error:", err?.message ?? err);
        return { action: "noop" };
      })
      .finally(() => {
        meta.lastIdleAt = this.ports.now();
        if (meta.sending === job) meta.sending = null;
      });
    meta.sending = job;
    return job;
  }

  async #continueGoal(sid, goal, prompt) {
    goal.iteration += 1;
    saveGoal(sid, goal);
    const sent = await this.ports.sendWork(sid, prompt);
    if (sent) {
      goal.pendingContinuation = `cont:${goal.iteration}:${Date.now()}`;
      saveGoal(sid, goal);
      this.meta(sid).lastSendAt = this.ports.now();
      return true;
    }
    return false;
  }

  async ensure(sid) {
    return loadGoal(sid);
  }

  systemBlock(sid) {
    const goal = loadGoal(sid);
    if (!goal || goal.status === "complete") return null;
    return systemBlock(goal);
  }

  // Called whenever a real (non-command) user message is observed on the session.
  noteUserActivity(sid) {
    const goal = loadGoal(sid);
    if (!goal) return;
    if (goal.pendingContinuation) {
      goal.pendingContinuation = null;
      saveGoal(sid, goal);
    }
  }

  async refreshUsage(sid, goal) {
    try {
      const u = await this.ports.getUsage(sid);
      if (u && goal.baselineTokens != null) {
        goal.tokensUsed = Math.max(0, u.input + u.output - goal.baselineTokens);
      } else if (u && goal.baselineTokens == null && goal.startedAt) {
        // No baseline captured (e.g. after restart): approximate from total minus unknown.
        goal.baselineTokens = goal.baselineTokens ?? 0;
        goal.tokensUsed = u.input + u.output;
      }
    } catch (err) {
      this.ports.log("getUsage failed:", err?.message ?? err);
    }
  }

  async handleCommand(sid, rawArgs) {
    const cmd = parseGoalArgs(rawArgs);
    if (cmd.action === "invalid") return [`[goal] ${cmd.error}\n\n${HELP}`];
    if (cmd.action === "help") return [HELP];

    if (cmd.action === "status") {
      const goal = await this.ensure(sid);
      return [goal ? statusText(goal) : "No goal set. Start one with /goal <objective>."];
    }

    if (cmd.action === "clear") {
      const had = await this.ensure(sid);
      clearGoal(sid);
      this.cache.delete(sid);
      return [had ? `Goal cleared: ${had.text.slice(0, 80)}` : "No goal set."];
    }

    if (cmd.action === "pause") {
      const goal = await this.ensure(sid);
      if (!goal) return ["No goal set."];
      if (goal.status !== "active") return [`Goal is ${goal.status}; nothing to pause.`];
      goal.status = "paused";
      goal.pauseReason = "paused by user";
      saveGoal(sid, goal);
      return [`Goal paused. /goal resume to continue (${goal.iteration} continuations used).`];
    }

    if (cmd.action === "resume") {
      const goal = await this.ensure(sid);
      if (!goal) return ["No goal set."];
      if (goal.status === "active") return ["Goal is already active."];
      if (goal.status === "complete") return ["Goal already completed. Set a new one with /goal <objective>."];
      await this.refreshUsage(sid, goal);
      if (goal.tokenBudget != null && goal.tokensUsed != null && goal.tokensUsed >= goal.tokenBudget) {
        goal.status = "budget_limited";
        saveGoal(sid, goal);
        return [`Token budget exhausted (~${goal.tokensUsed}). Raise it first: /goal edit --tokens <bigger> ${goal.text.slice(0, 60)}`];
      }
      goal.status = "active";
      goal.pauseReason = null;
      goal.lastError = null;
      this.meta(sid).retries = 0;
      this.meta(sid).cycles = [];
      saveGoal(sid, goal);
      const sent = await this.ports.sendWork(sid, continuationPrompt(goal, 1));
      if (sent) {
        goal.pendingContinuation = `resume:${Date.now()}`;
        saveGoal(sid, goal);
        this.meta(sid).lastSendAt = this.ports.now();
      }
      return ["Goal resumed — working."];
    }

    if (cmd.action === "edit") {
      const goal = await this.ensure(sid);
      if (!goal) return ["No goal set to edit."];
      if (cmd.text) goal.text = cmd.text;
      if (cmd.contract && (cmd.contract.verify || cmd.contract.constraints || cmd.contract.boundaries || cmd.contract.stopWhen)) {
        goal.contract = cmd.contract;
      }
      if (cmd.tokenBudget != null) goal.tokenBudget = cmd.tokenBudget;
      if (cmd.turnBudget != null) goal.turnBudget = cmd.turnBudget;
      await this.refreshUsage(sid, goal);
      if (goal.status === "budget_limited" && (goal.tokenBudget == null || (goal.tokensUsed ?? 0) < goal.tokenBudget)) {
        goal.status = "active";
      }
      saveGoal(sid, goal);
      return [`Goal updated.\n\n${statusText(goal)}`];
    }

    if (cmd.action === "gate") {
      const goal = await this.ensure(sid);
      if (!goal) return ["No goal set — gates attach to a goal. Start one first."];
      if (cmd.op === "list") {
        if (!goal.gates.length) return ["No gates. Add one: /goal gate add <shell command>"];
        return [goal.gates.map((g, i) => `${i + 1}. $ ${g.cmd} — last exit ${g.lastExit ?? "n/a"}, retries left ${g.retriesLeft}`).join("\n")];
      }
      if (cmd.op === "add") {
        goal.gates.push(makeGate(cmd.cmd));
        saveGoal(sid, goal);
        return [`Gate added: ${cmd.cmd}\nAll gates must exit 0 before the goal can complete.`];
      }
      if (cmd.op === "remove") {
        if (!(cmd.index >= 1 && cmd.index <= goal.gates.length)) return [`Gate #${cmd.index} does not exist.`];
        const [gone] = goal.gates.splice(cmd.index - 1, 1);
        saveGoal(sid, goal);
        return [`Gate removed: ${gone.cmd}`];
      }
      if (cmd.op === "clear") {
        goal.gates = [];
        saveGoal(sid, goal);
        return ["All gates removed."];
      }
      return [`Unknown gate subcommand.\n\n${HELP}`];
    }

    if (cmd.action === "start") {
      const prev = await this.ensure(sid);
      const goal = newGoal({
        text: cmd.text,
        contract: cmd.contract,
        tokenBudget: cmd.tokenBudget,
        turnBudget: cmd.turnBudget,
      });
      saveGoal(sid, goal);
      this.cache.set(sid, { cycles: [], retries: 0, lastCycleHadGates: false });
      // Capture baseline AFTER the goal note so baseline excludes prior turns only.
      await this.captureBaseline(sid, goal);
      const replies = [startedNote(goal)];
      if (prev && prev.status !== "complete") replies.unshift(`(Replaced previous ${prev.status} goal.)`);
      const sent = await this.ports.sendWork(sid, continuationPrompt(goal, 1));
      if (sent) {
        goal.pendingContinuation = `start:${Date.now()}`;
        saveGoal(sid, goal);
        this.meta(sid).lastSendAt = this.ports.now();
      } else {
        replies.push("[goal] Could not inject the first work turn — the reactor will retry on the next idle event.");
      }
      return replies;
    }

    return [HELP];
  }

  async captureBaseline(sid, goal) {
    try {
      const u = await this.ports.getUsage(sid);
      if (u) {
        goal.baselineTokens = u.input + u.output;
        goal.tokensUsed = 0;
      }
    } catch {}
  }

  // Tool entry: model claims the goal is done.
  async complete(sid, evidence) {
    const goal = await this.ensure(sid);
    if (!goal) return { ok: false, text: "No active goal — goal_complete rejected." };
    if (goal.status !== "active") return { ok: false, text: `Goal is ${goal.status}, not active — goal_complete rejected.` };
    const ev = String(evidence ?? "").trim();
    if (!ev) return { ok: false, text: "Rejected: goal_complete requires an evidence argument (what proves the objective is met)." };
    goal.status = "complete";
    goal.completedAt = new Date().toISOString();
    goal.completionEvidence = ev.slice(0, 4000);
    saveGoal(sid, goal);
    await this.ports.sendNote(sid, `[goal] Achieved. Evidence: ${ev.slice(0, 500)}`);
    return { ok: true, text: "Goal marked complete. Summarize the outcome for the user in your reply." };
  }

  interrupt(sid, reason = "interrupted") {
    const goal = loadGoal(sid);
    if (!goal || goal.status !== "active") return;
    goal.status = "paused";
    goal.pauseReason = reason;
    goal.pendingContinuation = null;
    saveGoal(sid, goal);
    void this.ports.sendNote(sid, `[goal] Paused (${reason}). /goal resume to continue.`);
  }

  forgetSession(sid) {
    clearGoal(sid);
    this.cache.delete(sid);
  }

  // Adapter maps turn-finished/idle signals here.
  async onIdle(sid, input = {}) {
    return this.#locked(sid, () => this.#onIdleInner(sid, input));
  }

  // input: {lastText, hadToolCall, error, interrupted, sawActivity}
  // Returns {action}: "continued" | "retry" | "paused" | "noop"
  async #onIdleInner(sid, { lastText = "", hadToolCall = false, error = null, interrupted = false, sawActivity = true } = {}) {
    const goal = await this.ensure(sid);
    if (!goal) return { action: "noop" };

    // A completed turn always emits text or tool events. An idle with zero
    // activity is a ghost (shutdown echo, pre-turn stray) — never evaluate it.
    if (!sawActivity && !error && !interrupted) return { action: "noop" };

    if (goal.pendingContinuation) {
      // A continuation was sent and this is its completion (or a stale marker post-restart).
      goal.pendingContinuation = null;
      saveGoal(sid, goal);
      if (goal.status !== "active") return { action: "noop" };
    } else if (goal.status !== "active") {
      return { action: "noop" };
    }

    if (interrupted) {
      this.interrupt(sid, "interrupted");
      return { action: "paused" };
    }

    await this.refreshUsage(sid, goal);

    const meta = this.meta(sid);

    if (error) {
      const es = String(error).slice(0, 300);
      if (RETRYABLE.test(es) && meta.retries < RETRY_MAX) {
        meta.retries += 1;
        const delayMs = RETRY_BASE_MS * 2 ** (meta.retries - 1);
        saveGoal(sid, goal);
        await this.ports.sendNote(sid, `[goal] Retryable error (${es}) — retry ${meta.retries}/${RETRY_MAX} in ${Math.round(delayMs / 1000)}s.`);
        return { action: "retry", delayMs };
      }
      goal.status = "blocked";
      goal.lastError = es;
      saveGoal(sid, goal);
      await this.ports.sendNote(sid, `[goal] Blocked by error: ${es}\nFix the cause, then /goal resume.`);
      return { action: "paused" };
    }
    meta.retries = 0;

    // Anti-spin: a continuation cycle with zero tool activity means the model
    // narrated instead of worked. Nudge once with a must-act prompt; pause on
    // the second consecutive offense rather than burning turns forever.
    let nudgeNext = false;
    if (goal.iteration > 0 && !hadToolCall && !meta.lastCycleHadGates) {
      meta.noToolStreak += 1;
      if (meta.noToolStreak >= 2) {
        goal.status = "paused";
        goal.pauseReason = "continuations produced no tool activity (anti-spin)";
        saveGoal(sid, goal);
        await this.ports.sendNote(sid, `[goal] Paused: automatic turns keep making no tool calls. Work manually or /goal resume.`);
        return { action: "paused" };
      }
      nudgeNext = true;
    } else {
      meta.noToolStreak = 0;
    }

    // No-progress detection on response content. Identical text is only damning
    // when the turn also did nothing — a model grinding with real tool calls
    // may legitimately end every turn with the same status line.
    const hash = createHash("sha1").update(String(lastText ?? "")).digest("hex").slice(0, 12);
    const last = meta.cycles[meta.cycles.length - 1];
    if (last && last.hash === hash) {
      meta.cycles.push({ hash, tools: hadToolCall });
      const streak = meta.cycles.filter((c) => c.hash === hash);
      if (!hadToolCall && streak.length >= NO_PROGRESS_LIMIT) {
        goal.status = "paused";
        goal.pauseReason = `identical response ${NO_PROGRESS_LIMIT} turns in a row`;
        saveGoal(sid, goal);
        await this.ports.sendNote(sid, `[goal] Paused: no change in output across ${NO_PROGRESS_LIMIT} continuations. Adjust the approach, then /goal resume.`);
        return { action: "paused" };
      }
    } else {
      meta.cycles = [{ hash, tools: hadToolCall }];
    }

    // Budgets.
    if (goal.tokenBudget != null && goal.tokensUsed != null && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited";
      saveGoal(sid, goal);
      await this.ports.sendNote(
        sid,
        `[goal] Token budget reached (~${goal.tokensUsed}/${goal.tokenBudget}). Stop substantive work; summarize progress, blockers, and the next step.\n/goal resume won't help until you raise the budget: /goal edit --tokens <bigger>.`,
      );
      return { action: "paused" };
    }
    if (goal.turnBudget != null && goal.iteration >= goal.turnBudget) {
      goal.status = "budget_limited";
      saveGoal(sid, goal);
      await this.ports.sendNote(
        sid,
        `[goal] Turn budget reached (${goal.iteration}/${goal.turnBudget}). Summarize progress and blockers.\n/goal resume grants ${goal.turnBudget} more continuations.`,
      );
      return { action: "paused" };
    }

    // Quality gates run before any further continuation.
    let prompt = continuationPrompt(goal, goal.iteration + 1);
    if (goal.gates.length) {
      const res = runGates(goal.gates, this.ports.getCwd());
      saveGoal(sid, goal); // gates recorded exit codes/fingerprints
      if (!res.ok) {
        const exhausted = goal.gates.some((g) => g.retriesLeft < 0);
        if (exhausted) {
          goal.status = "paused";
          goal.pauseReason = "quality gate kept failing";
          saveGoal(sid, goal);
          await this.ports.sendNote(sid, `[goal] Paused: a gate exhausted its retries. Fix it manually, remove the gate (/goal gate remove <n>), or /goal resume.`);
          return { action: "paused" };
        }
        meta.lastCycleHadGates = true;
        const sent = await this.#continueGoal(sid, goal, gateFailurePrompt(goal, res.results));
        return { action: sent ? "continued" : "noop" };
      }
    }

    meta.lastCycleHadGates = false;
    if (nudgeNext) {
      prompt +=
        "\n\nYour last automatic turn made no tool calls. This turn MUST do concrete work: read, run, or change real files — or call goal_complete / reply BLOCKED:. Do not just narrate.";
    }
    const sent = await this.#continueGoal(sid, goal, prompt);
    return { action: sent ? "continued" : "noop" };
  }
}
