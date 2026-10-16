import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_ENV_VALUE_MAX_LENGTH,
  hostScanSchema,
  mcpServerSchema,
  applyOpSchema,
} from "../contract.ts";
import { classifyLocal, fromDialect, toDialect } from "../normalize.ts";

// BB's Cursor bridge writes JSON.stringify(dynamicTools) into this environment
// value. Use synthetic tool descriptions, never a real bridge token or config.
const dynamicTools = JSON.stringify(Array.from({ length: 76 }, (_, index) => ({
  name: `fixture_tool_${index}`,
  description: "A tool with a detailed description. ".repeat(8),
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
})));

test("Cursor bridge with tool schemas larger than 8192 survives the full host scan contract", () => {
  assert.ok(dynamicTools.length > 8192);
  const raw = {
    command: "/runtime/bin/node",
    args: ["bridge.mjs"],
    env: { BB_ACP_DYNAMIC_TOOLS: dynamicTools },
  };
  const server = fromDialect("claude", "bb-bridge", raw)!;
  const scan = hostScanSchema.parse({
    hostname: "fixture-machine",
    platform: "darwin",
    home: "/fixture",
    scannedAt: 1,
    agents: [{
      kind: "cursor",
      label: "Cursor",
      installed: true,
      binPath: "/runtime/bin/cursor",
      configPath: "/fixture/.cursor/mcp.json",
      configExists: true,
      writable: true,
      gateway: false,
      servers: [server],
      warning: null,
    }],
    otherClis: [],
  });
  const scanned = scan.agents[0]!.servers[0]!;
  assert.deepEqual(toDialect("claude", scanned), raw);
  assert.deepEqual(JSON.parse(scanned.env!.BB_ACP_DYNAMIC_TOOLS!), JSON.parse(dynamicTools));
  assert.equal(classifyLocal(scanned).localOnly, true);
  assert.equal(applyOpSchema.parse({ kind: "cursor", action: "upsert", server: scanned })
    .server.env!.BB_ACP_DYNAMIC_TOOLS, dynamicTools);
});

test("MCP environment values stay bounded at 131,072 characters without clipping", () => {
  const server = {
    name: "fixture",
    transport: "stdio" as const,
    command: "node",
    env: { STRUCTURED_CONFIG: "x".repeat(MCP_ENV_VALUE_MAX_LENGTH) },
  };
  assert.equal(mcpServerSchema.parse(server).env!.STRUCTURED_CONFIG!.length, MCP_ENV_VALUE_MAX_LENGTH);
  const rejected = mcpServerSchema.safeParse({
    ...server,
    env: { STRUCTURED_CONFIG: `${server.env.STRUCTURED_CONFIG}x` },
  });
  assert.equal(rejected.success, false);
  if (!rejected.success) assert.deepEqual(rejected.error.issues[0]!.path, ["env", "STRUCTURED_CONFIG"]);
});

test("raising the env limit leaves HTTP header limits intact", () => {
  const server = { name: "fixture", transport: "http", url: "https://example.test/mcp" };
  assert.ok(mcpServerSchema.safeParse({ ...server, headers: { Authorization: "x".repeat(8192) } }).success);
  assert.equal(mcpServerSchema.safeParse({ ...server, headers: { Authorization: "x".repeat(8193) } }).success, false);
});
