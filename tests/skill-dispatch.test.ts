import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_MS,
  SkillDispatchInjector,
  hasMarker,
  visibleText,
  type DispatchBlock,
  type DispatchContext,
  type InjectorDeps,
  type QueuedRow,
} from "../skill-suggest/dispatch.ts";
import { relevanceBlock } from "../skill-suggest/suggest.ts";

const NOW = 1_000_000;
const userText = (text: string): DispatchBlock => ({ type: "text", text, mentions: [] });

function setup(overrides: Partial<InjectorDeps> = {}) {
  const calls = { suggest: [] as string[], update: [] as DispatchBlock[][], recheck: 0, hiddenAsked: 0 };
  let now = NOW;
  const deps: InjectorDeps = {
    pluginId: "agent-tools",
    enabled: () => true,
    ensureEnabled: async () => true,
    suggest: async (_threadId, text) => {
      calls.suggest.push(text);
      return relevanceBlock("kontur-elba", { skillRead: false });
    },
    updateRow: async (_row, content) => void calls.update.push(content),
    isHidden: async () => {
      calls.hiddenAsked++;
      return false;
    },
    recheck: async () => void calls.recheck++,
    waitReason: () => "picking a skill",
    now: () => now,
    log: () => undefined,
    ...overrides,
  };
  return { injector: new SkillDispatchInjector(deps), calls, setNow: (value: number) => void (now = value) };
}

function ctx(partial: Partial<DispatchContext> = {}): DispatchContext {
  const blocks = [userText("выстави счёт в эльбе")];
  return {
    thread: { id: "thr_a", visibility: "visible" },
    input: { blocks, text: "выстави счёт в эльбе" },
    attempt: "start-turn",
    queuedMessage: null,
    ...partial,
  };
}

function row(partial: Partial<QueuedRow> = {}): QueuedRow {
  return {
    id: "q1",
    threadId: "thr_a",
    content: [userText("выстави счёт в эльбе")],
    createdAt: NOW,
    updatedAt: NOW,
    initiator: "user",
    payload: { kind: "inline" },
    waitingOn: { kind: "plugin", pluginId: "agent-tools" },
    ...partial,
  };
}

test("a user's new turn waits for the hint, with a deadline", () => {
  const { injector } = setup();
  assert.deepEqual(injector.decide(ctx()), { action: "wait", reason: "picking a skill", sendAt: NOW + BUDGET_MS });
});

test("off, steer, hidden thread, empty text and marked input pass at once", () => {
  assert.equal(setup({ enabled: () => false }).injector.decide(ctx()).action, "proceed");
  const { injector } = setup();
  assert.equal(injector.decide(ctx({ attempt: "join-turn" })).action, "proceed");
  assert.equal(injector.decide(ctx({ thread: { id: "thr_h", visibility: "hidden" } })).action, "proceed");
  assert.equal(injector.decide(ctx({ input: { blocks: [userText("  ")], text: "  " } })).action, "proceed");
  const marked = [userText("x"), { type: "text", text: relevanceBlock("ru-text"), visibility: "agent-only" }];
  assert.equal(injector.decide(ctx({ input: { blocks: marked, text: "x" } })).action, "proceed");
});

test("agent messages and retries are not held", () => {
  const { injector } = setup();
  assert.equal(injector.decide(ctx({ queuedMessage: row({ initiator: "agent" }) })).action, "proceed");
  assert.equal(injector.decide(ctx({ queuedMessage: row({ payload: { kind: "retry" } }) })).action, "proceed");
});

test("a queued row gets an agent-only block, then proceeds", async () => {
  const { injector, calls } = setup();
  const queued = row();
  await injector.onQueued(queued);
  assert.deepEqual(calls.suggest, ["выстави счёт в эльбе"]);
  assert.equal(calls.update.length, 1);
  const added = calls.update[0]!.at(-1)!;
  assert.equal(added.visibility, "agent-only");
  assert.match(String(added.text), /kontur-elba/);
  assert.equal(hasMarker(calls.update[0]!), true);
  assert.equal(visibleText(calls.update[0]!), "выстави счёт в эльбе");
  assert.equal(calls.recheck, 1);
  assert.equal(injector.decide(ctx({ queuedMessage: queued })).action, "proceed");
});

test("no skill: the row is left as is and proceeds", async () => {
  const { injector, calls } = setup({ suggest: async () => null });
  await injector.onQueued(row());
  assert.equal(calls.update.length, 0);
  assert.equal(calls.recheck, 1);
  assert.equal(injector.decide(ctx({ queuedMessage: row() })).action, "proceed");
});

test("a failing Jev call never holds the message", async () => {
  const { injector, calls } = setup({
    suggest: async () => {
      throw new Error("HTTP 500");
    },
  });
  await injector.onQueued(row());
  assert.equal(calls.update.length, 0);
  assert.equal(calls.recheck, 1);
  assert.equal(injector.decide(ctx({ queuedMessage: row() })).action, "proceed");
});

test("a row past the budget passes even if it was never handled", () => {
  const { injector, setNow } = setup();
  assert.equal(injector.decide(ctx({ queuedMessage: row() })).action, "wait");
  setNow(NOW + BUDGET_MS);
  assert.equal(injector.decide(ctx({ queuedMessage: row() })).action, "proceed");
});

test("hidden threads found on the queue are skipped and remembered", async () => {
  const { injector, calls } = setup({ isHidden: async () => true });
  await injector.onQueued(row());
  await injector.onQueued(row({ id: "q2" }));
  assert.equal(calls.suggest.length, 0);
});

test("rows from agents, retries and marked rows are not touched on the queue", async () => {
  const { injector, calls } = setup();
  await injector.onQueued(row({ initiator: "agent" }));
  await injector.onQueued(row({ id: "q3", payload: { kind: "retry" } }));
  await injector.onQueued(row({ id: "q4", content: [userText("x"), { type: "text", text: relevanceBlock("x"), visibility: "agent-only" }] }));
  assert.equal(calls.suggest.length, 0);
  assert.equal(calls.hiddenAsked, 0);
});

test("relevanceBlock without skill_read names the skill to load", () => {
  assert.match(relevanceBlock("kontur-elba", { skillRead: false }), /Load the kontur-elba skill \(its SKILL\.md\) before acting\./);
  assert.match(relevanceBlock("kontur-elba"), /skill_read/);
});

test("a thread the hook saw as visible is not looked up on the queue", async () => {
  const { injector, calls } = setup();
  injector.decide(ctx());
  await injector.onQueued(row());
  assert.equal(calls.hiddenAsked, 0);
  assert.equal(calls.update.length, 1);
});

test("thread memory keeps hinted skills for six hours per thread", async () => {
  const { ThreadSkillMemory, ALREADY_SUGGESTED_MS } = await import("../skill-suggest/log.ts");
  const memory = new ThreadSkillMemory();
  memory.record("thr_a", "kontur-elba", 0);
  assert.deepEqual(memory.recent("thr_a", ALREADY_SUGGESTED_MS), ["kontur-elba"]);
  assert.deepEqual(memory.recent("thr_a", ALREADY_SUGGESTED_MS + 1), []);
  assert.deepEqual(memory.recent("thr_b", 0), []);
});

test("an agent's inline send held by our wait is released at once", async () => {
  const { injector, calls } = setup();
  await injector.onQueued(row({ initiator: "agent" }));
  assert.equal(calls.recheck, 1);
  assert.equal(calls.suggest.length, 0);
  // A row another plugin holds is left to that plugin.
  await injector.onQueued(row({ id: "q9", initiator: "agent", waitingOn: { kind: "plugin", pluginId: "lane-pilot" } }));
  assert.equal(calls.recheck, 1);
});

test("unknown switch after a reload holds the turn; off releases it without Jev", async () => {
  const { injector, calls } = setup({ enabled: () => null, ensureEnabled: async () => false });
  assert.equal(injector.decide(ctx()).action, "wait");
  await injector.onQueued(row());
  assert.equal(calls.suggest.length, 0);
  assert.equal(calls.recheck, 1);
  assert.equal(injector.decide(ctx({ queuedMessage: row() })).action, "proceed");
});

test("child threads started by an agent or plugin are not analyzed", () => {
  const { injector } = setup();
  assert.equal(injector.decide(ctx({ thread: { id: "thr_child", visibility: "visible", parentThreadId: "thr_parent" } })).action, "proceed");
});
