import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLocal, fromDialect, mergeEntry, sameServer, toDialect } from "../normalize.ts";

test("claude dialect round-trips a stdio server", () => {
  const parsed = fromDialect("claude", "x", { command: "npx", args: ["-y", "pkg"] });
  assert.equal(parsed?.transport, "stdio");
  assert.deepEqual(toDialect("claude", parsed!), { command: "npx", args: ["-y", "pkg"] });
});

test("opencode dialect splits and rebuilds the command array", () => {
  const parsed = fromDialect("opencode", "x", {
    type: "local",
    command: ["node", "server.js"],
    environment: { A: "1" },
  });
  assert.equal(parsed?.command, "node");
  assert.deepEqual(parsed?.args, ["server.js"]);
  assert.deepEqual(toDialect("opencode", parsed!), {
    type: "local",
    command: ["node", "server.js"],
    enabled: true,
    environment: { A: "1" },
  });
});

test("antigravity remote servers use serverUrl", () => {
  const parsed = fromDialect("antigravity", "x", { serverUrl: "https://example.test/mcp" });
  assert.equal(parsed?.transport, "http");
  assert.deepEqual(toDialect("antigravity", parsed!), { serverUrl: "https://example.test/mcp" });
});

test("the same binary at different paths counts as the same server", () => {
  const a = fromDialect("claude", "g", { command: "/opt/homebrew/bin/gitnexus", args: ["mcp"] })!;
  const b = fromDialect("claude", "g", { command: "/usr/bin/gitnexus", args: ["mcp"] })!;
  assert.ok(sameServer(a, b));
});

test("grok-toml dialect uses url/headers for remote servers and command/args/env for stdio", () => {
  const remote = fromDialect("grok-toml", "gitnexus", {
    url: "http://127.0.0.1:9401/api/mcp",
    headers: { Authorization: "Bearer secret" },
  })!;
  assert.equal(remote.transport, "http");
  assert.deepEqual(toDialect("grok-toml", remote), {
    url: "http://127.0.0.1:9401/api/mcp",
    headers: { Authorization: "Bearer secret" },
    enabled: true,
  });

  const stdio = fromDialect("grok-toml", "agentmemory", {
    command: "/home/ubuntu/.npm-global/bin/agentmemory-mcp",
    args: [],
    env: { AGENTMEMORY_URL: "http://127.0.0.1:3111" },
  })!;
  assert.equal(stdio.transport, "stdio");
  assert.deepEqual(toDialect("grok-toml", stdio), {
    command: "/home/ubuntu/.npm-global/bin/agentmemory-mcp",
    env: { AGENTMEMORY_URL: "http://127.0.0.1:3111" },
    enabled: true,
  });
});

test("reading a grok TOML table with headers yields an http transport", () => {
  const parsed = fromDialect("grok-toml", "gitnexus", {
    url: "http://127.0.0.1:9401/api/mcp",
    headers: { Authorization: "Bearer secret" },
  })!;
  assert.equal(parsed.transport, "http");
  assert.deepEqual(parsed.headers, { Authorization: "Bearer secret" });
});

test("gemini dialect writes httpUrl for http transport and url for sse transport", () => {
  const http = fromDialect("claude", "x", { url: "https://example.test/mcp" })!;
  assert.deepEqual(toDialect("gemini", { ...http, transport: "http" }), {
    httpUrl: "https://example.test/mcp",
  });
  assert.deepEqual(toDialect("gemini", { ...http, transport: "sse" }), {
    url: "https://example.test/mcp",
  });
});

test("machine-bound servers are detected", () => {
  assert.ok(classifyLocal({ name: "a", transport: "stdio", command: "/usr/local/bin/x" }).localOnly);
  assert.ok(classifyLocal({ name: "b", transport: "http", url: "http://127.0.0.1:9000/mcp" }).localOnly);
  assert.ok(
    classifyLocal({
      name: "c",
      transport: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "${TOKEN}" },
    }).localOnly,
  );
  assert.equal(
    classifyLocal({ name: "d", transport: "stdio", command: "npx", args: ["-y", "pkg"] }).localOnly,
    false,
  );
});

test("grok keeps the explicit enabled flag it writes in its own config", () => {
  assert.deepEqual(
    toDialect("grok-toml", { name: "a", transport: "stdio", command: "npx", args: ["-y", "p"] }),
    { command: "npx", args: ["-y", "p"], enabled: true },
  );
  assert.deepEqual(
    toDialect("grok-toml", {
      name: "b",
      transport: "http",
      url: "https://example.test/mcp",
      disabled: true,
    }),
    { url: "https://example.test/mcp", enabled: false },
  );
  const parsed = fromDialect("grok-toml", "b", { url: "https://example.test/mcp", enabled: false });
  assert.equal(parsed?.disabled, true);
});

test("merging keeps settings the plugin does not own", () => {
  const existing = {
    tool_timeout_sec: 300,
    startup_timeout_sec: 30,
    url: "https://api.alphaxiv.org/mcp/v1",
    bearer_token_env_var: "ALPHAXIV_API_KEY",
  };
  const merged = mergeEntry(
    existing,
    toDialect("codex-toml", {
      name: "alphaxiv",
      transport: "http",
      url: "https://api.alphaxiv.org/mcp/v1",
      disabled: true,
    }),
  );
  assert.equal(merged.tool_timeout_sec, 300);
  assert.equal(merged.startup_timeout_sec, 30);
  assert.equal(merged.bearer_token_env_var, "ALPHAXIV_API_KEY");
  assert.equal(merged.enabled, false);
});

test("merging drops keys of the opposite transport", () => {
  const merged = mergeEntry(
    { command: "old-binary", args: ["x"], env: { A: "1" }, cwd: "/srv" },
    toDialect("claude", { name: "x", transport: "http", url: "https://example.test/mcp" }),
  );
  assert.equal(merged.command, undefined);
  assert.equal(merged.args, undefined);
  assert.equal(merged.env, undefined);
  assert.equal(merged.cwd, "/srv");
  assert.equal(merged.url, "https://example.test/mcp");
});

test("metamcp dialect round-trips stdio and keeps transportType explicit for remote", () => {
  const stdio = fromDialect("metamcp", "tg", {
    command: "node",
    args: ["/srv/mcp.js"],
  });
  assert.equal(stdio?.transport, "stdio");
  assert.deepEqual(toDialect("metamcp", stdio!), {
    command: "node",
    args: ["/srv/mcp.js"],
  });

  const remote = fromDialect("metamcp", "secondary", {
    url: "http://127.0.0.1:12008/metamcp/secondary/mcp",
    transportType: "http",
    headers: { Authorization: "${METAMCP_SECONDARY_AUTH}" },
  })!;
  assert.equal(remote.transport, "http");
  assert.deepEqual(toDialect("metamcp", remote), {
    url: "http://127.0.0.1:12008/metamcp/secondary/mcp",
    transportType: "http",
    headers: { Authorization: "${METAMCP_SECONDARY_AUTH}" },
  });
});

test("skill states: canonical, linked, duplicate, diverged and new", async () => {
  const { computeSkillRows } = await import("../skills.ts");
  const canonicalPath = "/home/u/.agents/skills";
  const rows = computeSkillRows(canonicalPath, [
    {
      id: "agents", path: canonicalPath, exists: true,
      entries: [
        { name: "alpha", kind: "dir", target: null, hash: "aaa", hasSkillMd: true },
        { name: "beta", kind: "dir", target: null, hash: "bbb", hasSkillMd: true },
        { name: "gamma", kind: "symlink", target: "/home/u/.bb/skills/gamma", hash: "ggg", hasSkillMd: true },
      ],
    },
    {
      id: "claude", path: "/home/u/.claude/skills", exists: true,
      entries: [
        { name: "alpha", kind: "symlink", target: `${canonicalPath}/alpha`, hash: "aaa", hasSkillMd: true },
        { name: "beta", kind: "dir", target: null, hash: "bbb", hasSkillMd: true },
        { name: "alpha", kind: "dir", target: null, hash: "zzz", hasSkillMd: true },
        { name: "fresh", kind: "dir", target: null, hash: "fff", hasSkillMd: true },
        { name: "ext", kind: "symlink", target: "/home/u/.bb/skills/ext", hash: "eee", hasSkillMd: true },
      ],
    },
    {
      id: "bb", path: "/home/u/.bb/skills", exists: true,
      entries: [
        { name: "gamma", kind: "dir", target: null, hash: "ggg", hasSkillMd: true },
      ],
    },
  ]);
  const by = (name: string) => rows.filter((r) => r.name === name).map((r) => r.state);
  assert.deepEqual(by("alpha"), ["linked", "diverged"]);
  assert.deepEqual(by("beta"), ["copy"]);
  assert.deepEqual(by("fresh"), ["only-here"]);
  // ссылка в дом BB — дубль реестра BB, а не безымянная внешняя ссылка
  assert.deepEqual(by("ext"), ["bb-registry"]);
  assert.deepEqual(by("gamma"), ["canonical-source"]);
  assert.equal(rows.filter((r) => r.name === "junk").length, 0);
});
