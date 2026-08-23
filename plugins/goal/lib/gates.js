// gates — deterministic shell commands that must exit 0 before a goal can complete.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const GATE_TIMEOUT_MS = 5 * 60 * 1000;
export const GATE_RETRIES = 3;

// Cheap workspace fingerprint: HEAD + porcelain status. Outside git → null (always rerun).
export function gitFingerprint(cwd) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const st = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return createHash("sha1").update(head + "\u0000" + st).digest("hex");
  } catch {
    return null;
  }
}

export function makeGate(cmd) {
  return { cmd, retriesLeft: GATE_RETRIES, lastExit: null, lastTail: "", lastFingerprint: null };
}

// Runs every gate. Skips a gate when its recorded failure is for the exact current
// workspace state (a stuck agent must not burn wall-clock rerunning a red suite).
// Returns {ok, results, ranAny}.
export function runGates(gates, cwd) {
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
