// Adapter for OpenCode2 beta (domain-context API).
// Wraps the runtime-agnostic engine in ./lib/ with ctx-domain ports.
import { GoalEngine } from "./lib/engine.js";
import fs from "fs";
const dbg = (m) => { try { fs.appendFileSync("/tmp/probe/goaldbg.log", m + "\n"); } catch {} };

const log = (...a) => console.error("[opencode-goal]", ...a);
const NEUTRAL = "(goal command handled by the goal plugin)";

export default {
  id: "opencode-goal",
  setup: async (ctx) => {
    dbg("setup entered active=" + !!globalThis.__opencode_goal_active);
    if (globalThis.__opencode_goal_active) return;

    const trackers = new Map(); // sid -> {lastText, sawTool}
    const seenInbox = new Set(); // inbox event ids already handled (cap 500, FIFO)

    const track = (sid) => {
      let t = trackers.get(sid);
      if (!t) trackers.set(sid, (t = { lastText: "", sawTool: false }));
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
            if (!u || typeof u !== "object") continue;
            const input = u.input ?? u.inputTokens ?? u.in;
            const output = u.output ?? u.outputTokens ?? u.out;
            if (Number.isFinite(input) && Number.isFinite(output)) return { input, output };
          }
          return null;
        } catch {
          return null;
        }
      },
      getCwd: () => process.cwd(),
    };

    const engine = new GoalEngine(ports);

    const seenEvent = (id) => {
      if (id == null) return false;
      if (seenInbox.has(id)) return true;
      if (seenInbox.size >= 500) seenInbox.delete(seenInbox.values().next().value);
      seenInbox.add(id);
      return false;
    };

    async function handleEvent(evt) {
      const type = String(evt?.type ?? "");
      if (!type.includes("text") && !type.includes("delta") && !type.includes("heartbeat")) dbg("evt: " + type);
      const d = evt?.data ?? {};
      const p = evt?.properties ?? {};
      const sid = d.sessionID ?? p.sessionID;

      if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
        if (sid) track(sid).sawTool = true;
        return;
      }
      if (type === "session.text.ended") {
        const text = d.text ?? d.part?.text;
        if (sid && typeof text === "string" && text) track(sid).lastText = text;
        return;
      }
      if (type === "session.idle" || type === "session.execution.succeeded") {
        if (!sid) return;
        const t = trackers.get(sid);
        trackers.delete(sid);
        await engine.onIdle(sid, {
          lastText: t?.lastText ?? "",
          hadToolCall: t?.sawTool ?? false,
          sawActivity: t != null,
        });
        return;
      }
      if (type === "session.execution.failed") {
        if (sid) await engine.onIdle(sid, { error: d.error ?? d.message ?? "execution failed" });
        return;
      }
      if (type === "session.execution.interrupted") {
        if (sid) engine.interrupt(sid, "interrupted");
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
        dbg("inbox text=<" + text.slice(0,60) + "> sid=" + !!sid);
        if (!sid || (text !== "/goal" && !text.startsWith("/goal "))) return;
        if (seenEvent(evt?.id)) return;
        const replies = await engine.handleCommand(sid, text.slice(5));
        for (const r of replies) await ports.sendNote(sid, r);
      }
    }

    // Process-lifetime drain; a bad event must never kill the loop.
    const stream = ctx.event.subscribe();
    (async () => {
      for await (const evt of stream) {
        try {
          await handleEvent(evt);
        } catch {}
      }
    })();

    // Runs on EVERY request: inject the system block, neutralize raw /goal
    // commands, and record real user activity.
    await ctx.session.hook("context", async (sc) => {
      try {
        const sid = sc?.sessionID;
        if (!sid) return;
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
          if (m?.role !== "user") continue;
          const content = m.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((pt) => pt?.type === "text")
                    .map((pt) => pt.text ?? "")
                    .join("")
                : "";
          const t = text.trim();
          if (t === "/goal" || t.startsWith("/goal ")) {
            if (typeof content === "string") m.content = NEUTRAL;
            else if (Array.isArray(content)) for (const pt of content) if (pt?.type === "text") pt.text = NEUTRAL;
          } else if (t && !t.startsWith("[goal]") && !t.startsWith(NEUTRAL)) {
            engine.noteUserActivity(sid);
          }
        }
      } catch {}
    });

    await ctx.tool.transform((draft) =>
      draft.add({
        name: "goal_complete",
        description:
          "Mark the active /goal complete. Call ONLY after auditing the objective against concrete evidence (files changed, tests run, command output, artifacts). Pass the evidence.",
        promptSnippet: "Call goal_complete only when the active goal is fully met and verified",
        parameters: {
          type: "object",
          properties: {
            evidence: { type: "string", description: "Concrete evidence the objective is met" },
          },
          required: ["evidence"],
        },
        execute: async (args, tctx) => {
          const sid = tctx?.sessionID ?? tctx?.sessionId;
          const res = await engine.complete(sid, args?.evidence);
          return res.text;
        },
      }),
    );

    globalThis.__opencode_goal_active = true;
  },
};
