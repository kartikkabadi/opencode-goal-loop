// parse — /goal argument parsing, contract extraction, budget parsing.

const FIELD_PREFIXES = [
  ["verify:", "verify"], ["verified by:", "verify"], ["verification:", "verify"],
  ["constraints:", "constraints"], ["preserve:", "constraints"], ["constraint:", "constraints"],
  ["boundaries:", "boundaries"], ["boundary:", "boundaries"], ["scope:", "boundaries"],
  ["stop when:", "stopWhen"], ["stop_when:", "stopWhen"], ["blocked:", "stopWhen"],
];

// Splits a goal string into headline + structured contract fields.
// Field lines run until the next recognized field prefix. Unknown colons are left alone.
export function extractContract(text) {
  const lines = String(text ?? "").split("\n");
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
      contract[current] = contract[current] ? `${contract[current]}\n${trimmed}` : trimmed;
    } else if (!current && trimmed) {
      headline.push(line);
    }
  }
  return { headline: headline.join("\n").trim(), contract };
}

export function parseTokenBudget(s) {
  if (s == null) return null;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(String(s).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2].toLowerCase() === "k" ? 1_000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1;
  const out = Math.round(n * mult);
  return Number.isSafeInteger(out) && out > 0 ? out : null;
}

const ACTIONS = ["status", "pause", "resume", "clear", "stop", "edit", "gate", "help"];

// Parses everything after "/goal".
// Returns {action, ...} — action one of: start | edit | status | pause | resume | clear | gate | help
export function parseGoalArgs(raw) {
  let input = String(raw ?? "").trim();
  // Command renderers may wrap $ARGUMENTS in quotes; strip one symmetric layer.
  if (input.length > 1 && ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'")))) {
    input = input.slice(1, -1).trim();
  }
  if (!input) return { action: "status" };
  if (input === "help" || input === "--help" || input === "-h") return { action: "help" };

  // gate subcommand: /goal gate [add <cmd> | list | remove <n> | clear]
  const gateMatch = /^gate(\s+.*)?$/.exec(input);
  if (gateMatch) {
    const rest = (gateMatch[1] ?? "").trim();
    if (!rest || rest === "list") return { action: "gate", op: "list" };
    const add = /^add\s+(.+)$/.exec(rest);
    if (add) return { action: "gate", op: "add", cmd: add[1].trim() };
    const rm = /^(?:remove|rm)\s+(\d+)$/.exec(rest);
    if (rm) return { action: "gate", op: "remove", index: parseInt(rm[1], 10) };
    if (rest === "clear") return { action: "gate", op: "clear" };
    return { action: "gate", op: "invalid", error: `unknown gate subcommand: ${rest}` };
  }

  // Flags may appear anywhere: --tokens 100k --turns 25
  let text = input;
  let tokenBudget;
  let turnBudget;
  const flagRe = /--tokens\s+(\S+)|--turns\s+(\d+)/gi;
  let m;
  while ((m = flagRe.exec(input))) {
    if (m[1] != null) {
      const v = parseTokenBudget(m[1]);
      if (v == null) return { action: "invalid", error: `bad --tokens value "${m[1]}" (use e.g. 100k, 2m, 500000)` };
      tokenBudget = v;
    } else {
      turnBudget = parseInt(m[2], 10);
    }
  }
  text = text.replace(/--tokens\s+\S+/gi, "").replace(/--turns\s+\d+/gi, "").trim();

  const firstWord = text.split(/\s+/)[0]?.toLowerCase();
  if (ACTIONS.includes(firstWord)) {
    const rest = text.slice(firstWord.length).trim();
    if (firstWord === "stop") return { action: "clear" };
    if (firstWord === "edit") {
      if (!rest) return { action: "invalid", error: "usage: /goal edit <new objective>" };
      const c = extractContract(rest);
      return { action: "edit", text: c.headline, contract: c.contract, tokenBudget, turnBudget };
    }
    return { action: firstWord };
  }

  if (!text) return { action: "status" };
  const c = extractContract(text);
  return { action: "start", text: c.headline, contract: c.contract, tokenBudget: tokenBudget ?? null, turnBudget: turnBudget ?? null };
}
