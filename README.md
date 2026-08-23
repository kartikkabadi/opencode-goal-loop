# opencode-goal-loop

Codex-style `/goal` and `/loop` commands for [opencode](https://opencode.ai).

- **/goal** — set a persistent objective. The agent keeps working across turns until
  concrete evidence says done. No turn or token limits by default; it stops when the
  model calls `goal_complete` with evidence, replies `BLOCKED:`, or you interrupt.
  Optional contract fields (`verify:` `constraints:` `boundaries:` `stop when:`),
  opt-in budgets (`--tokens 200k --turns 40`), and deterministic quality gates
  that must exit 0 before completion.

- **/loop** — repeat a prompt on a time interval (`30s 5m 2h 1d 1h30m`) or turn
  cadence (`3t`). Runs until the model ends a reply with `LOOP_COMPLETE` or you
  stop it — no fire caps by default (`--times N` opts back in). Loops defer while
  an active goal owns the session, and back off while the session is busy.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/kartikkabadi/opencode-goal-loop/main/install.sh | bash
```

Then restart opencode (or start a new session).

The installer copies two self-contained plugins into `~/.config/opencode/plugins-local/`,
adds command templates, and registers them in your `opencode.jsonc` / `opencode.json`.
Idempotent: re-running upgrades in place.

Requires: an existing opencode install, `node` on PATH, `curl` or `wget`.

## Usage

```sh
/goal fix the flaky auth test
/goal verify: bun test constraints: no new deps boundaries: src/auth only stop when: CI is green
/goal --tokens 200k --turns 40 migrate the db layer
/goal status | pause | resume | clear | edit <text> | help
/goal gate add bun test          # must exit 0 before the goal can complete
/goal gate list | remove <n> | clear

/loop 5m check my PR, address review comments, fix failing CI
/loop 1t triage new inbox items
/loop --label ci --times 20 5m watch CI and fix failures
/loop list [--all] | stop | pause | resume [id|label] | help
```

While a goal is active the model gets a `goal_complete` tool; it may only end the
goal by calling it with real evidence (files changed, tests run, command output).
Stuck loops are nudged once to act, then paused instead of burning tokens.
State lives under `~/.local/share/opencode/goal-loop/` and survives restarts.

## How it works

Both plugins subscribe to session events (idle, tool calls, interrupts) through the
opencode plugin API and inject continuations at safe turn boundaries. Each is one
directory: a prebuilt `bundle.js` entry plus readable `lib/` sources and `bun test`
suites in `test/`.

## Uninstall

Remove the two entries from the `plugin` array in your opencode config, then:

```sh
rm -rf ~/.config/opencode/plugins-local/goal ~/.config/opencode/plugins-local/loop
```

## License

MIT
