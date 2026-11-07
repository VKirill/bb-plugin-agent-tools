import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceHubOnly, loadableHubNames, machineNotOnHub, type HubOnlyDeps } from "../hub-only.ts";

function deps(overrides: Partial<HubOnlyDeps> = {}): HubOnlyDeps & { cleaned: string[] } {
  const cleaned: string[] = [];
  return {
    cleaned,
    hosts: async () => [{ hostId: "a", hostName: "A" }],
    refresh: async () => ({
      notOnHub: [{ name: "browser-qa", path: "/a/browser-qa" }],
      homes: [{ id: "agents", path: "~/.agents/skills", skills: 1, links: 0 }],
      error: null,
    }),
    importSkill: async () => ({
      ok: false,
      error: "invalid",
      problems: [{ code: "frontmatter-yaml", detail: "mapping values are not allowed here", blocking: true }],
    }),
    cleanup: async (hostId) => {
      cleaned.push(hostId);
      return { backup: "/backup/a", moved: [{ id: "agents", count: 1 }], errors: [] };
    },
    log: () => {},
    ...overrides,
  };
}

test("blocking rejection keeps the machine and names the skill", async () => {
  const d = deps();
  const report = await enforceHubOnly(d);
  assert.deepEqual(d.cleaned, []);
  assert.equal(report[0]!.cleanup, null);
  assert.deepEqual(report[0]!.rejected, [
    { name: "browser-qa", reason: "mapping values are not allowed here" },
  ]);
  assert.match(String(report[0]!.skipped), /BB не загружает: browser-qa \(frontmatter-yaml: mapping values are not allowed here\)/);
});

test("machineNotOnHub lists a skill whose hub copy has a blocking problem", () => {
  const found = [
    { name: "broken", path: "/m/broken", home: "agents" },
    { name: "fine", path: "/m/fine", home: "agents" },
  ];
  const listed = machineNotOnHub(found, [
    { name: "broken", problems: [{ blocking: true }] },
    { name: "fine", problems: [] },
  ]);
  assert.deepEqual(listed, [{ name: "broken", path: "/m/broken", home: "agents" }]);
});

test("loadableHubNames keeps non-blocking problems and a missing problems field", () => {
  const names = loadableHubNames([
    { name: "warn", problems: [{ blocking: false }] },
    { name: "plain" },
    { name: "blocked", problems: [{ blocking: true }] },
  ]);
  assert.deepEqual([...names].sort(), ["plain", "warn"]);
});
