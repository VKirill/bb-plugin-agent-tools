import { test } from "node:test";
import assert from "node:assert/strict";
import { enrolledHostIsBbServer, planFanOut, planServerBbMirror, type FanOutState, type SkillLocationScan } from "../skills.ts";

const CANON = "/home/u/.agents/skills";
const BB = "/home/u/.bb/skills";
const CLAUDE = "/home/u/.claude/skills";

function scan(id: string, path: string, entries: SkillLocationScan["entries"]): SkillLocationScan {
  return { id, path, exists: true, entries };
}

function dir(name: string, hash: string, mtime = 100): SkillLocationScan["entries"][number] {
  return { name, kind: "dir", target: null, hash, mtime, hasSkillMd: true };
}

function link(name: string, target: string): SkillLocationScan["entries"][number] {
  return { name, kind: "symlink", target, hash: null, mtime: null, hasSkillMd: true };
}

const EMPTY: FanOutState = { entries: {} };

test("канон раскатывается: ссылка в дом Claude и копия в дом BB", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("a", "h1")]), scan("claude", CLAUDE, []), scan("bb", BB, [])],
    pluginNames: [],
    state: EMPTY,
  });
  assert.deepEqual(
    plan.ops.map((op) => `${op.kind}:${op.locationId}`).sort(),
    ["link:claude", "mirror:bb"],
  );
  assert.deepEqual(Object.keys(plan.nextState.entries), ["a"]);
});

test("навык, который отдаёт плагин, в дом Claude не дублируется", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("ru-text", "h1")]), scan("claude", CLAUDE, []), scan("bb", BB, [])],
    pluginNames: ["ru-text"],
    state: EMPTY,
  });
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.skippedByPlugin, ["ru-text"]);
});

test("канон ссылается в дом BB — зеркало не делаем, там и лежит оригинал", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, [link("drmax", `${BB}/drmax`)]),
      scan("bb", BB, [dir("drmax", "h5")]),
      scan("claude", CLAUDE, []),
    ],
    pluginNames: [],
    state: EMPTY,
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.locationId}`), ["link:claude"]);
});

test("расхождение зеркала: побеждает более свежая правка", () => {
  const canonNewer = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("a", "h1", 900)]), scan("bb", BB, [dir("a", "h2", 100)])],
    pluginNames: [],
    state: { entries: { a: { hash: "h1" } } },
  });
  assert.deepEqual(canonNewer.ops.map((op) => op.kind), ["mirror"]);

  const bbNewer = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("a", "h1", 100)]), scan("bb", BB, [dir("a", "h2", 900)])],
    pluginNames: [],
    state: { entries: { a: { hash: "h1" } } },
  });
  assert.deepEqual(bbNewer.ops.map((op) => op.kind), ["pull"]);
});

test("новый скилл в BB забирается в канон, а знакомый исчезнувший — уводится из канона", () => {
  const fresh = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, []), scan("bb", BB, [dir("new", "h7")])],
    pluginNames: [],
    state: EMPTY,
  });
  assert.deepEqual(fresh.ops.map((op) => `${op.kind}:${op.name}`), ["pull:new"]);
  assert.deepEqual(Object.keys(fresh.nextState.entries), ["new"]);

  const removed = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("gone", "h1")]), scan("bb", BB, []), scan("claude", CLAUDE, [link("gone", `${CANON}/gone`)])],
    pluginNames: [],
    state: { entries: { gone: { hash: "h1", mirrored: true } } },
  });
  assert.deepEqual(removed.ops.map((op) => `${op.kind}:${op.locationId}`), ["retire:bb", "drop:claude"]);
  assert.deepEqual(Object.keys(removed.nextState.entries), []);
});

test("удаление, приехавшее синком, вычищает зеркало BB и ссылки", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, []),
      scan("bb", BB, [dir("old", "h1")]),
      scan("claude", CLAUDE, [link("old", `${CANON}/old`)]),
    ],
    pluginNames: [],
    state: { entries: { old: { hash: "h1", mirrored: true } } },
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.locationId}`).sort(), ["drop:bb", "drop:claude"]);
});

test("живая ссылка мимо канона не переставляется", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, [dir("a", "h1")]),
      scan("claude", CLAUDE, [link("a", "/somewhere/else/a")]),
      scan("bb", BB, [dir("a", "h1")]),
    ],
    pluginNames: [],
    state: { entries: { a: { hash: "h1" } } },
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.reason}`), []);
});

test("битая ссылка считается отсутствием и ставится на канон", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, [dir("a", "h1")]),
      scan("claude", CLAUDE, [{ name: "a", kind: "symlink", target: "/somewhere/else/a", hash: null, mtime: null, hasSkillMd: false }]),
      scan("bb", BB, [dir("a", "h1")]),
    ],
    pluginNames: [],
    state: { entries: { a: { hash: "h1" } } },
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.reason}`), ["link:нет в доме"]);
});

test("скилл от плагина не зеркалится и в дом BB: в сессии BB он уже есть", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("ru-text", "h1")]), scan("claude", CLAUDE, []), scan("bb", BB, [])],
    pluginNames: ["ru-text"],
    state: EMPTY,
  });
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.skippedByPlugin, ["ru-text"]);
});

test("дом CLI есть, папки скиллов нет — раскатка её наполняет", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, [dir("a", "h1")]),
      { id: "claude", path: CLAUDE, exists: false, parentExists: true, entries: [] },
      { id: "cursor", path: "/home/u/.cursor/skills", exists: false, parentExists: false, entries: [] },
    ],
    pluginNames: [],
    state: EMPTY,
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.locationId}`), ["link:claude"]);
});

test("битая ссылка на удалённый канон убирается", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, []),
      scan("claude", CLAUDE, [{ name: "gone", kind: "symlink", target: null, hash: null, mtime: null, hasSkillMd: false }]),
    ],
    pluginNames: [],
    state: { entries: { gone: { hash: null } } },
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.locationId}`), ["drop:claude"]);
});

test("скилл, который раньше не зеркалили, не считается удалённым при смене правил", () => {
  // Был исключён как плагинный (mirrored: false), настройку поменяли — в доме BB
  // его нет. Это не удаление человеком: канон трогать нельзя, надо разложить.
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [scan("agents", CANON, [dir("ru-text", "h1")]), scan("bb", BB, []), scan("claude", CLAUDE, [])],
    pluginNames: [],
    state: { entries: { "ru-text": { hash: "h1", mirrored: false } } },
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.locationId}`).sort(), ["link:claude", "mirror:bb"]);
  assert.equal(plan.nextState.entries["ru-text"]?.mirrored, true);
});

test("сервер BB зеркалит отсутствующие и более новые канонные скиллы", () => {
  const ops = planServerBbMirror({
    canon: [
      { name: "a", kind: "dir", hash: "h1", mtime: 200 },
      { name: "plug", kind: "dir", hash: "h2", mtime: 200 },
      { name: "link", kind: "symlink", hash: "h3", mtime: 200 },
    ],
    dest: [{ name: "a", kind: "dir", hash: "old", mtime: 50 }],
    pluginNames: ["plug"],
  });
  assert.deepEqual(ops.map((op) => `${op.name}:${op.reason}`), ["a:канон новее"]);
});

test("сервер BB не затирает более новую папку в dataDir/skills", () => {
  const ops = planServerBbMirror({
    canon: [{ name: "a", kind: "dir", hash: "h1", mtime: 50 }],
    dest: [{ name: "a", kind: "dir", hash: "h2", mtime: 900 }],
    pluginNames: [],
  });
  assert.deepEqual(ops, []);
});

test("хаб, уже записанный как машина BB, не считается отдельным сервером", () => {
  assert.equal(
    enrolledHostIsBbServer(
      [
        { hostname: "bb-server", status: "connected" },
        { hostname: "mini", status: "connected" },
      ],
      "bb-server",
    ),
    true,
  );
  assert.equal(
    enrolledHostIsBbServer([{ hostname: "mini", status: "connected" }], "bb-server"),
    false,
  );
});

test("копия в доме BB с node_modules перекладывается, хоть хеш и совпадает", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, [dir("a", "h1")]),
      scan("bb", BB, [{ ...dir("a", "h1"), junk: true }, dir("b", "h2")]),
    ],
    pluginNames: [],
    state: { entries: { a: { hash: "h1", mirrored: true }, b: { hash: "h2", mirrored: true } } },
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.name}`), ["mirror:a", "drop:b"]);
});

test("скилл тяжелее лимита BB в дом BB не кладётся, а попадает в blocked", () => {
  const plan = planFanOut({
    canonicalPath: CANON,
    locations: [
      scan("agents", CANON, [{ ...dir("huge", "h1"), bytes: 11 * 1024 * 1024 }]),
      scan("bb", BB, []),
      scan("claude", CLAUDE, []),
    ],
    pluginNames: [],
    state: EMPTY,
  });
  assert.deepEqual(plan.ops.map((op) => `${op.kind}:${op.locationId}`), ["link:claude"]);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0]!.name, "huge");
  assert.match(plan.blocked[0]!.reason, /10 МБ/);
});

test("сервер BB: мусор в копии — перекладываем; тяжёлый канон — blocked", () => {
  const ops = planServerBbMirror({
    canon: [
      { name: "a", kind: "dir", hash: "h1", mtime: 100 },
      { name: "huge", kind: "dir", hash: "h2", mtime: 100, bytes: 20 * 1024 * 1024 },
      { name: "ok", kind: "dir", hash: "h3", mtime: 100 },
    ],
    dest: [
      { name: "a", kind: "dir", hash: "h1", mtime: 100, junk: true },
      { name: "ok", kind: "dir", hash: "h3", mtime: 100 },
    ],
    pluginNames: [],
  });
  assert.deepEqual(
    ops.map((op) => `${op.name}:${op.blocked === true ? "blocked" : "mirror"}`),
    ["a:mirror", "huge:blocked"],
  );
});
