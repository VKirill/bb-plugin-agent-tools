import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceHubOnly, type HubOnlyDeps, type HubOnlyReport } from "../hub-only.ts";

type RefreshResult = {
  notOnHub: Array<{ name: string; path: string }>;
  homes: Array<{ id: string; path: string; skills: number; links: number }>;
  error: string | null;
};

function deps(overrides: Partial<HubOnlyDeps> = {}): HubOnlyDeps & { cleaned: string[]; calls: string[] } {
  const cleaned: string[] = [];
  const calls: string[] = [];
  return {
    cleaned,
    calls,
    hosts: async () => [
      { hostId: "a", hostName: "A" },
      { hostId: "b", hostName: "B" },
      { hostId: "c", hostName: "C" },
    ],
    refresh: async (hostId) => {
      calls.push(`refresh:${hostId}`);
      if (hostId === "c") return { notOnHub: [], homes: [], error: "host offline" };
      if (hostId === "a") {
        return {
          notOnHub: [
            { name: "x", path: "/a/x" },
            { name: "y", path: "/a/y" },
          ],
          homes: [{ id: "agents", path: "~/.agents/skills", skills: 2, links: 0 }],
          error: null,
        };
      }
      return {
        notOnHub: [{ name: "z", path: "/b/z" }],
        homes: [{ id: "claude", path: "~/.claude/skills", skills: 1, links: 0 }],
        error: null,
      };
    },
    importSkill: async (hostId, skill) => {
      calls.push(`import:${hostId}:${skill.name}`);
      if (skill.name === "x") return { ok: true, error: null, problems: [] };
      if (skill.name === "y") {
        return { ok: false, error: "invalid", problems: [{ code: "frontmatter", detail: "no name", blocking: true }] };
      }
      return { ok: false, error: "git push failed", problems: [] };
    },
    cleanup: async (hostId) => {
      cleaned.push(hostId);
      calls.push(`cleanup:${hostId}`);
      return { backup: `/backup/${hostId}`, moved: [{ id: "agents", count: 2 }], errors: [] };
    },
    log: () => {},
    ...overrides,
  };
}

test("imports what the hub lacks, rejects blocking problems, cleans only safe machines", async () => {
  const d = deps();
  const report = await enforceHubOnly(d);
  assert.deepEqual(d.cleaned, ["a"], "only machine A may be cleaned");
  const byHost = Object.fromEntries(report.map((row) => [row.hostId, row]));
  assert.deepEqual(byHost.a.imported, ["x"]);
  assert.deepEqual(byHost.a.rejected.map((row) => row.name), ["y"]);
  assert.equal(byHost.a.skipped, null);
  assert.ok(byHost.a.cleanup !== null && byHost.a.cleanup.backup === "/backup/a");
  assert.equal(byHost.b.cleanup, null);
  assert.match(String(byHost.b.skipped), /z/);
  assert.match(String(byHost.b.skipped), /git push failed/);
  assert.equal(byHost.c.cleanup, null);
  assert.match(String(byHost.c.skipped), /offline/);
});

test("an empty machine is still cleaned so the hub marker is written", async () => {
  const d = deps({
    hosts: async () => [{ hostId: "e", hostName: "E" }],
    refresh: async () => ({ notOnHub: [], homes: [], error: null }),
  });
  const report = await enforceHubOnly(d);
  assert.deepEqual(d.cleaned, ["e"]);
  assert.equal(report[0]!.skipped, null);
  assert.ok(report[0]!.cleanup !== null);
});

test("a dep that throws for one machine does not stop the others", async () => {
  const d = deps({
    refresh: async (hostId): Promise<RefreshResult> => {
      if (hostId === "b") throw new Error("boom on B");
      if (hostId === "a") {
        return { notOnHub: [{ name: "x", path: "/a/x" }], homes: [], error: null };
      }
      return { notOnHub: [], homes: [], error: "host offline" };
    },
  });
  const report = await enforceHubOnly(d);
  assert.equal(report.length, 3);
  const byHost = Object.fromEntries(report.map((row) => [row.hostId, row]));
  assert.deepEqual(d.cleaned, ["a"]);
  assert.match(String(byHost.b.skipped), /boom/);
  assert.match(String(byHost.c.skipped), /offline/);
});

test("a rejected skill names its blocking reasons", async () => {
  const d = deps({
    hosts: async () => [{ hostId: "a", hostName: "A" }],
    refresh: async () => ({
      notOnHub: [{ name: "y", path: "/a/y" }],
      homes: [],
      error: null,
    }),
  });
  const report: HubOnlyReport = await enforceHubOnly(d);
  assert.deepEqual(report[0]!.rejected, [{ name: "y", reason: "no name" }]);
  assert.deepEqual(d.cleaned, ["a"]);
});
