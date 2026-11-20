import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiClient, geminiBody } from "../skill-suggest/gemini.ts";
import type { JevQuestion } from "../skill-suggest/jev.ts";

const questions: Record<string, JevQuestion> = {
  pick: { type: "choice", instructions: "Which skill?", criteria: { "blender-video": "Blender", git: "Git" } },
  gate: { type: "noul", instructions: "New task?" },
};

test("gemini adapter: schema per question, answers mapped to Jev shape", async () => {
  const body = geminiBody({ request: "гифка в блендере" }, questions) as { generationConfig: { responseJsonSchema: { required: string[]; properties: Record<string, any> } } };
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["gate", "pick"]);
  assert.deepEqual(body.generationConfig.responseJsonSchema.properties.pick.properties.ranking.items.properties.option.enum, ["blender-video", "git"]);

  const reply = { pick: { ranking: [{ option: "nope", probability: 0.9 }, { option: "blender-video", probability: 0.8 }, { option: "git", probability: 0.1 }] }, gate: 1.4 };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }], usageMetadata: { promptTokenCount: 42 } }), { status: 200 })) as typeof fetch;
  const out = await createGeminiClient({ apiKey: "k", model: "m", fetchImpl }).ask({ request: "x" }, questions);
  assert.deepEqual(out.answers.pick, { type: "choice", choice: "blender-video", confidence: 0.8, probabilities: { "blender-video": 0.8, git: 0.1 } });
  assert.deepEqual(out.answers.gate, { type: "noul", noul: 1 });
  assert.equal(out.usage.input_tokens, 42);
});
