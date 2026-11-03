export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export type JevResponse = { answers: Record<string, JevAnswer>; usage: { input_tokens: number } };

export interface JevClient {
  ask(state: Record<string, string>, questions: Record<string, JevQuestion>): Promise<JevResponse>;
}

const URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 4000;
const RETRY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseAnswer(value: unknown): JevAnswer | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.type === "choice" || (row.choice !== undefined && row.probabilities !== undefined)) {
    const probabilities: Record<string, number> = {};
    if (row.probabilities !== null && typeof row.probabilities === "object") {
      for (const [name, score] of Object.entries(row.probabilities as Record<string, unknown>)) {
        probabilities[name] = asNumber(score);
      }
    }
    return {
      type: "choice",
      choice: String(row.choice ?? ""),
      confidence: asNumber(row.confidence),
      probabilities,
    };
  }
  if (row.type === "noul" || typeof row.noul === "number") {
    return { type: "noul", noul: asNumber(row.noul) };
  }
  return null;
}

function parseResponse(data: unknown): JevResponse {
  if (data === null || typeof data !== "object") throw new Error("Jev returned a non-object");
  const body = data as Record<string, unknown>;
  const rawAnswers = body.answers;
  if (rawAnswers === null || typeof rawAnswers !== "object") throw new Error("Jev response has no answers");
  const answers: Record<string, JevAnswer> = {};
  for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
    const parsed = parseAnswer(value);
    if (parsed !== null) answers[key] = parsed;
  }
  const usage = body.usage !== null && typeof body.usage === "object" ? (body.usage as Record<string, unknown>) : {};
  return { answers, usage: { input_tokens: asNumber(usage.input_tokens) } };
}

/**
 * JSON with object keys sorted at every level. Jev's answers shift with the
 * order of questions and options (gates before the long Choice moved the gate
 * by ~0.04 in the experiment), and the thresholds were measured on sorted
 * payloads, so the wire order is fixed here rather than left to insertion order.
 */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([key, inner]) => [key, sort(inner)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

export function createHttpJevClient(opts: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): JevClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async ask(state, questions) {
      const payload = canonicalJson({ model: opts.model, state, questions });
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) await sleep(RETRY_MS);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${opts.apiKey}`,
              "Content-Type": "application/json",
            },
            body: payload,
            signal: controller.signal,
          });
          if (isRetryStatus(response.status) && attempt === 0) {
            lastError = new Error(`Jev HTTP ${response.status}`);
            continue;
          }
          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`Jev HTTP ${response.status}${detail !== "" ? `: ${detail.slice(0, 300)}` : ""}`);
          }
          return parseResponse(await response.json());
        } catch (cause) {
          lastError = cause;
          if (attempt === 0 && cause instanceof Error && /HTTP 429|HTTP 5/u.test(cause.message)) continue;
          if (attempt === 0 && cause instanceof Error && cause.name === "AbortError") throw new Error("Jev request timed out");
          if (attempt === 1) break;
          throw cause;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}
