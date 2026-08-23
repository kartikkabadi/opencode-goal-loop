// state — atomic per-session JSON sidecar for /goal.
// Schema version 1. One file per session under ~/.local/share/opencode/goal-loop/goal/.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const STATE_VERSION = 1;
export const STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"];
const STATUS_ALIASES = { usage_limited: "budget_limited" };

export function safeSessionID(sid) {
  const s = String(sid ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return s || "unknown";
}

export function stateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "goal-loop", "goal");
}

function sidecarPath(sid) {
  return join(stateDir(), `${safeSessionID(sid)}.json`);
}

export function newGoal({ text, contract, tokenBudget = null, turnBudget = null }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    version: STATE_VERSION,
    text,
    contract, // {verify, constraints, boundaries, stopWhen} — any field may be null
    status: "active",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    completionEvidence: null,
    pauseReason: null,
    iteration: 0, // automatic continuations sent
    turnBudget, // null = unlimited (codex-style; opt-in cap via --turns)
    tokenBudget, // tokens above baseline; null = unlimited
    baselineTokens: null, // cumulative usage at start; null = unknown
    tokensUsed: null, // null = unknown
    lastError: null,
    gates: [], // {cmd, retriesLeft, lastExit, lastTail, lastFingerprint}
  };
}

export function normalizeStatus(s) {
  const key = String(s ?? "").toLowerCase();
  return STATUS_ALIASES[key] ?? (STATUSES.includes(key) ? key : "paused");
}

export function normalizeGoal(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || typeof raw.text !== "string") return null;
  const g = raw;
  g.status = normalizeStatus(g.status);
  if (g.status === "complete") g.completedAt ||= g.completedAt ?? null;
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

export function loadGoal(sid) {
  const p = sidecarPath(sid);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return normalizeGoal(parsed.goal ?? parsed);
  } catch (err) {
    // Corrupt state must not wedge the session: quarantine and report absent.
    try { renameSync(p, `${p}.corrupt`); } catch {}
    return null;
  }
}

export function saveGoal(sid, goal) {
  const p = sidecarPath(sid);
  mkdirSync(dirname7(p), { recursive: true });
  goal.updatedAt = new Date().toISOString();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, goal }, null, 2));
  renameSync(tmp, p);
}

export function clearGoal(sid) {
  const p = sidecarPath(sid);
  try { unlinkSync(p); } catch {}
}

function dirname7(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}
