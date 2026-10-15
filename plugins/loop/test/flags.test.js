import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLoopArgs } from "../lib/parse.js";

const dir = mkdtempSync(join(tmpdir(), "loop-flags-"));
const path = join(dir, "bundle.mjs");
writeFileSync(path, readFileSync(new URL("../bundle.js", import.meta.url), "utf8") + "\nexport { parseLoopArgs };\n");
const bundled = await import(pathToFileURL(path).href);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const [name, parse] of [["source", parseLoopArgs], ["bundle", bundled.parseLoopArgs]]) {
  test(name + ": reject partial and out-of-range flag values", () => {
    for (const flag of ["--times 2oops --times 3", "--times 3 --times 2oops", "--label invalid! --label valid", "--label valid --label invalid!", "--times 2oops", "--times 0", "--times 1001", "--times 999999999999999999999999", "--label " + "a".repeat(33)]) {
      expect(parse("5m check " + flag).action).toBe("invalid");
    }
    const normal = parse("5m check --times 3 --label ops --no-immediate");
    expect(normal.times).toBe(3);
    expect(normal.label).toBe("ops");
    expect(normal.immediate).toBe(false);
  });
  test(name + ": flag-like words remain literal prompt text", () => {
    const value = parse("5m report--label --no-immediate-ish");
    expect(value.action).toBe("create");
    expect(value.prompt).toBe("report--label --no-immediate-ish");
    expect(value.immediate).toBe(true);
  });
}
