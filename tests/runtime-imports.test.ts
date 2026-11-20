import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Issue #2: a managed install has no node_modules, so server/host code may only
// import Node built-ins, the host-provided SDK, or bundled `dependencies`.
test("server and host code import nothing a managed install lacks", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const deps = Object.keys(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies ?? {});
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith(".ts")),
    ...readdirSync(path.join(root, "skill-suggest")).filter((f) => f.endsWith(".ts")).map((f) => `skill-suggest/${f}`),
  ];
  const bad: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    const imports = /^\s*(?:import|export)\s[^;"]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm;
    for (const match of source.matchAll(imports)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith(".")) continue;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (spec.startsWith("node:") || pkg === "@get-bb/plugin-sdk" || deps.includes(pkg)) continue;
      bad.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("node:sqlite is reachable without a flag on this runtime", () => {
  assert.ok(process.getBuiltinModule?.("node:sqlite")?.DatabaseSync);
});
