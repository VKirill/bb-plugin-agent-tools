import { test } from "node:test";
import assert from "node:assert/strict";
import { seedTree } from "../categories.ts";
import {
  applyModelAssign,
  EMPTY_CLASSIFIER_STATE,
  SkillClassifier,
  THREAD_MAX_AGE_MS,
  type AssignInput,
  type CategoryStore,
  type ClassifierSkill,
  type ClassifierState,
} from "../classifier.ts";

type Answer = (skill: string) => AssignInput | null;

function harness(skills: ClassifierSkill[], answer: Answer, startState: ClassifierState = EMPTY_CLASSIFIER_STATE) {
  let store: CategoryStore = { tree: seedTree(), assignments: [], review: [] };
  let state = { ...startState };
  let clock = 1_000_000;
  const spawned: string[] = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const archived: string[] = [];
  let pending: string | null = null;
  const names = skills.map((skill) => skill.name);
  const answerPending = () => {
    if (pending === null) return;
    const input = answer(pending);
    if (input !== null) store = applyModelAssign(store, input, names, clock).store;
    pending = null;
  };
  const classifier = new SkillClassifier({
    readSkills: async () => skills,
    readStore: async () => store,
    writeStore: async (next) => {
      store = next;
    },
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    spawnThread: async (prompt) => {
      const id = `thr_${spawned.length + 1}`;
      spawned.push(prompt);
      pending = /Skill: (\S+)/u.exec(prompt)?.[1] ?? null;
      return id;
    },
    sendMessage: async (threadId, text) => {
      sent.push({ threadId, text });
      pending = /Skill: (\S+)/u.exec(text)?.[1] ?? /for (\S+)\./u.exec(text)?.[1] ?? null;
    },
    waitIdle: async () => {
      answerPending();
      clock += 1000;
    },
    archiveThread: async (id) => {
      archived.push(id);
    },
    now: () => clock,
    log: () => undefined,
  });
  return {
    classifier,
    get store() {
      return store;
    },
    get state() {
      return state;
    },
    spawned,
    sent,
    archived,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const skill = (name: string): ClassifierSkill => ({ name, description: `${name} skill`, excerpt: "# body" });

test("skills go one by one into one thread; categories are created when missing", async () => {
  const h = harness([skill("vk-ads"), skill("ru-text")], (name) =>
    name === "vk-ads"
      ? { skill: name, section: "Маркетинг", subsection: "VK Реклама", subsectionEn: "VK Ads", confidence: 0.9 }
      : { skill: name, section: "Тексты", subsection: "Русский текст и редактура", confidence: 0.95 },
  );
  await h.classifier.run();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].threadId, "thr_1");
  assert.equal(h.store.assignments.length, 2);
  const marketing = h.store.tree.sections.find((section) => section.title === "Маркетинг");
  assert.ok(marketing?.subsections.some((sub) => sub.title === "VK Реклама"));
  assert.equal(h.state.count, 2);
  assert.equal(h.state.running, false);
});

test("a thread older than an hour is archived and the next skill starts a new one", async () => {
  const answer: Answer = (name) => ({ skill: name, section: "Тексты", subsection: "Копирайт", confidence: 0.9 });
  const h = harness([skill("copywriter")], answer, { ...EMPTY_CLASSIFIER_STATE, threadId: "thr_old", startedAt: 0, count: 3 });
  h.advance(THREAD_MAX_AGE_MS + 1);
  await h.classifier.run();
  assert.deepEqual(h.archived, ["thr_old"]);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.state.threadId, "thr_1");
  assert.equal(h.state.count, 1);
});

test("a fresh thread is reused", async () => {
  const answer: Answer = (name) => ({ skill: name, section: "Тексты", subsection: "Копирайт", confidence: 0.9 });
  const h = harness([skill("copywriter")], answer, { ...EMPTY_CLASSIFIER_STATE, threadId: "thr_live", startedAt: 999_000, count: 3 });
  await h.classifier.run();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.sent[0].threadId, "thr_live");
  assert.equal(h.state.count, 4);
});

test("low confidence goes to review; silence retries once then goes to review", async () => {
  const h = harness([skill("odd"), skill("mute")], (name) =>
    name === "odd" ? { skill: name, section: "Новое", subsection: "Что-то", confidence: 0.3 } : null,
  );
  await h.classifier.run();
  assert.equal(h.store.assignments.length, 0);
  assert.deepEqual(h.store.review.map((item) => item.skill).sort(), ["mute", "odd"]);
  assert.equal(h.store.tree.sections.some((section) => section.title === "Новое"), false);
  assert.ok(h.sent.some((message) => message.text.startsWith("You did not call")));
});

test("family pass places siblings without the model", async () => {
  const h = harness([skill("asc-one"), skill("asc-two"), skill("asc-three")], (name) => ({
    skill: name,
    section: "Разработка",
    subsection: "Мобильные приложения",
    confidence: 0.9,
  }));
  await h.classifier.run();
  // The first two go to the model; their agreement places the third.
  assert.equal(h.store.assignments.length, 3);
  assert.equal(h.store.assignments.filter((item) => item.source === "model").length, 2);
  assert.equal(h.store.assignments.find((item) => item.skill === "asc-three")?.source, "family");
  const second = harness([skill("asc-one"), skill("asc-two"), skill("asc-three")], () => null);
  await second.classifier.run();
  assert.equal(second.store.review.length, 3);
});

test("the model cannot move a skill that already has a category", () => {
  const store: CategoryStore = { tree: seedTree(), assignments: [], review: [] };
  const first = applyModelAssign(store, { skill: "a", section: "Тексты", subsection: "Копирайт", confidence: 0.9 }, ["a"], 1);
  assert.equal(first.outcome.kind, "placed");
  const again = applyModelAssign(first.store, { skill: "a", section: "Маркетинг", subsection: "SEO", confidence: 0.9 }, ["a"], 2);
  assert.equal(again.outcome.kind, "rejected");
  assert.equal(applyModelAssign(store, { skill: "zzz", section: "Тексты", subsection: "Копирайт", confidence: 1 }, ["a"], 1).outcome.kind, "rejected");
});
