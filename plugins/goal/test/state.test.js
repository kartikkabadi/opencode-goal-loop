import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newGoal, loadGoal, saveGoal, clearGoal, normalizeGoal, safeSessionID } from "../lib/state.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goal-state-test-"));
  process.env.XDG_STATE_HOME = dir;
});
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("state", () => {
  test("newGoal defaults", () => {
    const g = newGoal({ text: "do the thing", contract: { verify: null, constraints: null, boundaries: null, stopWhen: null } });
    expect(g.status).toBe("active");
    expect(g.turnBudget).toBeNull();
    expect(g.tokenBudget).toBeNull();
    expect(g.iteration).toBe(0);
    expect(g.id).toMatch(/[0-9a-f-]{36}/);
  });

  test("explicit budgets are honored when passed", () => {
    const g = newGoal({ text: "capped", contract: {}, turnBudget: 5, tokenBudget: 100_000 });
    expect(g.turnBudget).toBe(5);
    expect(g.tokenBudget).toBe(100_000);
  });

  test("save/load roundtrip", () => {
    const g = newGoal({ text: "roundtrip", contract: { verify: "tests pass", constraints: null, boundaries: null, stopWhen: null } });
    saveGoal("ses_a", g);
    const loaded = loadGoal("ses_a");
    expect(loaded.text).toBe("roundtrip");
    expect(loaded.contract.verify).toBe("tests pass");
    expect(existsSync(join(dir, "opencode/goal-loop/goal"))).toBe(true);
  });

  test("normalizeGoal repairs fields and aliases legacy statuses", () => {
    expect(normalizeGoal({ id: "x", text: "t", status: "usage_limited" }).status).toBe("budget_limited");
    expect(normalizeGoal({ id: "x", text: "t", status: "weird" }).status).toBe("paused");
    const g = normalizeGoal({ id: "x", text: "t" });
    expect(g.iteration).toBe(0);
    expect(g.turnBudget).toBeNull();
    expect(g.gates).toEqual([]);
    expect(normalizeGoal(null)).toBeNull();
    expect(normalizeGoal({ text: "no id" })).toBeNull();
  });

  test("loadGoal missing file -> null", () => {
    expect(loadGoal("ses_missing")).toBeNull();
  });

  test("corrupt json quarantined as .corrupt and loads null", () => {
    const sidDir = join(dir, "opencode", "goal-loop", "goal");
    mkdirSync(sidDir, { recursive: true });
    const p = join(sidDir, "ses_bad.json");
    writeFileSync(p, "{not json");
    expect(loadGoal("ses_bad")).toBeNull();
    expect(existsSync(p + ".corrupt")).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  test("clearGoal removes file", () => {
    const g = newGoal({ text: "bye", contract: {} });
    saveGoal("ses_c", g);
    clearGoal("ses_c");
    expect(loadGoal("ses_c")).toBeNull();
  });

  test("safeSessionID sanitizes hostile ids", () => {
    expect(safeSessionID("a/b\\c:d*e?f")).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(safeSessionID("")).toBe("unknown");
    expect(safeSessionID(undefined)).toBe("unknown");
  });
});
