import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenCodeText,
  applyOpenCodeOps,
  maskApiKey,
  buildProviderRows,
  detectOpenCodeDrift,
  CANONICAL_OPENCODE_PROVIDERS,
} from "../opencode.ts";
import type { OpenCodeScan } from "../contract.ts";

test("maskApiKey masks long keys and hides short ones", () => {
  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey("short"), "••••••••");
  assert.equal(maskApiKey("sk-test-0000000000000000-example-1234"), "sk-tes...1234");
});

test("parseOpenCodeText extracts models, providers, plugins and masks apiKey", () => {
  const json = JSON.stringify({
    model: "router9/ag/gemini-3.8-flash-medium",
    small_model: "router9/ag/gemini-3.8-flash-low",
    enabled_providers: ["router9", "deepseek"],
    plugin: ["opencode-gemini-auth@latest"],
    provider: {
      router9: {
        npm: "@ai-sdk/openai-compatible",
        name: "Antigravity (9router)",
        options: {
          baseURL: "https://router.example.com/v1",
          apiKey: "sk-test-0000000000000000-example-1234",
        },
        models: {
          "ag/gemini-3.8-flash-low": {
            name: "Gemini 3.8 Flash (Low)",
            tool_call: true,
          },
        },
      },
      "zai-coding-plan": {
        whitelist: ["glm-5.3-flash"],
      },
    },
  });

  const parsed = parseOpenCodeText(json);
  assert.equal(parsed.model, "router9/ag/gemini-3.8-flash-medium");
  assert.equal(parsed.smallModel, "router9/ag/gemini-3.8-flash-low");
  assert.deepEqual(parsed.enabledProviders, ["router9", "deepseek"]);
  assert.deepEqual(parsed.plugins, ["opencode-gemini-auth@latest"]);

  assert.ok(parsed.providers["router9"]);
  assert.equal(parsed.providers["router9"].name, "Antigravity (9router)");
  assert.equal(parsed.providers["router9"].baseURL, "https://router.example.com/v1");
  assert.equal(parsed.providers["router9"].hasApiKey, true);
  // Raw config retains options for synchronization
  const rawOpts = parsed.providers["router9"].raw?.options as Record<string, unknown>;
  assert.equal(rawOpts.apiKey, "sk-test-0000000000000000-example-1234");

  assert.ok(parsed.providers["zai-coding-plan"]);
  assert.deepEqual(parsed.providers["zai-coding-plan"].whitelist, ["glm-5.3-flash"]);
});

test("applyOpenCodeOps handles upsert, remove, and model changes", () => {
  const initial: Record<string, unknown> = {
    model: "old-model",
    small_model: "old-small",
    enabled_providers: ["router9", "sub2api"],
    provider: {
      sub2api: { name: "Old Sub" },
      router9: { name: "Router9" },
    },
  };

  const updated = applyOpenCodeOps(initial, [
    {
      action: "upsert_provider",
      providerId: "zai-coding-plan",
      config: { whitelist: ["glm-5.3-flash"] },
      enable: true,
    },
    {
      action: "remove_provider",
      providerId: "sub2api",
    },
    {
      action: "set_models",
      model: "router9/ag/gemini-3.8-flash-medium",
      smallModel: "router9/ag/gemini-3.8-flash-low",
    },
  ]);

  assert.equal(updated.model, "router9/ag/gemini-3.8-flash-medium");
  assert.equal(updated.small_model, "router9/ag/gemini-3.8-flash-low");

  const providers = updated.provider as Record<string, unknown>;
  assert.equal(providers.sub2api, undefined);
  assert.ok(providers["zai-coding-plan"]);
  assert.ok(providers.router9);

  const enabled = updated.enabled_providers as string[];
  assert.ok(enabled.includes("zai-coding-plan"));
  assert.ok(!enabled.includes("sub2api"));
});

test("detectOpenCodeDrift flags stale providers and model discrepancies", () => {
  const miniScan: OpenCodeScan = {
    installed: true,
    binPath: "/opt/homebrew/bin/opencode",
    configPath: "/home/user/.config/opencode/opencode.jsonc",
    configExists: true,
    writable: true,
    model: "router9/ag/gemini-3.8-flash-medium",
    smallModel: "router9/ag/gemini-3.8-flash-low",
    enabledProviders: ["router9", "deepseek", "zai-coding-plan", "opencode"],
    providers: {
      router9: { id: "router9", hasApiKey: true },
      "zai-coding-plan": { id: "zai-coding-plan", hasApiKey: false },
    },
    plugins: [],
    warning: null,
  };

  const serverScan: OpenCodeScan = {
    installed: true,
    binPath: "/usr/local/bin/opencode",
    configPath: "/home/ubuntu/.config/opencode/opencode.json",
    configExists: true,
    writable: true,
    model: "router9/ag/gemini-3.8-flash-medium",
    smallModel: "router9/ag/gemini-3.8-flash-low",
    enabledProviders: ["router9"],
    providers: {
      router9: { id: "router9", hasApiKey: true },
      sub2api: { id: "sub2api", hasApiKey: false }, // stale!
    },
    plugins: [],
    warning: null,
  };

  const hosts = [
    { hostId: "host_mini", hostName: "Desktop", scan: miniScan },
    { hostId: "host_server", hostName: "Server", scan: serverScan },
  ];

  const drift = detectOpenCodeDrift(hosts, "host_mini");
  assert.ok(drift.some((d) => d.hostId === "host_server" && d.type === "stale_provider"));
  assert.ok(drift.some((d) => d.hostId === "host_server" && d.type === "missing_provider"));
});

test("buildProviderRows generates matrix across hosts", () => {
  const miniScan: OpenCodeScan = {
    installed: true,
    binPath: "/opt/homebrew/bin/opencode",
    configPath: "/home/user/.config/opencode/opencode.jsonc",
    configExists: true,
    writable: true,
    model: "router9/ag/gemini-3.8-flash-medium",
    smallModel: "router9/ag/gemini-3.8-flash-low",
    enabledProviders: ["router9", "deepseek"],
    providers: {
      router9: { id: "router9", name: "Antigravity (9router)", hasApiKey: true },
    },
    plugins: [],
    warning: null,
  };

  const hosts = [
    { hostId: "host_mini", hostName: "Desktop", scan: miniScan },
  ];

  const rows = buildProviderRows(hosts);
  const router9Row = rows.find((r) => r.id === "router9");
  assert.ok(router9Row);
  assert.equal(router9Row.isCanonical, true);
  assert.equal(router9Row.hosts.host_mini?.enabled, true);
  assert.equal(router9Row.hosts.host_mini?.configured, true);
});
