// parse — /loop argument grammar.

const ACTIONS = ["list", "stop", "pause", "resume", "status", "help"];

// "30s" "5m" "2h" "1d" "1h30m" -> ms ; "3t"/"3turn"/"3turns" -> turns
export function parseInterval(token) {
  if (/^\d+t(urns?)?$/i.test(token)) {
    const n = parseInt(token, 10);
    return Number.isSafeInteger(n) && n >= 1 ? { kind: "turns", n, raw: token.toLowerCase() } : null;
  }
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(token.toLowerCase());
  if (!m || token === "") return null;
  const [, d, h, min, s] = m;
  if (d == null && h == null && min == null && s == null) return null;
  const ms = ((+d || 0) * 86_400 + (+h || 0) * 3600 + (+min || 0) * 60 + (+s || 0)) * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return { kind: "time", ms, raw: token.toLowerCase() };
}

// Returns {action} or {action:"create", ...} or {action:"invalid", error}.
export function parseLoopArgs(rawArgs) {
  let input = String(rawArgs ?? "").trim();
  // Command renderers may wrap $ARGUMENTS in quotes; strip one symmetric layer.
  if (input.length > 1 && ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'")))) {
    input = input.slice(1, -1).trim();
  }
  if (!input) return { action: "status" };
  if (input === "help" || input === "--help" || input === "-h") return { action: "help" };

  // Subcommand path: list [--all] | stop|pause|resume|status [idOrLabel]
  const firstToken = input.split(/\s+/)[0];
  if (ACTIONS.includes(firstToken)) {
    const rest = input.slice(firstToken.length).trim();
    if (firstToken === "list") return { action: "list", all: rest === "--all" || rest === "-a" };
    if (firstToken === "help") return { action: "help" };
    return { action: firstToken, idOrLabel: rest || undefined };
  }

  // Creation: [interval] prompt... --label x --times N --no-immediate
  let text = input;
  let label;
  let times;
  let immediate = true;
  const labelM = /(?:^|\s)--label\s+([A-Za-z0-9._-]{1,32})(?=\s|$)/.exec(text);
  if (labelM) {
    label = labelM[1];
    text = text.replace(labelM[0], "");
    if (/(?:^|\s)--label(?:\s|$)/.test(text)) return { action: "invalid", error: "--label must be specified once" };
  } else if (/(?:^|\s)--label(?:\s|$)/.test(text)) {
    return { action: "invalid", error: "--label needs a value: letters, digits, dot, dash, underscore (max 32 chars)" };
  }
  const timesM = /(?:^|\s)--times\s+(\d+)(?=\s|$)/.exec(text);
  if (timesM) {
    times = parseInt(timesM[1], 10);
    if (!Number.isSafeInteger(times) || times < 1 || times > 1000) {
      return { action: "invalid", error: "--times needs an integer from 1 to 1000" };
    }
    text = text.replace(timesM[0], "");
    if (/(?:^|\s)--times(?:\s|$)/.test(text)) return { action: "invalid", error: "--times must be specified once" };
  } else if (/(?:^|\s)--times(?:\s|$)/.test(text)) {
    return { action: "invalid", error: "--times needs a number (max 1000)" };
  }
  if (/(?:^|\s)--no-immediate(?=\s|$)/.test(text)) {
    immediate = false;
    text = text.replace(/(?:^|\s)--no-immediate(?=\s|$)/g, "");
  }
  text = text.trim();

  const tokens = text.split(/\s+/);
  // A quoted interval like "8s at string start survives outer-strip; clean the token.
  if (tokens[0]) tokens[0] = tokens[0].replace(/^["']+|["']+$/g, "");
  const maybeInterval = parseInterval(tokens[0] ?? "");
  if (!maybeInterval) {
    if (/^\d+$/.test(tokens[0] ?? "")) {
      return { action: "invalid", error: `bare number "${tokens[0]}" has no unit - use e.g. 5m or 3t` };
    }
    return {
      action: "invalid",
      error: 'first token must be an interval like 30s / 5m / 2h / 1d / 1h30m or a turn count like 3t, followed by the prompt. Example: /loop 5m check CI status',
    };
  }
  const prompt = tokens.slice(1).join(" ").trim();
  if (!prompt) return { action: "invalid", error: "prompt required after the interval: /loop 5m check CI status" };

  return { action: "create", prompt, interval: maybeInterval, label: label ?? null, times: times ?? null, immediate };
}
