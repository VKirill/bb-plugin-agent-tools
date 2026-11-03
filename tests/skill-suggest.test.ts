import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash, cardFull, cardShort, manualCard, parseCard } from "../skill-suggest/cards.ts";
import { readHubSkillFile } from "../hub-skills.ts";
import type { JevClient, JevQuestion, JevResponse } from "../skill-suggest/jev.ts";
import {
  CHUNK,
  GATE_QUESTIONS,
  buildState,
  rank,
  relevanceBlock,
  resetSuggestCache,
  suggest,
  type RosterEntry,
} from "../skill-suggest/suggest.ts";

function roster(names: string[]): RosterEntry[] {
  return names.map((name) => ({ name, description: `${name} does work`, body: `${name} body` }));
}

class FakeJev implements JevClient {
  readonly calls: Array<{ state: Record<string, string>; questions: Record<string, JevQuestion> }> = [];
  impl: JevClient["ask"];
  constructor(impl: JevClient["ask"]) {
    this.impl = impl;
  }
  ask(state: Record<string, string>, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    this.calls.push({ state, questions });
    return this.impl(state, questions);
  }
}

function choice(probabilities: Record<string, number>, pick?: string): JevResponse["answers"][string] {
  const winner = pick ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return { type: "choice", choice: winner, confidence: 1, probabilities };
}

function noul(value: number): JevResponse["answers"][string] {
  return { type: "noul", noul: value };
}

test("chunking: 337 names → two which:: Choice questions, ≤200 options, alphabetical", async () => {
  resetSuggestCache();
  const names = Array.from({ length: 337 }, (_, i) => `s${String(i).padStart(3, "0")}`);
  const fake = new FakeJev(async (_state, questions) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const first = Object.keys(question.criteria)[0] ?? "";
        answers[key] = choice(Object.fromEntries(Object.keys(question.criteria).map((name) => [name, name === first ? 1 : 0])));
      } else {
        answers[key] = noul(0.9);
      }
    }
    return { answers, usage: { input_tokens: 1 } };
  });
  await rank(fake, roster(names), { message: "hello" });
  const which = Object.entries(fake.calls[0]?.questions ?? {}).filter(([key]) => key.startsWith("which::"));
  assert.equal(which.length, 2);
  const sizes = which.map(([, question]) => (question.type === "choice" ? Object.keys(question.criteria).length : 0));
  assert.ok(sizes.every((size) => size <= CHUNK));
  assert.equal(sizes[0], 200);
  assert.equal(sizes[1], 137);
  const firstChunk = which.find(([key]) => key === "which::0")?.[1];
  assert.equal(firstChunk?.type, "choice");
  if (firstChunk?.type === "choice") {
    const keys = Object.keys(firstChunk.criteria);
    assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
    assert.equal(keys[0], "s000");
    assert.equal(keys[199], "s199");
  }
});

test("gate: inverted noul; below threshold skips pass 2", async () => {
  resetSuggestCache();
  const fake = new FakeJev(async (_state, questions) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const first = Object.keys(question.criteria)[0] ?? "";
        answers[key] = choice({ [first]: 1 });
      } else if (key === "gate::only_ack_or_continue") answers[key] = noul(0.9);
      else if (key === "gate::new_kind_of_task") answers[key] = noul(0.2);
      else if (key === "gate::needs_specific_instructions") answers[key] = noul(0.2);
      else answers[key] = noul(0);
    }
    return { answers, usage: { input_tokens: 3 } };
  });
  const result = await suggest(fake, roster(["alpha", "beta"]), { message: "ok continue" }, { exclude: [] });
  // oriented: 0.2, 0.2, 1-0.9=0.1 → mean 0.166...
  assert.equal(result.reason, "gate");
  assert.equal(result.skill, null);
  assert.ok(result.gate < 0.6);
  assert.equal(result.gates.only_ack_or_continue, 0.9);
  assert.equal(fake.calls.length, 1);
  assert.ok(Object.keys(GATE_QUESTIONS).every((key) => `gate::${key}` in (fake.calls[0]?.questions ?? {})));
});

test("fits below threshold → reason fits; repeat → reason repeat; client throw → reason error", async () => {
  resetSuggestCache();
  const passingGate = new FakeJev(async (_state, questions) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const names = Object.keys(question.criteria);
        answers[key] = choice(Object.fromEntries(names.map((name, i) => [name, names.length - i])));
      } else if (key.startsWith("fits::")) answers[key] = noul(0.1);
      else answers[key] = noul(0.95);
    }
    return { answers, usage: { input_tokens: 2 } };
  });
  const lowFits = await suggest(passingGate, roster(["alpha", "beta", "gamma"]), { message: "use alpha" }, { exclude: [] });
  assert.equal(lowFits.reason, "fits");
  assert.equal(lowFits.skill, null);
  assert.equal(passingGate.calls.length, 2);

  resetSuggestCache();
  const highFits = new FakeJev(async (_state, questions) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const names = Object.keys(question.criteria);
        answers[key] = choice(Object.fromEntries(names.map((name) => [name, name === "alpha" ? 1 : 0.1])), "alpha");
      } else answers[key] = noul(0.95);
    }
    return { answers, usage: { input_tokens: 2 } };
  });
  const repeated = await suggest(highFits, roster(["alpha", "beta"]), { message: "use alpha" }, {
    exclude: [],
    alreadySuggested: ["alpha"],
  });
  assert.equal(repeated.reason, "repeat");
  assert.equal(repeated.skill, null);
  assert.equal(repeated.winner, "alpha");

  resetSuggestCache();
  const boom = new FakeJev(async () => {
    throw new Error("network down");
  });
  const failed = await suggest(boom, roster(["alpha"]), { message: "x" }, { exclude: [] });
  assert.equal(failed.reason, "error");
  assert.equal(failed.skill, null);
  assert.match(failed.error ?? "", /network down/u);
});

test("exclude list removes skills from every question", async () => {
  resetSuggestCache();
  const fake = new FakeJev(async (_state, questions) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        assert.ok(!("skip-me" in question.criteria));
        const first = Object.keys(question.criteria)[0] ?? "";
        answers[key] = choice({ [first]: 1 });
      } else answers[key] = noul(0.1);
    }
    return { answers, usage: { input_tokens: 1 } };
  });
  await suggest(fake, roster(["alpha", "skip-me"]), { message: "x" }, { exclude: ["skip-me"] });
});

test("cardFull / cardShort formats and fallback", () => {
  const card = parseCard({
    does: "Writes routing cards",
    not_for: "Category placement",
    neighbors: "classifier places; this describes",
    examples: ["write a card for foo"],
    triggers_ru: ["карточка"],
  });
  assert.equal(cardShort("x", card, "ignored"), "Writes routing cards");
  assert.equal(
    cardFull("x", card, "desc", "body"),
    ["Does: Writes routing cards", "Not for: Category placement", "Versus neighbours: classifier places; this describes", "Example requests: write a card for foo"].join("\n"),
  );
  const empty = parseCard({ does: "Only does", not_for: "", neighbors: "", examples: [], triggers_ru: [] });
  assert.equal(cardFull("x", empty, "desc", "body"), "Does: Only does");
  assert.equal(cardShort("name", undefined, "description here"), "description here".slice(0, 250));
  assert.equal(cardShort("name", undefined, ""), "name");
  assert.equal(cardFull("name", undefined, "d", "b".repeat(800)), `d\n\n${"b".repeat(700)}`);
});

test("relevanceBlock exact text", () => {
  assert.equal(relevanceBlock(null), "");
  assert.equal(
    relevanceBlock("ru-text"),
    [
      "<skill_relevance>",
      "Relevant to the current request: ru-text. Read its SKILL.md with skill_read before acting. If it is already loaded in this conversation, use it as is and do not load it again. Ignore this if it does not fit what the user actually asked for.",
      "</skill_relevance>",
    ].join("\n"),
  );
});

test("buildState truncation and context lines", () => {
  const long = "u".repeat(3000);
  const prev = "p".repeat(800);
  const assistant = "a".repeat(1200);
  const state = buildState({ message: long, context: { prevUser: prev, prevAssistant: assistant } });
  assert.equal(state.request.length, 2000);
  assert.ok(state.recent_context.startsWith("Previous user message: "));
  assert.equal(state.recent_context.split("\n")[0]?.length, "Previous user message: ".length + 600);
  assert.ok(state.recent_context.includes("Agent's last reply (tail): "));
  assert.equal(state.recent_context.split("\n")[1]?.length, "Agent's last reply (tail): ".length + 900);
  assert.deepEqual(buildState({ message: "hi" }), { request: "hi", recent_context: "" });
});

test("skillCardSchema trims/slices; manualCard parses metadata.jev", () => {
  const card = parseCard({
    does: `  ${"d".repeat(300)}  `,
    not_for: "n".repeat(200),
    neighbors: "v".repeat(250),
    examples: [" one ", "two", "three", "four"],
    triggers_ru: Array.from({ length: 10 }, (_, i) => `т${i}`),
  });
  assert.equal(card.does.length, 220);
  assert.equal(card.not_for.length, 160);
  assert.equal(card.neighbors.length, 200);
  assert.equal(card.examples.length, 3);
  assert.equal(card.examples[0], "one");
  assert.equal(card.triggers_ru.length, 8);
  const parsed = manualCard(`---
name: demo
description: d
metadata:
  jev:
    does: Routes SEO cocoons
    not_for: Brand facts
    neighbors: BrandCore is SSoT, this is IA
    examples:
      - build a cocoon
    triggers_ru:
      - кокон
---
# body
`);
  assert.equal(parsed?.does, "Routes SEO cocoons");
  assert.deepEqual(parsed?.examples, ["build a cocoon"]);
  assert.equal(manualCard("---\nname: x\ndescription: y\n---\n"), undefined);
  assert.equal(contentHash("abc").length, 64);
});

test("skill_read rejects ../ paths through hub helpers", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-suggest-read-"));
  mkdirSync(path.join(root, "demo"));
  writeFileSync(path.join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n# hi\n");
  writeFileSync(path.join(root, "secret.md"), "nope");
  assert.equal(await readHubSkillFile(root, "demo", "../secret.md"), null);
  assert.equal(await readHubSkillFile(root, "../demo", "SKILL.md"), null);
});

test("LRU: same input twice → one client call", async () => {
  resetSuggestCache();
  const fake = new FakeJev(async (_state, questions) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const first = Object.keys(question.criteria)[0] ?? "";
        answers[key] = choice({ [first]: 1 });
      } else if (key === "gate::only_ack_or_continue") answers[key] = noul(1);
      else answers[key] = noul(0);
    }
    return { answers, usage: { input_tokens: 9 } };
  });
  const input = { message: "thanks, continue" };
  const first = await suggest(fake, roster(["alpha"]), input, { exclude: [] });
  const second = await suggest(fake, roster(["alpha"]), input, { exclude: [] });
  assert.equal(first.reason, "gate");
  assert.equal(second.reason, "gate");
  assert.equal(fake.calls.length, 1);
});

test("Jev payload keys are sorted at every level, as in the measured experiment", async () => {
  const { canonicalJson } = await import("../skill-suggest/jev.ts");
  const wire = canonicalJson({
    state: { request: "r", recent_context: "c" },
    questions: { "which::0": { type: "choice", criteria: { zeta: "z", alpha: "a" } }, "gate::x": { type: "noul" } },
  });
  assert.equal(
    wire,
    '{"questions":{"gate::x":{"type":"noul"},"which::0":{"criteria":{"alpha":"a","zeta":"z"},"type":"choice"}},"state":{"recent_context":"c","request":"r"}}',
  );
});
