import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInterval, parseLoopArgs } from "../lib/parse.js";
import { LoopEngine, HELP } from "../lib/engine.js";
import { loadStore, saveStore, newLoop, MIN_INTERVAL_MS } from "../lib/store.js";

let dir;
let clock;
let sentWork;
let sentNotes;
let busyMap;
let engine;
const SID = "ses_loop_test";

function makeEngine() {
  return new LoopEngine({
    now: () => clock,
    log: () => {},
    sendWork: async (sid, text) => { sentWork.push({ sid, text }); return true; },
    sendNote: async (sid, text) => { sentNotes.push(text); },
    isBusy: async (sid) => busyMap.get(sid) ?? false,
    goalActive: async () => false,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loop-engine-test-"));
  process.env.XDG_STATE_HOME = dir;
  clock = 1_000_000;
  sentWork = [];
  sentNotes = [];
  busyMap = new Map();
  engine = makeEngine();
});
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("parseInterval", () => {
  test("time units and combos", () => {
    expect(parseInterval("30s")).toEqual({ kind: "time", ms: 30_000, raw: "30s" });
    expect(parseInterval("5m")).toEqual({ kind: "time", ms: 300_000, raw: "5m" });
    expect(parseInterval("1h30m")).toEqual({ kind: "time", ms: 5_400_000, raw: "1h30m" });
    expect(parseInterval("1d")).toEqual({ kind: "time", ms: 86_400_000, raw: "1d" });
  });
  test("turn cadence", () => {
    expect(parseInterval("3t")).toEqual({ kind: "turns", n: 3, raw: "3t" });
    expect(parseInterval("2turns")).toEqual({ kind: "turns", n: 2, raw: "2turns" });
  });
  test("rejects garbage and bare numbers", () => {
    expect(parseInterval("5")).toBeNull();
    expect(parseInterval("abc")).toBeNull();
    expect(parseInterval("0m")).toBeNull();
    expect(parseInterval("")).toBeNull();
  });
});

describe("parseLoopArgs", () => {
  test("empty -> status; help variants", () => {
    expect(parseLoopArgs("").action).toBe("status");
    expect(parseLoopArgs("help").action).toBe("help");
  });
  test("subcommands", () => {
    expect(parseLoopArgs("list --all")).toEqual({ action: "list", all: true });
    expect(parseLoopArgs("stop")).toEqual({ action: "stop", idOrLabel: undefined });
    expect(parseLoopArgs("pause ci")).toEqual({ action: "pause", idOrLabel: "ci" });
    expect(parseLoopArgs("resume ci")).toEqual({ action: "resume", idOrLabel: "ci" });
    expect(parseLoopArgs("status").action).toBe("status");
  });
  test("creation with flags anywhere", () => {
    const r = parseLoopArgs('--label ci --times 20 5m check CI --no-immediate');
    expect(r.action).toBe("create");
    expect(r.interval.kind).toBe("time");
    expect(r.label).toBe("ci");
    expect(r.times).toBe(20);
    expect(r.immediate).toBe(false);
    expect(r.prompt).toBe("check CI");
  });
  test("turn creation", () => {
    const r = parseLoopArgs("3t triage the inbox");
    expect(r.action).toBe("create");
    expect(r.interval).toMatchObject({ kind: "turns", n: 3 });
    expect(r.prompt).toBe("triage the inbox");
  });
  test("errors are actionable", () => {
    expect(parseLoopArgs("5").error).toMatch(/unit/);
    expect(parseLoopArgs("5m").error).toMatch(/prompt required/);
    expect(parseLoopArgs("--label x y").action).toBe("invalid");
    expect(parseLoopArgs("banana check").error).toMatch(/interval/);
  });
});

describe("loop engine", () => {
  test("create fires immediately by default and schedules next", async () => {
    const replies = await engine.handleCommand(SID, "10s append to log --label t1");
    expect(replies.join("\n")).toMatch(/Loop t1 set/);
    expect(sentWork).toHaveLength(1);
    expect(sentWork[0].text).toContain("[loop t1 fire 1]");
    expect(sentWork[0].text).toContain("LOOP_COMPLETE");
    const loops = loadStore();
    expect(loops).toHaveLength(1);
    expect(loops[0].status).toBe("active");
    expect(loops[0].nextRunAt).toBeGreaterThan(clock);
  });

  test("--no-immediate defers first fire", async () => {
    await engine.handleCommand(SID, "--no-immediate 10s quiet start");
    expect(sentWork).toHaveLength(0);
    expect(loadStore()[0].fires).toBe(0);
  });

  test("tick fires when due and respects maxFires cap", async () => {
    await engine.handleCommand(SID, "--times 2 10s capped task");
    clock += 11_000;
    await engine.tick(loadStore()[0].id);
    expect(sentWork).toHaveLength(2);
    let [loop] = loadStore();
    expect(loop.fires).toBe(2);
    expect(loop.status).toBe("done");
    expect(sentNotes.join("\n")).toMatch(/fire cap/);
  });

  test("busy session defers with escalating backoff", async () => {
    await engine.handleCommand(SID, "--no-immediate 10s busy task");
    busyMap.set(SID, true);
    clock += 11_000;
    const id = loadStore()[0].id;
    await engine.tick(id);
    let [loop] = loadStore();
    expect(loop.fires).toBe(0);
    expect(loop.backoffMs).toBeGreaterThan(2000);
    busyMap.set(SID, false);
    clock += 31_000;
    await engine.tick(id);
    [loop] = loadStore();
    expect(loop.fires).toBe(1);
    expect(loop.backoffMs).toBe(2000); // reset after successful context
  });

  test("goal-active session defers loops", async () => {
    const goalEngine = new LoopEngine({
      now: () => clock, log: () => {},
      sendWork: async (sid, text) => { sentWork.push({ sid, text }); return true; },
      sendNote: async () => {},
      isBusy: async () => false,
      goalActive: async () => true,
    });
    await goalEngine.handleCommand(SID, "--no-immediate 10s deferred task");
    clock += 11_000;
    await goalEngine.tick(loadStore()[0].id);
    expect(sentWork).toHaveLength(0);
    expect(loadStore()[0].status).toBe("active");
  });

  test("turn loop fires every N completed turns", async () => {
    await engine.handleCommand(SID, "2t turn task");
    expect(sentWork).toHaveLength(0);
    await engine.onTurnCompleted(SID, { lastText: "one" });
    expect(sentWork).toHaveLength(0);
    await engine.onTurnCompleted(SID, { lastText: "two" });
    expect(sentWork).toHaveLength(1);
    expect(sentWork[0].text).toContain("[loop #");
    expect(loadStore()[0].turnsUntilNext).toBe(2);
  });

  test("LOOP_COMPLETE sentinel finishes the most recent active loop", async () => {
    await engine.handleCommand(SID, "--no-immediate 10s sentinel task");
    await engine.onTurnCompleted(SID, { lastText: "All done.\nLOOP_COMPLETE" });
    const [loop] = loadStore();
    expect(loop.status).toBe("done");
    expect(sentNotes.join("\n")).toMatch(/LOOP_COMPLETE/);
  });

  test("pause, resume, stop lifecycle", async () => {
    await engine.handleCommand(SID, "--label life --no-immediate 10s lifecycle task");
    let replies = await engine.handleCommand(SID, "pause life");
    expect(replies.join("\n")).toMatch(/paused/);
    expect(loadStore()[0].status).toBe("paused");
    replies = await engine.handleCommand(SID, "resume life");
    expect(replies.join("\n")).toMatch(/resumed/);
    expect(loadStore()[0].status).toBe("active");
    replies = await engine.handleCommand(SID, "stop life");
    expect(replies.join("\n")).toMatch(/stopped/);
    expect(loadStore()[0].status).toBe("done");
  });

  test("caps: no active-loop limit; default loop is unlimited", async () => {
    for (let i = 0; i < 5; i++) {
      const replies = await engine.handleCommand(SID, `--label cap${i} --no-immediate 10s task ${i}`);
      expect(replies.join("\n")).not.toMatch(/Cap reached/);
      expect(replies.join("\n")).toMatch(/runs until stopped/);
    }
    expect(loadStore().filter((l) => l.status === "active")).toHaveLength(5);
    expect(loadStore()[0].maxFires).toBeNull();
  });

  test("unlimited loop keeps firing past any fire count", async () => {
    await engine.handleCommand(SID, "--no-immediate 10s marathon task");
    const loops = loadStore();
    loops[0].fires = 9999;
    saveStore(loops);
    clock += 11_000;
    await engine.tick(loops[0].id);
    const [loop] = loadStore();
    expect(loop.status).toBe("active");
    expect(loop.fires).toBe(10_000);
    expect(sentWork[sentWork.length - 1].text).toMatch(/fire 10000\]/);
  });

  test("--times still caps when explicitly given", async () => {
    await engine.handleCommand(SID, "--times 3 --no-immediate 10s capped opt-in");
    expect(loadStore()[0].maxFires).toBe(3);
  });

  test("min interval enforced", async () => {
    const replies = await engine.handleCommand(SID, "--no-immediate 2s too fast");
    expect(replies.join("\n")).toMatch(/Interval must be/);
  });

  test("duplicate label rejected while active", async () => {
    await engine.handleCommand(SID, "--label dup --no-immediate 10s one");
    const replies = await engine.handleCommand(SID, "--label dup --no-immediate 10s two");
    expect(replies.join("\n")).toMatch(/already active/);
  });

  test("toolStop ends most recent active loop", async () => {
    await engine.handleCommand(SID, "--no-immediate 10s agent task");
    const reply = engine.toolStop(SID, undefined);
    expect(reply).toMatch(/Stopped loop/);
    expect(loadStore()[0].status).toBe("done");
  });

  test("injection failure 3x -> error status", async () => {
    const failEngine = new LoopEngine({
      now: () => clock, log: () => {},
      sendWork: async () => false,
      sendNote: async () => {},
      isBusy: async () => false,
      goalActive: async () => false,
    });
    await failEngine.handleCommand(SID, "10s failing task"); // immediate fire fails once
    clock += 11_000;
    await failEngine.tick(loadStore()[0].id);
    clock += 11_000;
    await failEngine.tick(loadStore()[0].id);
    const [loop] = loadStore();
    expect(loop.status).toBe("error");
    expect(loop.consecutiveErrors).toBe(3);
  });

  test("armAll re-arms overdue time loop on startup", async () => {
    await engine.handleCommand(SID, "--no-immediate 10s restart task");
    const id = loadStore()[0].id;
    clock += 100_000; // way past due
    const fresh = makeEngine();
    fresh.armAll();
    // armAll fires overdue loops via tick
    await new Promise((r) => setTimeout(r, 20));
    expect(sentWork.length).toBeGreaterThanOrEqual(1);
    expect(loadStore().find((l) => l.id === id).fires).toBeGreaterThanOrEqual(1);
  });

  test("help text lists controls", () => {
    expect(HELP).toMatch(/list/);
    expect(HELP).toMatch(/stop/);
    expect(HELP).toMatch(/pause/);
    expect(HELP).toMatch(/resume/);
  });
});
