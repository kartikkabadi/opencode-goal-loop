// store — durable loop records. One JSON file, atomic writes, GC on load.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const STORE_VERSION = 1;
export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 7 * 24 * 3600_000;
export const DEFAULT_MAX_FIRES = null; // unlimited: runs until LOOP_COMPLETE or an explicit stop
export const EXPIRY_MS = 7 * 24 * 3600_000;
export const BUSY_BACKOFF_INITIAL_MS = 2000;
export const BUSY_BACKOFF_MAX_MS = 30_000;

export function storePath() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "goal-loop", "loop", "loops.json");
}

export function shortId(id) {
  return String(id ?? "").slice(0, 8);
}

export function loadStore() {
  const p = storePath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const loops = Array.isArray(parsed.loops) ? parsed.loops : [];
    return gcLoops(loops);
  } catch {
    try { renameSync(p, `${p}.corrupt`); } catch {}
    return [];
  }
}

function isLoopRecord(loop) {
  if (!loop || typeof loop !== "object" || Array.isArray(loop)) return false;
  if (typeof loop.id !== "string" || !loop.id || typeof loop.sessionId !== "string" || !loop.sessionId || typeof loop.prompt !== "string") return false;
  const timestamp = loop.updatedAt ?? loop.createdAt;
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return false;
  const interval = loop.interval;
  if (!interval || typeof interval !== "object") return false;
  if (interval.kind === "time") return Number.isSafeInteger(interval.ms) && interval.ms > 0;
  if (interval.kind === "turns") return Number.isSafeInteger(interval.n) && interval.n > 0;
  return false;
}

function gcLoops(loops) {
  const now = Date.now();
  const kept = loops.filter((l) => isLoopRecord(l) && now - Date.parse(l.updatedAt ?? l.createdAt ?? 0) < EXPIRY_MS);
  if (kept.length !== loops.length) saveStore(kept);
  return kept;
}

export function saveStore(loops) {
  const p = storePath();
  mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, loops }, null, 2));
  renameSync(tmp, p);
}

export function newLoop({ sessionId, prompt, interval, label = null, maxFires = DEFAULT_MAX_FIRES, immediate = true }) {
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
    backoffMs: BUSY_BACKOFF_INITIAL_MS,
  };
}

// Full id or exact label; active matches win over terminal ones.
export function findLoop(loops, sessionId, idOrLabel) {
  if (!idOrLabel) return null;
  const score = (l) => (l.sessionId === sessionId ? 0 : 1) + (l.status === "active" || l.status === "paused" ? 0 : 2);
  let best = null;
  for (const l of loops) {
    if (l.id !== idOrLabel && l.label !== idOrLabel) continue;
    if (!best || score(l) < score(best)) best = l;
  }
  return best;
}

// Most recently updated active loop for a session.
export function mostRecentActive(loops, sessionId) {
  let best = null;
  for (const l of loops) {
    if (l.sessionId !== sessionId || l.status !== "active") continue;
    if (!best || Date.parse(l.updatedAt) > Date.parse(best.updatedAt)) best = l;
  }
  return best;
}

export function countActive(loops, sessionId = null) {
  return loops.filter((l) => l.status === "active" && (sessionId == null || l.sessionId === sessionId)).length;
}

export function describeInterval(interval) {
  return interval.raw;
}

export function nextDelayMs(loop, now = Date.now()) {
  if (loop.interval.kind !== "time") return null;
  let ms = loop.interval.ms;
  if (ms >= 60_000) ms = Math.round(ms * (0.95 + Math.random() * 0.1)); // ±5% jitter avoids stampedes
  return ms;
}

export function removeStore() {
  try { unlinkSync(storePath()); } catch {}
}
