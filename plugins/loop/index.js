// Adapter for OpenCode2 beta (domain-context API).
import { LoopEngine } from "./lib/engine.js";

const log = (...a) => console.error("[opencode-loop]", ...a);
const NEUTRAL = "(loop command handled by the loop plugin)";

export default {
  id: "opencode-loop",
  setup: async (ctx) => {
    // Beta loads setup several times per run; first successful setup wins.
    if (globalThis.__opencode_loop_active) return;

    const trackers = new Map(); // sid -> lastText
    const busy = new Map(); // sid -> bool
    const seenInbox = new Set();

    // Goal interplay is optional: if the goal plugin is absent, loops never defer.
    let loadGoal = null;
    for (const cand of ["../goal/lib/state.js", "../goal-fresh/lib/state.js", "../opencode-goal/lib/state.js"]) {
      try {
        ({ loadGoal } = await import(cand));
        break;
      } catch {}
    }

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
          await ctx.session.synthetic({ sessionID: sid, text, description: "loop" });
        } catch {
          try { await ctx.session.prompt({ sessionID: sid, text }); } catch {}
        }
      },
      async isBusy(sid) {
        return busy.get(sid) ?? false;
      },
      async goalActive(sid) {
        if (!loadGoal) return false;
        try { return loadGoal(sid)?.status === "active"; } catch { return false; }
      },
    };

    const engine = new LoopEngine(ports);

    const seenEvent = (id) => {
      if (id == null) return false;
      if (seenInbox.has(id)) return true;
      if (seenInbox.size >= 500) seenInbox.delete(seenInbox.values().next().value);
      seenInbox.add(id);
      return false;
    };

    async function handleEvent(evt) {
      const type = String(evt?.type ?? "");
      const d = evt?.data ?? {};
      const p = evt?.properties ?? {};
      const sid = d.sessionID ?? p.sessionID;

      if (type === "session.execution.started") {
        if (sid) busy.set(sid, true);
        return;
      }
      if (type === "session.text.ended") {
        const text = d.text ?? d.part?.text;
        if (sid && typeof text === "string" && text) {
          const t = trackers.get(sid) ?? { lastText: "", saw: false };
          t.lastText = text;
          t.saw = true;
          trackers.set(sid, t);
        }
        return;
      }
      if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
        if (sid) {
          const t = trackers.get(sid) ?? { lastText: "", saw: false };
          t.saw = true;
          trackers.set(sid, t);
        }
        return;
      }
      if (type === "session.idle" || type === "session.execution.succeeded") {
        if (!sid) return;
        busy.set(sid, false);
        const t = trackers.get(sid);
        trackers.delete(sid);
        // Ghost idle (no assistant activity) is not a completed turn.
        if (t?.saw) await engine.onTurnCompleted(sid, { lastText: t.lastText });
        return;
      }
      if (type === "session.execution.failed" || type === "session.execution.interrupted") {
        if (!sid) return;
        busy.set(sid, false);
        await engine.onTurnCompleted(sid, { lastText: "" });
        return;
      }
      if (type === "session.deleted") {
        if (sid) {
          trackers.delete(sid);
          busy.delete(sid);
          engine.forgetSession(sid);
        }
        return;
      }
      if (type === "session.inbox.enqueued" || type === "session.inbox.delivered") {
        const text = String(d.text ?? d.message?.text ?? "").trim();
        if (!sid || (text !== "/loop" && !text.startsWith("/loop "))) return;
        if (seenEvent(evt?.id)) return;
        const replies = await engine.handleCommand(sid, text.slice(5));
        for (const r of replies) await ports.sendNote(sid, r);
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
        if (!sid) return;
        const msgs = Array.isArray(sc.messages) ? sc.messages : [];
        for (const m of msgs) {
          if (m?.role !== "user") continue;
          const content = m.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.filter((pt) => pt?.type === "text").map((pt) => pt.text ?? "").join("")
                : "";
          const t = text.trim();
          if (t === "/loop" || t.startsWith("/loop ")) {
            if (typeof content === "string") m.content = NEUTRAL;
            else if (Array.isArray(content)) for (const pt of content) if (pt?.type === "text") pt.text = NEUTRAL;
          }
        }
      } catch {}
    });

    await ctx.tool.transform((draft) =>
      draft.add({
        name: "loop_stop",
        description: "Stop an active /loop in this session (most recent one, or match by label/id). Use when the recurring task is finished.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Loop id prefix or label; omit for the most recent loop" },
          },
        },
        execute: async (args, tctx) => {
          const sid = tctx?.sessionID ?? tctx?.sessionId;
          return engine.toolStop(sid, args?.id);
        },
      }),
    );

    engine.armAll();
    globalThis.__opencode_loop_active = true;
  },
};
