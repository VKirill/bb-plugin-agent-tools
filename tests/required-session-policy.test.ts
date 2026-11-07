import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_REQUIRED_SESSION_ADVERTISEMENT,
  MANDATORY_BB_PLUGINS,
  MANDATORY_MCP_SERVERS,
  oneShotPluginNeed,
  requiredSessionPolicySpawnField,
} from "../required-session-policy.ts";

const core = () => CORE_REQUIRED_SESSION_ADVERTISEMENT;
const agents = { experimental_vkRequiredSessionPolicy: core };
const need = oneShotPluginNeed("agent-tools");

test("no policy when the required API is absent", () => {
  assert.deepEqual(requiredSessionPolicySpawnField({}, "claude-code", need), {});
  assert.deepEqual(
    requiredSessionPolicySpawnField({ experimental_vkRequiredSessionPolicy: () => ({}) }, "claude-code", need),
    {},
  );
});

test("claude-code one-shot keeps plugin tools, drops skills and extra MCP", () => {
  const field = requiredSessionPolicySpawnField(agents, "claude-code", need);
  assert.deepEqual(field.experimental_vkRequiredSessionPolicy, {
    version: 1,
    policy: {
      bbPlugins: { mode: "allow", names: [...MANDATORY_BB_PLUGINS, "agent-tools"] },
      skills: { mode: "allow", names: [] },
      mcpServers: { mode: "allow", names: [...MANDATORY_MCP_SERVERS] },
      nativePlugins: { mode: "allow", names: [] },
      userInstructions: false,
    },
  });
  assert.equal("projectInstructions" in field.experimental_vkRequiredSessionPolicy.policy, false);
});

test("acp-cursor omits nativePlugins; unknown provider passes nothing", () => {
  const cursor = requiredSessionPolicySpawnField(agents, "acp-cursor", need);
  assert.deepEqual(cursor.experimental_vkRequiredSessionPolicy.policy, {
    bbPlugins: { mode: "allow", names: [...MANDATORY_BB_PLUGINS, "agent-tools"] },
    skills: { mode: "allow", names: [] },
    mcpServers: { mode: "allow", names: [...MANDATORY_MCP_SERVERS] },
    userInstructions: false,
  });
  assert.equal("nativePlugins" in cursor.experimental_vkRequiredSessionPolicy.policy, false);
  assert.deepEqual(requiredSessionPolicySpawnField(agents, "gemini", need), {});
  assert.deepEqual(requiredSessionPolicySpawnField(agents, undefined, need), {});
});
