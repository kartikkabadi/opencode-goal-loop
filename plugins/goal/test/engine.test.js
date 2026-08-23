import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalEngine } from "../lib/engine.js";
import { loadGoal } from "../lib/state.js";

let dir;
let clock;
let sentWork;
let sentNotes;
let usageTotal;
let engine;
const SID = "ses_engine_test";

function makeEngine() {
  return new GoalEngine({
    now: () => clock,
    log: () => {},
    sendWork: async (sid, text) => { sentWork.push({ sid, text }); clock += 60_000; return true; },
    sendNote: async (sid, text) => { sentNotes.push(text); },
    getUsage: async () => usageTotal,
    getCwd: () => dir,
  });
}

// Every send sets lastSendAt; every handled idle sets lastIdleAt.
// The engine suppresses calls inside those windows, so tests advance the clock between steps.
const bump = (ms = 61_000) => { clock += ms; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goal-engine-test-"));
  process.env.XDG_STATE_HOME = dir;
  clock = 1_000_000;
  sentWork = [];
  sentNotes = [];
  usageTotal = { input: 1000, output: 500 };
  engine = makeEngine();
});
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

async function start(text) {
  const replies = await engine.handleCommand(SID, text);
  bump();
  return replies;
}

describe("goal engine", () => {
  test("start kicks off first work turn and persists active goal", async () => {
    const replies = await start("create /tmp/gx.txt containing DONE");
    expect(replies.join("\n")).toMatch(/Goal set/);
    expect(sentWork).toHaveLength(1);
    expect(sentWork[0].text).toContain("create /tmp/gx.txt containing DONE");
    const g = loadGoal(SID);
    expect(g.status).toBe("active");
    expect(g.pendingContinuation).toBeTruthy();
    expect(g.baselineTokens).toBe(1500);
    expect(g.tokensUsed).toBe(0);
  });

  test("complete flow with evidence; rejected afterwards", async () => {
    await start("do it");
    const ok = await engine.complete(SID, "file exists and reads back DONE");
    expect(ok.ok).toBe(true);
    expect(loadGoal(SID).status).toBe("complete");
    const again = await engine.complete(SID, "more evidence");
    expect(again.ok).toBe(false);
    const noEvidence = await engine.complete(SID, "   ");
    expect(noEvidence.ok).toBe(false);
  });

  test("onIdle continues when tools were used", async () => {
    await start("keep going task");
    const res = await engine.onIdle(SID, { lastText: "made a file", hadToolCall: true });
    expect(res.action).toBe("continued");
    expect(sentWork).toHaveLength(2);
    expect(loadGoal(SID).iteration).toBe(1);
  });

  test("anti-spin nudges once then pauses on second narration-only cycle", async () => {
    await start("spin risk");
    await engine.onIdle(SID, { lastText: "worked", hadToolCall: true });
    bump();
    const nudge = await engine.onIdle(SID, { lastText: "just talking", hadToolCall: false });
    expect(nudge.action).toBe("continued");
    expect(sentWork[sentWork.length - 1].text).toMatch(/no tool calls/);
    bump();
    const pause = await engine.onIdle(SID, { lastText: "still talking", hadToolCall: false });
    expect(pause.action).toBe("paused");
    const g = loadGoal(SID);
    expect(g.status).toBe("paused");
    expect(g.pauseReason).toMatch(/no tool activity/);
  });

  test("no default turn cap: keeps continuing well past a handful of cycles", async () => {
    await start("long haul task");
    for (let i = 0; i < 6; i++) {
      const res = await engine.onIdle(SID, { lastText: `distinct progress ${i}`, hadToolCall: true });
      expect(res.action).toBe("continued");
      expect(loadGoal(SID).status).toBe("active");
      bump();
    }
    expect(loadGoal(SID).iteration).toBe(6);
  });

  test("turn budget exhausts to budget_limited", async () => {
    await start("--turns 1 tiny budget task");
    await engine.onIdle(SID, { lastText: "step one", hadToolCall: true });
    bump();
    const res = await engine.onIdle(SID, { lastText: "step two", hadToolCall: true });
    expect(res.action).toBe("paused");
    expect(loadGoal(SID).status).toBe("budget_limited");
  });

  test("token budget exhausts to budget_limited", async () => {
    await start("--tokens 1k token bound task");
    usageTotal = { input: 1_001_000 + 1500, output: 600 };
    const res = await engine.onIdle(SID, { lastText: "burning tokens", hadToolCall: true });
    expect(res.action).toBe("paused");
    expect(loadGoal(SID).status).toBe("budget_limited");
  });

  test("retryable errors back off then block", async () => {
    await start("flaky network task");
    let r = await engine.onIdle(SID, { error: "HTTP 429 rate limit" });
    expect(r.action).toBe("retry");
    expect(r.delayMs).toBe(30_000);
    bump();
    r = await engine.onIdle(SID, { error: "HTTP 429 rate limit" });
    expect(r.delayMs).toBe(60_000);
    bump();
    r = await engine.onIdle(SID, { error: "socket hang up" });
    expect(r.delayMs).toBe(120_000);
    bump();
    r = await engine.onIdle(SID, { error: "HTTP 429 rate limit" });
    expect(r.action).toBe("paused");
    const g = loadGoal(SID);
    expect(g.status).toBe("blocked");
    expect(g.lastError).toMatch(/429/);
  });

  test("non-retryable error blocks immediately", async () => {
    await start("auth broken task");
    const r = await engine.onIdle(SID, { error: "Invalid API key" });
    expect(r.action).toBe("paused");
    expect(loadGoal(SID).status).toBe("blocked");
  });

  test("interrupt pauses", async () => {
    await start("interruptible task");
    const r = await engine.onIdle(SID, { interrupted: true });
    expect(r.action).toBe("paused");
    expect(loadGoal(SID).pauseReason).toMatch(/interrupted/);
  });

  test("resume keeps cumulative iteration and re-kicks work", async () => {
    await start("resumable task");
    await engine.onIdle(SID, { lastText: "a", hadToolCall: true });
    await engine.handleCommand(SID, "pause");
    expect(loadGoal(SID).status).toBe("paused");
    const replies = await engine.handleCommand(SID, "resume");
    expect(replies.join("\n")).toMatch(/resumed/);
    const g = loadGoal(SID);
    expect(g.status).toBe("active");
    expect(g.iteration).toBe(1);
    expect(sentWork.length).toBeGreaterThanOrEqual(3);
  });

  test("resume refuses while over token budget", async () => {
    await start("--tokens 1k over budget task");
    usageTotal = { input: 2_001_000 + 1500, output: 0 };
    await engine.onIdle(SID, { lastText: "x", hadToolCall: true });
    const replies = await engine.handleCommand(SID, "resume");
    expect(replies.join("\n")).toMatch(/exhausted|raise/i);
    expect(loadGoal(SID).status).toBe("budget_limited");
  });

  test("systemBlock reflects lifecycle", async () => {
    expect(engine.systemBlock(SID)).toBeNull();
    await start("visible objective xyz");
    const block = engine.systemBlock(SID);
    expect(block).toContain("visible objective xyz");
    expect(block).toContain("active");
    await engine.handleCommand(SID, "pause");
    expect(engine.systemBlock(SID)).toMatch(/paused/);
  });

  test("gates run before continuation; failure becomes the next prompt", async () => {
    await start("gated task");
    await engine.handleCommand(SID, "gate add true");
    await engine.handleCommand(SID, "gate add false");
    const res = await engine.onIdle(SID, { lastText: "attempt A", hadToolCall: true });
    expect(res.action).toBe("continued");
    const fireText = sentWork[sentWork.length - 1].text;
    expect(fireText).toMatch(/Quality gate failed/);
    expect(fireText).toMatch(/\$ false/);
    expect(loadGoal(SID).iteration).toBe(1);
  });

  test("gate retries exhaust into pause", async () => {
    await start("stuck gate task");
    await engine.handleCommand(SID, "gate add false");
    for (let i = 0; i < 4; i++) {
      const r = await engine.onIdle(SID, { lastText: `distinct attempt ${i} output`, hadToolCall: true });
      if (i < 3) expect(r.action).toBe("continued");
      else {
        expect(r.action).toBe("paused");
        break;
      }
      bump();
    }
    const g = loadGoal(SID);
    expect(g.status).toBe("paused");
    expect(g.pauseReason).toMatch(/gate/);
  });

  test("passing gates let normal continuation through", async () => {
    await start("green gates task");
    await engine.handleCommand(SID, "gate add true");
    const res = await engine.onIdle(SID, { lastText: "all green", hadToolCall: true });
    expect(res.action).toBe("continued");
    expect(sentWork[sentWork.length - 1].text).not.toMatch(/Quality gate failed/);
  });

  test("noteUserActivity clears pendingContinuation", async () => {
    await start("marker task");
    expect(loadGoal(SID).pendingContinuation).toBeTruthy();
    engine.noteUserActivity(SID);
    expect(loadGoal(SID).pendingContinuation).toBeFalsy();
  });

  test("clear removes goal entirely", async () => {
    await start("doomed task");
    const replies = await engine.handleCommand(SID, "clear");
    expect(replies.join("\n")).toMatch(/cleared/i);
    expect(loadGoal(SID)).toBeNull();
    expect(engine.systemBlock(SID)).toBeNull();
  });

  test("edit updates objective without resetting usage", async () => {
    await start("--tokens 5k editable task");
    usageTotal = { input: 1512 + 1500, output: 12 };
    const before = loadGoal(SID).startedAt;
    const replies = await engine.handleCommand(SID, "edit --tokens 9k rewritten objective");
    expect(replies.join("\n")).toMatch(/updated/i);
    const g = loadGoal(SID);
    expect(g.text).toBe("rewritten objective");
    expect(g.tokenBudget).toBe(9000);
    expect(g.startedAt).toBe(before);
  });
});
