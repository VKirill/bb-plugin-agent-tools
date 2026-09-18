import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSkillRows, locationPolicy, resolveRowAction, type SkillLocationScan } from "../skills.ts";

const CANON = "/home/u/.agents/skills";

function scan(id: string, path: string, entries: SkillLocationScan["entries"]): SkillLocationScan {
  return { id, path, exists: true, entries };
}

function dir(name: string, hash: string, mtime = 100): SkillLocationScan["entries"][number] {
  return { name, kind: "dir", target: null, hash, mtime, hasSkillMd: true };
}

function link(name: string, target: string): SkillLocationScan["entries"][number] {
  return { name, kind: "symlink", target, hash: null, mtime: null, hasSkillMd: true };
}

test("копия в .claude заменяется симлинком, а в .codex просто удаляется", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1")]),
    scan("claude", "/home/u/.claude/skills", [dir("a", "h1")]),
    scan("codex", "/home/u/.codex/skills", [dir("a", "h1")]),
  ]);
  const claude = rows.find((row) => row.locationId === "claude")!;
  const codex = rows.find((row) => row.locationId === "codex")!;
  assert.equal(claude.state, "copy");
  assert.equal(resolveRowAction(claude)?.mode, "link");
  assert.equal(codex.state, "copy");
  assert.equal(resolveRowAction(codex)?.mode, "delete");
});

test("в папке Gemini любая ссылка — лишняя, её убираем", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1")]),
    scan("gemini-config", "/home/u/.gemini/config/skills", [
      link("a", `${CANON}/a`),
      link("b", "/home/u/.bb/skills/b"),
    ]),
  ]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.state, "stray-link");
    assert.equal(resolveRowAction(row)?.mode, "unlink");
  }
});

test("реальный скилл в папке Gemini переносится в канон без симлинка", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, []),
    scan("gemini-config", "/home/u/.gemini/config/skills", [dir("only", "h9")]),
  ]);
  assert.equal(rows[0]?.state, "only-here");
  assert.deepEqual(resolveRowAction(rows[0]!), { mode: "adopt", label: "Перенести в канон" });
  assert.equal(locationPolicy("gemini-config"), "drop");
});

test("ссылка в канон из .claude остаётся здоровым алиасом", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1")]),
    scan("claude", "/home/u/.claude/skills", [link("a", `${CANON}/a`)]),
  ]);
  assert.equal(rows[0]?.state, "linked");
  assert.equal(resolveRowAction(rows[0]!), null);
});

test("расходящаяся копия: побеждает более новая дата, в .codex копия просто удаляется", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1", 500)]),
    scan("claude", "/home/u/.claude/skills", [dir("a", "h2", 900)]),
    scan("codex", "/home/u/.codex/skills", [dir("a", "h3", 100)]),
  ]);
  const claude = rows.find((row) => row.locationId === "claude")!;
  const codex = rows.find((row) => row.locationId === "codex")!;
  assert.equal(claude.state, "diverged");
  assert.equal(resolveRowAction(claude)?.mode, "take");
  assert.equal(resolveRowAction(codex)?.mode, "link");
  assert.equal(resolveRowAction(codex)?.label, "Удалить копию (канон новее)");
});

test("равные даты при разном содержании остаются ручным решением", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1", 700)]),
    scan("claude", "/home/u/.claude/skills", [dir("a", "h2", 700)]),
  ]);
  assert.equal(resolveRowAction(rows[0]!), null);
});

test("ссылка в ~/.bb/skills — дубль реестра BB, действие ручное", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1")]),
    scan("bb", "/home/u/.bb/skills", [dir("a", "h1")]),
    scan("claude", "/home/u/.claude/skills", [link("a", "/home/u/.bb/skills/a")]),
  ]);
  const claude = rows.find((row) => row.locationId === "claude")!;
  assert.equal(claude.state, "bb-registry");
  const action = resolveRowAction(claude)!;
  assert.equal(action.mode, "unlink");
  assert.equal(action.manual, true);
});

test("ссылка наружу мимо канона и BB остаётся информационной", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1")]),
    scan("bb", "/home/u/.bb/skills", []),
    scan("claude", "/home/u/.claude/skills", [link("a", "/home/u/elsewhere/a")]),
  ]);
  assert.equal(rows.find((row) => row.locationId === "claude")?.state, "linked-external");
});

test("папку BB правила не трогают: BB заносит в реестр только реальные папки", () => {
  const rows = computeSkillRows(CANON, [
    scan("agents", CANON, [dir("a", "h1", 100)]),
    scan("bb", "/home/u/.bb/skills", [dir("a", "h1", 100), dir("only", "h7", 100), dir("b", "h8", 900)]),
  ]);
  assert.equal(locationPolicy("bb"), "own");
  for (const row of rows) assert.equal(resolveRowAction(row), null);
});
