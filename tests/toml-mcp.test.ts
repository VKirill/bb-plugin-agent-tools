import { test } from "node:test";
import assert from "node:assert/strict";
import { readServers, removeServer, upsertServer } from "../toml-mcp.ts";

const SOURCE = `# Codex configuration
model = "gpt-5"

[mcp_servers.gitnexus]
command = "/opt/homebrew/bin/gitnexus"
args = ["mcp"]
startup_timeout_sec = 60

[mcp_servers.node_repl]
command = "/usr/bin/node_repl"
args = []

[mcp_servers.node_repl.env]
NODE_REPL_PATH = "/tmp/node"

[mcp_servers.alphaxiv]
url = "https://api.alphaxiv.org/mcp/v1"
tool_timeout_sec = 300

[history]
persistence = "save-all"
`;

test("reads stdio, remote and nested env tables", () => {
  const servers = readServers(SOURCE);
  assert.deepEqual(Object.keys(servers), ["gitnexus", "node_repl", "alphaxiv"]);
  assert.deepEqual(servers.gitnexus, {
    command: "/opt/homebrew/bin/gitnexus",
    args: ["mcp"],
    startup_timeout_sec: 60,
  });
  assert.deepEqual(servers.node_repl!.env, { NODE_REPL_PATH: "/tmp/node" });
  assert.equal(servers.alphaxiv!.url, "https://api.alphaxiv.org/mcp/v1");
});

test("upsert then remove restores the original text", () => {
  const added = upsertServer(SOURCE, "probe", {
    command: "npx",
    args: ["-y", "probe-mcp"],
    env: { TOKEN: "abc" },
  });
  assert.deepEqual(readServers(added).probe, {
    command: "npx",
    args: ["-y", "probe-mcp"],
    env: { TOKEN: "abc" },
  });
  assert.equal(removeServer(added, "probe").trimEnd(), SOURCE.trimEnd());
});

test("removing one table leaves the rest of the file intact", () => {
  const without = removeServer(SOURCE, "gitnexus");
  assert.deepEqual(Object.keys(readServers(without)), ["node_repl", "alphaxiv"]);
  assert.match(without, /# Codex configuration/);
  assert.match(without, /\[history\]/);
  assert.match(without, /persistence = "save-all"/);
});

test("replacing a server keeps unrelated sections", () => {
  const replaced = upsertServer(SOURCE, "alphaxiv", { url: "https://example.test/mcp" });
  const servers = readServers(replaced);
  assert.equal(servers.alphaxiv!.url, "https://example.test/mcp");
  assert.equal(Object.keys(servers).length, 3);
  assert.match(replaced, /\[history\]/);
});
