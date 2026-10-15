import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadStore, newLoop, storePath } from "../lib/store.js";

const bundleDir = mkdtempSync(join(tmpdir(), "loop-store-bundle-"));
const bundlePath = join(bundleDir, "bundle.mjs");
writeFileSync(bundlePath, readFileSync(new URL("../bundle.js", import.meta.url), "utf8") + "\nexport { loadStore, storePath };\n");
const bundled = await import(pathToFileURL(bundlePath).href);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

for (const [name, load] of [["source", loadStore], ["bundle", bundled.loadStore]]) {
  test(name + ": malformed records do not erase healthy loops", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-store-records-"));
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      const valid = newLoop({ sessionId: "ses_good", prompt: "Check progress", interval: { kind: "time", ms: 10000, raw: "10s" } });
      const path = storePath();
      mkdirSync(dirname(path), { recursive: true });
      for (const malformed of [null, 42, { ...valid, updatedAt: { toString: null } }, { ...valid, updatedAt: 42 }, { ...valid, updatedAt: "invalid" }, { ...valid, updatedAt: null, createdAt: null }, { ...valid, id: null }, { ...valid, interval: null }, { ...valid, interval: { kind: "time", ms: -1 } }]) {
        writeFileSync(path, JSON.stringify({ version: 1, loops: [valid, malformed] }));
        const records = load();
        expect(records.length).toBe(1);
        expect(records[0].id).toBe(valid.id);
        expect(JSON.parse(readFileSync(path, "utf8")).loops.length).toBe(1);
      }
    } finally {
      if (old === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
