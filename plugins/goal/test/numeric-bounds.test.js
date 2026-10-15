import { expect, test } from "bun:test";
import { parseTokenBudget } from "../lib/parse.js";
import { parseInterval } from "../../loop/lib/parse.js";

test("unrepresentable budgets and cadences are rejected", () => {
  for (const value of ["9".repeat(400), "9007199254740993", "9007199254740991m"]) {
    expect(parseTokenBudget(value)).toBeNull();
  }
  for (const value of ["9".repeat(400) + "s", "9007199254740993t", "9007199254740991d"]) {
    expect(parseInterval(value)).toBeNull();
  }
  expect(parseTokenBudget("100k")).toBe(100000);
  expect(parseInterval("5m").ms).toBe(300000);
});
