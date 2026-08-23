// @bun
// lib/engine.js
import { createHash as createHash2 } from "crypto";

// lib/state.js
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
var STATE_VERSION = 1;
var STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"];
var STATUS_ALIASES = { usage_limited: "budget_limited" };
function safeSessionID(sid) {
  const s = String(sid ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return s || "unknown";
}
function stateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "goal-loop", "goal");
}
function sidecarPath(sid) {
  return join(stateDir(), `${safeSessionID(sid)}.json`);
}
function newGoal({ text, contract, tokenBudget = null, turnBudget = null }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    version: STATE_VERSION,
    text,
    contract,
    status: "active",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    completionEvidence: null,
    pauseReason: null,
    iteration: 0,
    turnBudget,
    tokenBudget,
    baselineTokens: null,
    tokensUsed: null,
    lastError: null,
    gates: []
  };
}
function normalizeStatus(s) {
  const key = String(s ?? "").toLowerCase();
  return STATUS_ALIASES[key] ?? (STATUSES.includes(key) ? key : "paused");
}
function normalizeGoal(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || typeof raw.text !== "string")
    return null;
  const g = raw;
  g.status = normalizeStatus(g.status);
  if (g.status === "complete")
    g.completedAt ||= g.completedAt ?? null;
  g.iteration = Number.isFinite(g.iteration) ? g.iteration : 0;
  g.turnBudget = Number.isFinite(g.turnBudget) ? g.turnBudget : null;
  g.tokenBudget = Number.isFinite(g.tokenBudget) ? g.tokenBudget : null;
  g.baselineTokens = Number.isFinite(g.baselineTokens) ? g.baselineTokens : null;
  g.tokensUsed = Number.isFinite(g.tokensUsed) ? g.tokensUsed : null;
  g.contract = g.contract && typeof g.contract === "object" ? g.contract : { verify: null, constraints: null, boundaries: null, stopWhen: null };
  g.gates = Array.isArray(g.gates) ? g.gates : [];
  g.version = STATE_VERSION;
  return g;
}
function loadGoal(sid) {
  const p = sidecarPath(sid);
  if (!existsSync(p))
    return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return normalizeGoal(parsed.goal ?? parsed);
  } catch (err) {
    try {
      renameSync(p, `${p}.corrupt`);
    } catch {}
    return null;
  }
}
function saveGoal(sid, goal) {
  const p = sidecarPath(sid);
  mkdirSync(dirname7(p), { recursive: true });
  goal.updatedAt = new Date().toISOString();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, goal }, null, 2));
  renameSync(tmp, p);
}
function clearGoal(sid) {
  const p = sidecarPath(sid);
  try {
    unlinkSync(p);
  } catch {}
}
function dirname7(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}

// lib/parse.js
var FIELD_PREFIXES = [
  ["verify:", "verify"],
  ["verified by:", "verify"],
  ["verification:", "verify"],
  ["constraints:", "constraints"],
  ["preserve:", "constraints"],
  ["constraint:", "constraints"],
  ["boundaries:", "boundaries"],
  ["boundary:", "boundaries"],
  ["scope:", "boundaries"],
  ["stop when:", "stopWhen"],
  ["stop_when:", "stopWhen"],
  ["blocked:", "stopWhen"]
];
function extractContract(text) {
  const lines = String(text ?? "").split(`
`);
  const contract = { verify: null, constraints: null, boundaries: null, stopWhen: null };
  const headline = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const hit = FIELD_PREFIXES.find(([p]) => lower.startsWith(p));
    if (hit) {
      current = hit[1];
      const rest = trimmed.slice(hit[0].length).trim();
      contract[current] = rest || null;
      continue;
    }
    if (current && trimmed) {
      contract[current] = contract[current] ? `${contract[current]}
${trimmed}` : trimmed;
    } else if (!current && trimmed) {
      headline.push(line);
    }
  }
  return { headline: headline.join(`
`).trim(), contract };
}
function parseTokenBudget(s) {
  if (s == null)
    return null;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(String(s).trim());
  if (!m)
    return null;
  const n = parseFloat(m[1]);
  const mult = m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1e6 : 1;
  const out = Math.round(n * mult);
  return out > 0 ? out : null;
}
var ACTIONS = ["status", "pause", "resume", "clear", "stop", "edit", "gate", "help"];
function parseGoalArgs(raw) {
  let input = String(raw ?? "").trim();
  if (input.length > 1 && (input.startsWith('"') && input.endsWith('"') || input.startsWith("'") && input.endsWith("'"))) {
    input = input.slice(1, -1).trim();
  }
  if (!input)
    return { action: "status" };
  if (input === "help" || input === "--help" || input === "-h")
    return { action: "help" };
  const gateMatch = /^gate(\s+.*)?$/.exec(input);
  if (gateMatch) {
    const rest = (gateMatch[1] ?? "").trim();
    if (!rest || rest === "list")
      return { action: "gate", op: "list" };
    const add = /^add\s+(.+)$/.exec(rest);
    if (add)
      return { action: "gate", op: "add", cmd: add[1].trim() };
    const rm = /^(?:remove|rm)\s+(\d+)$/.exec(rest);
    if (rm)
      return { action: "gate", op: "remove", index: parseInt(rm[1], 10) };
    if (rest === "clear")
      return { action: "gate", op: "clear" };
    return { action: "gate", op: "invalid", error: `unknown gate subcommand: ${rest}` };
  }
  let text = input;
  let tokenBudget;
  let turnBudget;
  const flagRe = /--tokens\s+(\S+)|--turns\s+(\d+)/gi;
  let m;
  while (m = flagRe.exec(input)) {
    if (m[1] != null) {
      const v = parseTokenBudget(m[1]);
      if (v == null)
        return { action: "invalid", error: `bad --tokens value "${m[1]}" (use e.g. 100k, 2m, 500000)` };
      tokenBudget = v;
    } else {
      turnBudget = parseInt(m[2], 10);
    }
  }
  text = text.replace(/--tokens\s+\S+/gi, "").replace(/--turns\s+\d+/gi, "").trim();
  const firstWord = text.split(/\s+/)[0]?.toLowerCase();
  if (ACTIONS.includes(firstWord)) {
    const rest = text.slice(firstWord.length).trim();
    if (firstWord === "stop")
      return { action: "clear" };
    if (firstWord === "edit") {
      if (!rest)
        return { action: "invalid", error: "usage: /goal edit <new objective>" };
      const c2 = extractContract(rest);
      return { action: "edit", text: c2.headline, contract: c2.contract, tokenBudget, turnBudget };
    }
    return { action: firstWord };
  }
  if (!text)
    return { action: "status" };
  const c = extractContract(text);
  return { action: "start", text: c.headline, contract: c.contract, tokenBudget: tokenBudget ?? null, turnBudget: turnBudget ?? null };
}

// lib/prompts.js
function fmtTokens(n) {
  if (n == null)
    return "unknown";
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function contractLines(contract) {
  const out = [];
  if (contract?.verify)
    out.push(`Verification surface: ${contract.verify}`);
  if (contract?.constraints)
    out.push(`Constraints (must not regress): ${contract.constraints}`);
  if (contract?.boundaries)
    out.push(`Boundaries (allowed scope): ${contract.boundaries}`);
  if (contract?.stopWhen)
    out.push(`Stop and report when: ${contract.stopWhen}`);
  return out;
}
function systemBlock(goal) {
  const lines = [
    `# Active goal (${goal.status})`,
    "",
    goal.text,
    "",
    ...contractLines(goal.contract),
    "",
    `Progress: ${goal.iteration}/${goal.turnBudget ?? "unlimited"} automatic continuations used` + (goal.tokensUsed != null ? `, ~${fmtTokens(goal.tokensUsed)} tokens above baseline` : "")
  ];
  if (goal.status === "active") {
    lines.push("", "Rules while the goal is active:", "- Keep working toward the goal across turns. Do not stop to ask whether to continue.", "- Before claiming done, audit the objective against concrete evidence: files changed, command output, tests run, artifacts produced.", "- Call the goal_complete tool ONLY when the objective is fully met and verified; pass the evidence as the argument.", `- If genuinely blocked, say "BLOCKED: <reason> and what would unblock it" and stop; do not invent progress.`);
  } else if (goal.status === "paused") {
    lines.push("", `The goal is paused (${goal.pauseReason ?? "by user"}). Automatic continuation is off; wait for the user.`);
  } else if (goal.status === "budget_limited") {
    lines.push("", "The goal hit its budget. Do not start substantive new work; summarize progress, blockers, and the next step if asked.");
  } else if (goal.status === "blocked") {
    lines.push("", `The goal is blocked: ${goal.lastError ?? "unknown reason"}. Wait for the user.`);
  }
  return lines.join(`
`);
}
function continuationPrompt(goal, n) {
  const head = n <= 1 ? "Begin working toward the active goal now." : `Continue working toward the active goal (automatic continuation #${n}).`;
  const verify = goal.contract?.verify ? `
Prove progress against: ${goal.contract.verify}` : "";
  const stopWhen = goal.contract?.stopWhen ? `
If this applies \u2014 "${goal.contract.stopWhen}" \u2014 stop and report it plainly.` : "";
  return [
    `[goal] ${head}`,
    "",
    goal.text,
    verify,
    stopWhen,
    "",
    "First re-read the current state (files, test output, logs) instead of assuming it. Then take the next concrete action.",
    "If the objective is fully met and verified, call goal_complete with the evidence. If blocked, reply starting with BLOCKED: and the reason."
  ].filter((s) => s !== "").join(`
`);
}
function gateFailurePrompt(goal, results) {
  const failed = results.filter((r) => r.exit !== 0);
  const tails = failed.map((r) => `$ ${r.cmd}
exit ${r.exit}
${r.tail.slice(-1200)}`).join(`

`);
  return [
    "[goal] Quality gate failed \u2014 the goal cannot be considered complete while these fail.",
    "",
    tails,
    "",
    "Fix the failures these commands expose, then continue toward the goal. Re-run the gate commands yourself to check before claiming done."
  ].join(`
`);
}
function statusText(goal) {
  const age = Math.max(0, Date.now() - Date.parse(goal.startedAt));
  const mins = Math.floor(age / 60000);
  const hours = Math.floor(mins / 60);
  const ageStr = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;
  const lines = [
    `Goal [${goal.status}] ${goal.id.slice(0, 8)}`,
    goal.text,
    "",
    `Started: ${ageStr} ago | Continuations: ${goal.iteration}${goal.turnBudget ? `/${goal.turnBudget}` : ""} | Tokens: ~${fmtTokens(goal.tokensUsed)}${goal.tokenBudget ? `/${fmtTokens(goal.tokenBudget)}` : ""}`
  ];
  for (const l of contractLines(goal.contract))
    lines.push(l);
  if (goal.gates.length)
    lines.push(`Gates: ${goal.gates.map((g) => g.cmd).join(" ; ")}`);
  if (goal.pauseReason)
    lines.push(`Pause reason: ${goal.pauseReason}`);
  if (goal.lastError && goal.status !== "blocked")
    lines.push(`Last error: ${goal.lastError}`);
  if (goal.completionEvidence)
    lines.push(`Completed with evidence: ${goal.completionEvidence.slice(0, 300)}`);
  return lines.join(`
`);
}
var HELP = `usage:
  /goal <objective>                    start working toward an objective (kicks off the first turn)
  /goal verify: <cmd>                  optional contract fields inside the objective text:
                                         verify: / constraints: / boundaries: / stop when:
  /goal --tokens 200k --turns 40 <obj> optional caps \u2014 none by default; it runs until done
  /goal                                show current goal and usage
  /goal pause | resume | clear         lifecycle controls
  /goal edit [--tokens X] <new text>   change the objective without resetting usage
  /goal gate add <shell cmd>           deterministic check that must exit 0 before the goal can complete
  /goal gate [list] | remove <n> | clear
statuses: active | paused | blocked | budget_limited | complete`;
function startedNote(goal) {
  const b = [];
  b.push(`Goal set [active]: ${goal.text}`);
  for (const l of contractLines(goal.contract))
    b.push(l);
  b.push(`Budgets: ${goal.turnBudget ?? "unlimited"} continuations` + (goal.tokenBudget ? `, ${fmtTokens(goal.tokenBudget)} tokens` : ""));
  if (goal.gates.length)
    b.push(`Gates: ${goal.gates.map((g) => g.cmd).join(" ; ")}`);
  return b.join(`
`);
}

// lib/gates.js
import { execFileSync } from "child_process";
import { createHash } from "crypto";
var GATE_TIMEOUT_MS = 5 * 60 * 1000;
var GATE_RETRIES = 3;
function gitFingerprint(cwd) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const st = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return createHash("sha1").update(head + "\x00" + st).digest("hex");
  } catch {
    return null;
  }
}
function makeGate(cmd) {
  return { cmd, retriesLeft: GATE_RETRIES, lastExit: null, lastTail: "", lastFingerprint: null };
}
function runGates(gates, cwd) {
  const fp = gitFingerprint(cwd);
  const results = [];
  let ok = true;
  let ranAny = false;
  for (const gate of gates) {
    if (gate.lastExit !== 0 && gate.lastFingerprint && gate.lastFingerprint === fp) {
      results.push({ cmd: gate.cmd, exit: gate.lastExit, tail: gate.lastTail, skipped: true });
      ok = false;
      continue;
    }
    ranAny = true;
    let exit = 0;
    let tail = "";
    try {
      const out = execFileSync(gate.cmd, { shell: true, cwd, timeout: GATE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
      tail = out.toString().slice(-3000);
      exit = 0;
    } catch (err) {
      exit = err.status ?? 1;
      const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      tail = (combined || String(err.message ?? "")).slice(-3000);
    }
    gate.lastExit = exit;
    gate.lastTail = tail;
    gate.lastFingerprint = fp;
    if (exit !== 0) {
      gate.retriesLeft -= 1;
      ok = false;
    } else {
      gate.retriesLeft = GATE_RETRIES;
    }
    results.push({ cmd: gate.cmd, exit, tail });
  }
  return { ok, results, ranAny };
}

// lib/engine.js
var RETRYABLE = /rate.?limit|429|timeout|timed out|network|econn|socket hang up|overloaded|502|503|529|fetch failed/i;
var NO_PROGRESS_LIMIT = 3;
var RETRY_BASE_MS = 30000;
var RETRY_MAX = 3;
var IDLE_BURST_MS = 1200;
var SEND_RACE_MS = 3000;

class GoalEngine {
  constructor(ports) {
    this.ports = ports;
    this.cache = new Map;
  }
  meta(sid) {
    let m = this.cache.get(sid);
    if (!m)
      this.cache.set(sid, m = { cycles: [], retries: 0, lastCycleHadGates: false, noToolStreak: 0, lastSendAt: 0, lastIdleAt: 0, sending: null });
    return m;
  }
  async#locked(sid, fn) {
    const meta = this.meta(sid);
    const t = this.ports.now();
    if (t - meta.lastIdleAt < IDLE_BURST_MS)
      return { action: "noop" };
    if (t - meta.lastSendAt < SEND_RACE_MS)
      return { action: "noop" };
    while (meta.sending)
      await meta.sending.catch(() => {});
    const job = fn().catch((err) => {
      this.ports.log("onIdle error:", err?.message ?? err);
      return { action: "noop" };
    }).finally(() => {
      meta.lastIdleAt = this.ports.now();
      if (meta.sending === job)
        meta.sending = null;
    });
    meta.sending = job;
    return job;
  }
  async#continueGoal(sid, goal, prompt) {
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
    if (!goal || goal.status === "complete")
      return null;
    return systemBlock(goal);
  }
  noteUserActivity(sid) {
    const goal = loadGoal(sid);
    if (!goal)
      return;
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
        goal.baselineTokens = goal.baselineTokens ?? 0;
        goal.tokensUsed = u.input + u.output;
      }
    } catch (err) {
      this.ports.log("getUsage failed:", err?.message ?? err);
    }
  }
  async handleCommand(sid, rawArgs) {
    const cmd = parseGoalArgs(rawArgs);
    if (cmd.action === "invalid")
      return [`[goal] ${cmd.error}

${HELP}`];
    if (cmd.action === "help")
      return [HELP];
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
      if (!goal)
        return ["No goal set."];
      if (goal.status !== "active")
        return [`Goal is ${goal.status}; nothing to pause.`];
      goal.status = "paused";
      goal.pauseReason = "paused by user";
      saveGoal(sid, goal);
      return [`Goal paused. /goal resume to continue (${goal.iteration} continuations used).`];
    }
    if (cmd.action === "resume") {
      const goal = await this.ensure(sid);
      if (!goal)
        return ["No goal set."];
      if (goal.status === "active")
        return ["Goal is already active."];
      if (goal.status === "complete")
        return ["Goal already completed. Set a new one with /goal <objective>."];
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
      return ["Goal resumed \u2014 working."];
    }
    if (cmd.action === "edit") {
      const goal = await this.ensure(sid);
      if (!goal)
        return ["No goal set to edit."];
      if (cmd.text)
        goal.text = cmd.text;
      if (cmd.contract && (cmd.contract.verify || cmd.contract.constraints || cmd.contract.boundaries || cmd.contract.stopWhen)) {
        goal.contract = cmd.contract;
      }
      if (cmd.tokenBudget != null)
        goal.tokenBudget = cmd.tokenBudget;
      if (cmd.turnBudget != null)
        goal.turnBudget = cmd.turnBudget;
      await this.refreshUsage(sid, goal);
      if (goal.status === "budget_limited" && (goal.tokenBudget == null || (goal.tokensUsed ?? 0) < goal.tokenBudget)) {
        goal.status = "active";
      }
      saveGoal(sid, goal);
      return [`Goal updated.

${statusText(goal)}`];
    }
    if (cmd.action === "gate") {
      const goal = await this.ensure(sid);
      if (!goal)
        return ["No goal set \u2014 gates attach to a goal. Start one first."];
      if (cmd.op === "list") {
        if (!goal.gates.length)
          return ["No gates. Add one: /goal gate add <shell command>"];
        return [goal.gates.map((g, i) => `${i + 1}. $ ${g.cmd} \u2014 last exit ${g.lastExit ?? "n/a"}, retries left ${g.retriesLeft}`).join(`
`)];
      }
      if (cmd.op === "add") {
        goal.gates.push(makeGate(cmd.cmd));
        saveGoal(sid, goal);
        return [`Gate added: ${cmd.cmd}
All gates must exit 0 before the goal can complete.`];
      }
      if (cmd.op === "remove") {
        if (!(cmd.index >= 1 && cmd.index <= goal.gates.length))
          return [`Gate #${cmd.index} does not exist.`];
        const [gone] = goal.gates.splice(cmd.index - 1, 1);
        saveGoal(sid, goal);
        return [`Gate removed: ${gone.cmd}`];
      }
      if (cmd.op === "clear") {
        goal.gates = [];
        saveGoal(sid, goal);
        return ["All gates removed."];
      }
      return [`Unknown gate subcommand.

${HELP}`];
    }
    if (cmd.action === "start") {
      const prev = await this.ensure(sid);
      const goal = newGoal({
        text: cmd.text,
        contract: cmd.contract,
        tokenBudget: cmd.tokenBudget,
        turnBudget: cmd.turnBudget
      });
      saveGoal(sid, goal);
      this.cache.set(sid, { cycles: [], retries: 0, lastCycleHadGates: false });
      await this.captureBaseline(sid, goal);
      const replies = [startedNote(goal)];
      if (prev && prev.status !== "complete")
        replies.unshift(`(Replaced previous ${prev.status} goal.)`);
      const sent = await this.ports.sendWork(sid, continuationPrompt(goal, 1));
      if (sent) {
        goal.pendingContinuation = `start:${Date.now()}`;
        saveGoal(sid, goal);
        this.meta(sid).lastSendAt = this.ports.now();
      } else {
        replies.push("[goal] Could not inject the first work turn \u2014 the reactor will retry on the next idle event.");
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
  async complete(sid, evidence) {
    const goal = await this.ensure(sid);
    if (!goal)
      return { ok: false, text: "No active goal \u2014 goal_complete rejected." };
    if (goal.status !== "active")
      return { ok: false, text: `Goal is ${goal.status}, not active \u2014 goal_complete rejected.` };
    const ev = String(evidence ?? "").trim();
    if (!ev)
      return { ok: false, text: "Rejected: goal_complete requires an evidence argument (what proves the objective is met)." };
    goal.status = "complete";
    goal.completedAt = new Date().toISOString();
    goal.completionEvidence = ev.slice(0, 4000);
    saveGoal(sid, goal);
    await this.ports.sendNote(sid, `[goal] Achieved. Evidence: ${ev.slice(0, 500)}`);
    return { ok: true, text: "Goal marked complete. Summarize the outcome for the user in your reply." };
  }
  interrupt(sid, reason = "interrupted") {
    const goal = loadGoal(sid);
    if (!goal || goal.status !== "active")
      return;
    goal.status = "paused";
    goal.pauseReason = reason;
    goal.pendingContinuation = null;
    saveGoal(sid, goal);
    this.ports.sendNote(sid, `[goal] Paused (${reason}). /goal resume to continue.`);
  }
  forgetSession(sid) {
    clearGoal(sid);
    this.cache.delete(sid);
  }
  async onIdle(sid, input = {}) {
    return this.#locked(sid, () => this.#onIdleInner(sid, input));
  }
  async#onIdleInner(sid, { lastText = "", hadToolCall = false, error = null, interrupted = false, sawActivity = true } = {}) {
    const goal = await this.ensure(sid);
    if (!goal)
      return { action: "noop" };
    if (!sawActivity && !error && !interrupted)
      return { action: "noop" };
    if (goal.pendingContinuation) {
      goal.pendingContinuation = null;
      saveGoal(sid, goal);
      if (goal.status !== "active")
        return { action: "noop" };
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
        await this.ports.sendNote(sid, `[goal] Retryable error (${es}) \u2014 retry ${meta.retries}/${RETRY_MAX} in ${Math.round(delayMs / 1000)}s.`);
        return { action: "retry", delayMs };
      }
      goal.status = "blocked";
      goal.lastError = es;
      saveGoal(sid, goal);
      await this.ports.sendNote(sid, `[goal] Blocked by error: ${es}
Fix the cause, then /goal resume.`);
      return { action: "paused" };
    }
    meta.retries = 0;
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
    const hash = createHash2("sha1").update(String(lastText ?? "")).digest("hex").slice(0, 12);
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
    if (goal.tokenBudget != null && goal.tokensUsed != null && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited";
      saveGoal(sid, goal);
      await this.ports.sendNote(sid, `[goal] Token budget reached (~${goal.tokensUsed}/${goal.tokenBudget}). Stop substantive work; summarize progress, blockers, and the next step.
/goal resume won't help until you raise the budget: /goal edit --tokens <bigger>.`);
      return { action: "paused" };
    }
    if (goal.turnBudget != null && goal.iteration >= goal.turnBudget) {
      goal.status = "budget_limited";
      saveGoal(sid, goal);
      await this.ports.sendNote(sid, `[goal] Turn budget reached (${goal.iteration}/${goal.turnBudget}). Summarize progress and blockers.
/goal resume grants ${goal.turnBudget} more continuations.`);
      return { action: "paused" };
    }
    let prompt = continuationPrompt(goal, goal.iteration + 1);
    if (goal.gates.length) {
      const res = runGates(goal.gates, this.ports.getCwd());
      saveGoal(sid, goal);
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
        const sent2 = await this.#continueGoal(sid, goal, gateFailurePrompt(goal, res.results));
        return { action: sent2 ? "continued" : "noop" };
      }
    }
    meta.lastCycleHadGates = false;
    if (nudgeNext) {
      prompt += `

Your last automatic turn made no tool calls. This turn MUST do concrete work: read, run, or change real files \u2014 or call goal_complete / reply BLOCKED:. Do not just narrate.`;
    }
    const sent = await this.#continueGoal(sid, goal, prompt);
    return { action: sent ? "continued" : "noop" };
  }
}

// index.js
import fs from "fs";
var dbg = (m) => {
  try {
    fs.appendFileSync("/tmp/probe/goaldbg.log", m + `
`);
  } catch {}
};
var log = (...a) => console.error("[opencode-goal]", ...a);
var NEUTRAL = "(goal command handled by the goal plugin)";
var goal_fresh_default = {
  id: "opencode-goal",
  setup: async (ctx) => {
    dbg("setup entered active=" + !!globalThis.__opencode_goal_active);
    if (globalThis.__opencode_goal_active)
      return;
    const trackers = new Map;
    const seenInbox = new Set;
    const track = (sid) => {
      let t = trackers.get(sid);
      if (!t)
        trackers.set(sid, t = { lastText: "", sawTool: false });
      return t;
    };
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
          await ctx.session.synthetic({ sessionID: sid, text, description: "goal" });
        } catch {
          try {
            await ctx.session.prompt({ sessionID: sid, text });
          } catch {}
        }
      },
      async getUsage(sid) {
        try {
          const s = await ctx.session.get(sid);
          const t = s?.data ?? s;
          for (const u of [t?.tokens, t?.usage, t]) {
            if (!u || typeof u !== "object")
              continue;
            const input = u.input ?? u.inputTokens ?? u.in;
            const output = u.output ?? u.outputTokens ?? u.out;
            if (Number.isFinite(input) && Number.isFinite(output))
              return { input, output };
          }
          return null;
        } catch {
          return null;
        }
      },
      getCwd: () => process.cwd()
    };
    const engine = new GoalEngine(ports);
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
      if (!type.includes("text") && !type.includes("delta") && !type.includes("heartbeat"))
        dbg("evt: " + type);
      const d = evt?.data ?? {};
      const p = evt?.properties ?? {};
      const sid = d.sessionID ?? p.sessionID;
      if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
        if (sid)
          track(sid).sawTool = true;
        return;
      }
      if (type === "session.text.ended") {
        const text = d.text ?? d.part?.text;
        if (sid && typeof text === "string" && text)
          track(sid).lastText = text;
        return;
      }
      if (type === "session.idle" || type === "session.execution.succeeded") {
        if (!sid)
          return;
        const t = trackers.get(sid);
        trackers.delete(sid);
        await engine.onIdle(sid, {
          lastText: t?.lastText ?? "",
          hadToolCall: t?.sawTool ?? false,
          sawActivity: t != null
        });
        return;
      }
      if (type === "session.execution.failed") {
        if (sid)
          await engine.onIdle(sid, { error: d.error ?? d.message ?? "execution failed" });
        return;
      }
      if (type === "session.execution.interrupted") {
        if (sid)
          engine.interrupt(sid, "interrupted");
        return;
      }
      if (type === "session.deleted") {
        if (sid) {
          trackers.delete(sid);
          engine.forgetSession(sid);
        }
        return;
      }
      if (type === "session.inbox.enqueued" || type === "session.inbox.delivered") {
        const text = String(d.text ?? d.message?.text ?? "").trim();
        dbg("inbox text=<" + text.slice(0, 60) + "> sid=" + !!sid);
        if (!sid || text !== "/goal" && !text.startsWith("/goal "))
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
        const block = engine.systemBlock(sid);
        if (block) {
          try {
            sc.system.push({ type: "text", text: block });
          } catch {
            try {
              sc.system.push(block);
            } catch {}
          }
        }
        const msgs = Array.isArray(sc.messages) ? sc.messages : [];
        for (const m of msgs) {
          if (m?.role !== "user")
            continue;
          const content = m.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((pt) => pt?.type === "text").map((pt) => pt.text ?? "").join("") : "";
          const t = text.trim();
          if (t === "/goal" || t.startsWith("/goal ")) {
            if (typeof content === "string")
              m.content = NEUTRAL;
            else if (Array.isArray(content)) {
              for (const pt of content)
                if (pt?.type === "text")
                  pt.text = NEUTRAL;
            }
          } else if (t && !t.startsWith("[goal]") && !t.startsWith(NEUTRAL)) {
            engine.noteUserActivity(sid);
          }
        }
      } catch {}
    });
    await ctx.tool.transform((draft) => draft.add({
      name: "goal_complete",
      description: "Mark the active /goal complete. Call ONLY after auditing the objective against concrete evidence (files changed, tests run, command output, artifacts). Pass the evidence.",
      promptSnippet: "Call goal_complete only when the active goal is fully met and verified",
      parameters: {
        type: "object",
        properties: {
          evidence: { type: "string", description: "Concrete evidence the objective is met" }
        },
        required: ["evidence"]
      },
      execute: async (args, tctx) => {
        const sid = tctx?.sessionID ?? tctx?.sessionId;
        const res = await engine.complete(sid, args?.evidence);
        return res.text;
      }
    }));
    globalThis.__opencode_goal_active = true;
  }
};
export {
  goal_fresh_default as default
};
