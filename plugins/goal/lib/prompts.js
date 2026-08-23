// prompts — every model-facing and human-facing string for /goal lives here.

function fmtTokens(n) {
  if (n == null) return "unknown";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function contractLines(contract) {
  const out = [];
  if (contract?.verify) out.push(`Verification surface: ${contract.verify}`);
  if (contract?.constraints) out.push(`Constraints (must not regress): ${contract.constraints}`);
  if (contract?.boundaries) out.push(`Boundaries (allowed scope): ${contract.boundaries}`);
  if (contract?.stopWhen) out.push(`Stop and report when: ${contract.stopWhen}`);
  return out;
}

export function systemBlock(goal) {
  const lines = [
    `# Active goal (${goal.status})`,
    "",
    goal.text,
    "",
    ...contractLines(goal.contract),
    "",
    `Progress: ${goal.iteration}/${goal.turnBudget ?? "unlimited"} automatic continuations used` +
      (goal.tokensUsed != null ? `, ~${fmtTokens(goal.tokensUsed)} tokens above baseline` : ""),
  ];
  if (goal.status === "active") {
    lines.push(
      "",
      "Rules while the goal is active:",
      "- Keep working toward the goal across turns. Do not stop to ask whether to continue.",
      "- Before claiming done, audit the objective against concrete evidence: files changed, command output, tests run, artifacts produced.",
      "- Call the goal_complete tool ONLY when the objective is fully met and verified; pass the evidence as the argument.",
      `- If genuinely blocked, say "BLOCKED: <reason> and what would unblock it" and stop; do not invent progress.`,
    );
  } else if (goal.status === "paused") {
    lines.push("", `The goal is paused (${goal.pauseReason ?? "by user"}). Automatic continuation is off; wait for the user.`);
  } else if (goal.status === "budget_limited") {
    lines.push("", "The goal hit its budget. Do not start substantive new work; summarize progress, blockers, and the next step if asked.");
  } else if (goal.status === "blocked") {
    lines.push("", `The goal is blocked: ${goal.lastError ?? "unknown reason"}. Wait for the user.`);
  }
  return lines.join("\n");
}

export function continuationPrompt(goal, n) {
  const head =
    n <= 1
      ? "Begin working toward the active goal now."
      : `Continue working toward the active goal (automatic continuation #${n}).`;
  const verify = goal.contract?.verify ? `\nProve progress against: ${goal.contract.verify}` : "";
  const stopWhen = goal.contract?.stopWhen ? `\nIf this applies — "${goal.contract.stopWhen}" — stop and report it plainly.` : "";
  return [
    `[goal] ${head}`,
    "",
    goal.text,
    verify,
    stopWhen,
    "",
    "First re-read the current state (files, test output, logs) instead of assuming it. Then take the next concrete action.",
    "If the objective is fully met and verified, call goal_complete with the evidence. If blocked, reply starting with BLOCKED: and the reason.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export function gateFailurePrompt(goal, results) {
  const failed = results.filter((r) => r.exit !== 0);
  const tails = failed
    .map((r) => `$ ${r.cmd}\nexit ${r.exit}\n${r.tail.slice(-1200)}`)
    .join("\n\n");
  return [
    "[goal] Quality gate failed — the goal cannot be considered complete while these fail.",
    "",
    tails,
    "",
    "Fix the failures these commands expose, then continue toward the goal. Re-run the gate commands yourself to check before claiming done.",
  ].join("\n");
}

export function statusText(goal) {
  const age = Math.max(0, Date.now() - Date.parse(goal.startedAt));
  const mins = Math.floor(age / 60000);
  const hours = Math.floor(mins / 60);
  const ageStr = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;
  const lines = [
    `Goal [${goal.status}] ${goal.id.slice(0, 8)}`,
    goal.text,
    "",
    `Started: ${ageStr} ago | Continuations: ${goal.iteration}${goal.turnBudget ? `/${goal.turnBudget}` : ""} | Tokens: ~${fmtTokens(goal.tokensUsed)}${goal.tokenBudget ? `/${fmtTokens(goal.tokenBudget)}` : ""}`,
  ];
  for (const l of contractLines(goal.contract)) lines.push(l);
  if (goal.gates.length) lines.push(`Gates: ${goal.gates.map((g) => g.cmd).join(" ; ")}`);
  if (goal.pauseReason) lines.push(`Pause reason: ${goal.pauseReason}`);
  if (goal.lastError && goal.status !== "blocked") lines.push(`Last error: ${goal.lastError}`);
  if (goal.completionEvidence) lines.push(`Completed with evidence: ${goal.completionEvidence.slice(0, 300)}`);
  return lines.join("\n");
}

export const HELP = `usage:
  /goal <objective>                    start working toward an objective (kicks off the first turn)
  /goal verify: <cmd>                  optional contract fields inside the objective text:
                                         verify: / constraints: / boundaries: / stop when:
  /goal --tokens 200k --turns 40 <obj> optional caps — none by default; it runs until done
  /goal                                show current goal and usage
  /goal pause | resume | clear         lifecycle controls
  /goal edit [--tokens X] <new text>   change the objective without resetting usage
  /goal gate add <shell cmd>           deterministic check that must exit 0 before the goal can complete
  /goal gate [list] | remove <n> | clear
statuses: active | paused | blocked | budget_limited | complete`;

export function startedNote(goal) {
  const b = [];
  b.push(`Goal set [active]: ${goal.text}`);
  for (const l of contractLines(goal.contract)) b.push(l);
  b.push(`Budgets: ${goal.turnBudget ?? "unlimited"} continuations` + (goal.tokenBudget ? `, ${fmtTokens(goal.tokenBudget)} tokens` : ""));
  if (goal.gates.length) b.push(`Gates: ${goal.gates.map((g) => g.cmd).join(" ; ")}`);
  return b.join("\n");
}
