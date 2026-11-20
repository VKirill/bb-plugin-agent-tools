// Google Gemini behind the JevClient interface, so the same two-pass pipeline
// (gates, shortlist, rerank, fits) runs on either engine. Jev returns measured
// probabilities; Gemini returns its own estimates through a JSON schema, so the
// thresholds tuned on Jev are a starting point here, not a measurement.
import { canonicalJson, type JevAnswer, type JevClient, type JevQuestion, type JevResponse } from "./jev.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 6000;
const TOP = 5;

const SYSTEM = [
  "You are a fast judgment model. You get a JSON `state` and a JSON object of `questions`; answer every question by its key.",
  'A "choice" question picks one option from `criteria` (keys are option ids, values describe them): rank up to 5 most likely options with the probability that each is the right answer (probabilities over all options sum to 1).',
  'A "noul" question is yes/no: give the probability (0 to 1) that the answer is yes. Be calibrated: 0.5 means equally likely, use values near 0 or 1 only when clear.',
  "Judge only from the state. Return JSON only.",
].join("\n");

/** Gemini refuses large enums ("too many states"); longer lists are checked in parseGemini. */
const ENUM_MAX = 20;

function optionSchema(options: string[]): Record<string, unknown> {
  return options.length <= ENUM_MAX ? { type: "string", enum: options } : { type: "string" };
}

function answerSchema(question: JevQuestion): Record<string, unknown> {
  if (question.type === "noul") return { type: "number", minimum: 0, maximum: 1 };
  return {
    type: "object",
    properties: {
      ranking: {
        type: "array",
        maxItems: TOP,
        items: {
          type: "object",
          properties: { option: optionSchema(Object.keys(question.criteria)), probability: { type: "number", minimum: 0, maximum: 1 } },
          required: ["option", "probability"],
        },
      },
    },
    required: ["ranking"],
  };
}

export function geminiBody(state: Record<string, string>, questions: Record<string, JevQuestion>): Record<string, unknown> {
  const keys = Object.keys(questions).sort();
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: canonicalJson({ state, questions }) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: Object.fromEntries(keys.map((key) => [key, answerSchema(questions[key]!)])),
        required: keys,
      },
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };
}

/** Gemini's JSON → Jev answers. Unknown options and missing keys are dropped. */
export function parseGemini(data: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const body = (data ?? {}) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>; usageMetadata?: { promptTokenCount?: number } };
  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("");
  if (text.trim() === "") throw new Error("Gemini returned no text");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const value = raw[key];
    if (question.type === "noul") {
      if (typeof value === "number" && Number.isFinite(value)) answers[key] = { type: "noul", noul: Math.min(1, Math.max(0, value)) };
      continue;
    }
    const ranking = (value as { ranking?: Array<{ option?: unknown; probability?: unknown }> } | undefined)?.ranking ?? [];
    const probabilities: Record<string, number> = {};
    for (const row of ranking) {
      const option = String(row.option ?? "");
      if (!(option in question.criteria) || option in probabilities) continue;
      probabilities[option] = typeof row.probability === "number" && Number.isFinite(row.probability) ? Math.min(1, Math.max(0, row.probability)) : 0;
    }
    const best = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0];
    if (best === undefined) continue;
    answers[key] = { type: "choice", choice: best[0], confidence: best[1], probabilities };
  }
  return { answers, usage: { input_tokens: body.usageMetadata?.promptTokenCount ?? 0 } };
}

export function createGeminiClient(opts: { apiKey: string; model: string; timeoutMs?: number; fetchImpl?: typeof fetch }): JevClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${BASE}/${encodeURIComponent(opts.model)}:generateContent`;
  return {
    async ask(state, questions) {
      const payload = JSON.stringify(geminiBody(state, questions));
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "x-goog-api-key": opts.apiKey, "Content-Type": "application/json" },
            body: payload,
            signal: controller.signal,
          });
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`Gemini HTTP ${response.status}${detail !== "" ? `: ${detail.slice(0, 300)}` : ""}`);
          }
          return parseGemini(await response.json(), questions);
        } catch (cause) {
          if (cause instanceof Error && cause.name === "AbortError") throw new Error("Gemini request timed out");
          throw cause;
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}
