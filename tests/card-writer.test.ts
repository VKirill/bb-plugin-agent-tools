import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CARD_WRITER_STATE, SkillCardWriter, type CardJob } from "../skill-suggest/card-writer.ts";
import type { StoredCard } from "../skill-suggest/cards.ts";

test("card writer starts a new thread when the kept one rejects messages", async () => {
  const job: CardJob = { name: "kontur-elba", description: "invoices", body: "", siblings: "", hash: "h1" };
  const cards: Record<string, StoredCard> = {};
  const spawned: string[] = [];
  const archived: string[] = [];
  let state = { ...EMPTY_CARD_WRITER_STATE, threadId: "thr_gone", startedAt: 1_000, count: 1 };
  const writer = new SkillCardWriter({
    readJobs: async () => [job],
    readCards: async () => ({ ...cards }),
    writeCards: async (next) => void Object.assign(cards, next),
    readState: async () => state,
    writeState: async (next) => void (state = next),
    spawnThread: async () => {
      spawned.push("thr_new");
      return "thr_new";
    },
    sendMessage: async () => {
      throw new Error("HTTP 409: Thread is archived");
    },
    waitIdle: async (threadId) => {
      if (threadId === "thr_new") {
        cards[job.name] = { card: { does: "x", not_for: "", neighbors: "", examples: [], triggers_ru: [] } as never, hash: "h1", source: "model", at: 2_000 };
      }
    },
    archiveThread: async (threadId) => void archived.push(threadId),
    now: () => 2_000,
    log: () => undefined,
  });
  await writer.run();
  assert.deepEqual(spawned, ["thr_new"]);
  assert.deepEqual(archived, ["thr_gone"]);
  assert.equal(state.threadId, "thr_new");
  assert.equal(state.lastError, null);
  assert.equal(cards["kontur-elba"]?.hash, "h1");
});
