import { describe, test, expect } from "bun:test";
import { extractContract, parseTokenBudget, parseGoalArgs } from "../lib/parse.js";

describe("extractContract", () => {
  test("plain objective keeps headline, null contract", () => {
    const r = extractContract("Fix every lint error in src/");
    expect(r.headline).toBe("Fix every lint error in src/");
    expect(r.contract).toEqual({ verify: null, constraints: null, boundaries: null, stopWhen: null });
  });

  test("field lines populate contract", () => {
    const r = extractContract("Migrate auth to JWT\nverify: pytest tests/auth passes\nconstraints: keep /login response shape\nboundaries: only services/auth\nstop when: DB schema migration required");
    expect(r.headline).toBe("Migrate auth to JWT");
    expect(r.contract.verify).toBe("pytest tests/auth passes");
    expect(r.contract.constraints).toBe("keep /login response shape");
    expect(r.contract.boundaries).toBe("only services/auth");
    expect(r.contract.stopWhen).toBe("DB schema migration required");
  });

  test("multi-line field continuation until next field prefix", () => {
    const r = extractContract("Objective here\nverify: run bun test\nand also bun typecheck\nconstraints: no new deps");
    expect(r.contract.verify).toBe("run bun test\nand also bun typecheck");
    expect(r.contract.constraints).toBe("no new deps");
  });

  test("unknown colon line stays in headline", () => {
    const r = extractContract("Fix bug: parser drops commas");
    expect(r.headline).toBe("Fix bug: parser drops commas");
    expect(r.contract.verify).toBeNull();
  });

  test("aliases and case-insensitivity", () => {
    const r = extractContract("obj\nVerified By: ci green\nSCOPE: src only");
    expect(r.contract.verify).toBe("ci green");
    expect(r.contract.boundaries).toBe("src only");
  });
});

describe("parseTokenBudget", () => {
  test("k/m/bare values", () => {
    expect(parseTokenBudget("100k")).toBe(100_000);
    expect(parseTokenBudget("2m")).toBe(2_000_000);
    expect(parseTokenBudget("500000")).toBe(500_000);
    expect(parseTokenBudget("100K")).toBe(100_000);
  });
  test("invalid values -> null", () => {
    expect(parseTokenBudget("0k")).toBeNull();
    expect(parseTokenBudget("abc")).toBeNull();
    expect(parseTokenBudget(null)).toBeNull();
    expect(parseTokenBudget("-5k")).toBeNull();
  });
});

describe("parseGoalArgs", () => {
  test("empty -> status", () => {
    expect(parseGoalArgs("").action).toBe("status");
    expect(parseGoalArgs("   ").action).toBe("status");
  });
  test("help variants", () => {
    expect(parseGoalArgs("help").action).toBe("help");
    expect(parseGoalArgs("--help").action).toBe("help");
  });
  test("lifecycle actions", () => {
    expect(parseGoalArgs("pause").action).toBe("pause");
    expect(parseGoalArgs("resume").action).toBe("resume");
    expect(parseGoalArgs("clear").action).toBe("clear");
    expect(parseGoalArgs("stop").action).toBe("clear");
    expect(parseGoalArgs("status").action).toBe("status");
  });
  test("edit requires text", () => {
    expect(parseGoalArgs("edit").action).toBe("invalid");
    const e = parseGoalArgs("edit new objective text");
    expect(e.action).toBe("edit");
    expect(e.text).toBe("new objective text");
  });
  test("start with flags stripped anywhere", () => {
    const r = parseGoalArgs("--tokens 100k fix the bug --turns 40");
    expect(r.action).toBe("start");
    expect(r.tokenBudget).toBe(100_000);
    expect(r.turnBudget).toBe(40);
    expect(r.text).toBe("fix the bug");
  });
  test("bad tokens value -> invalid with hint", () => {
    const r = parseGoalArgs("--tokens bananas fix it");
    expect(r.action).toBe("invalid");
    expect(r.error).toMatch(/--tokens/);
  });
  test("gate subcommands", () => {
    expect(parseGoalArgs("gate").action).toBe("gate");
    expect(parseGoalArgs("gate").op).toBe("list");
    expect(parseGoalArgs("gate list").op).toBe("list");
    const a = parseGoalArgs("gate add bun test");
    expect(a.op).toBe("add");
    expect(a.cmd).toBe("bun test");
    expect(parseGoalArgs("gate remove 2").op).toBe("remove");
    expect(parseGoalArgs("gate remove 2").index).toBe(2);
    expect(parseGoalArgs("gate clear").op).toBe("clear");
    expect(parseGoalArgs("gate bogus").op).toBe("invalid");
  });
});
