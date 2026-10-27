import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensurePath,
  inferByFamily,
  normalizeKey,
  removeCategory,
  renameCategory,
  seedTree,
  unplacedSkills,
  upsertAssignment,
  type SkillAssignment,
} from "../categories.ts";
import { parseSkillMeta, treeProblems } from "../skill-meta.ts";

const at = 1;

function assignment(skill: string, sectionId: string, subsectionId: string, source: SkillAssignment["source"] = "model"): SkillAssignment {
  return { skill, sectionId, subsectionId, source, confidence: 0.9, reason: null, at };
}

test("seed tree has two levels and unique ids", () => {
  const tree = seedTree();
  const ids = tree.sections.flatMap((section) => [section.id, ...section.subsections.map((sub) => sub.id)]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(tree.sections.length >= 8);
  assert.ok(tree.sections.every((section) => section.subsections.length > 0));
});

test("ensurePath reuses a category regardless of case, language and punctuation", () => {
  const tree = seedTree();
  const first = ensurePath(tree, { section: "маркетинг", subsection: "яндекс  директ" });
  assert.equal(first.createdSection, false);
  assert.equal(first.createdSubsection, false);
  const english = ensurePath(tree, { section: "Marketing", subsection: "Yandex Direct" });
  assert.equal(english.subsectionId, first.subsectionId);
});

test("ensurePath creates a missing subsection and a missing section", () => {
  const tree = seedTree();
  const sub = ensurePath(tree, { section: "Маркетинг", subsection: "VK Реклама", subsectionEn: "VK Ads" });
  assert.equal(sub.createdSection, false);
  assert.equal(sub.createdSubsection, true);
  const again = ensurePath(sub.tree, { section: "Маркетинг", subsection: "vk реклама" });
  assert.equal(again.createdSubsection, false);
  assert.equal(again.subsectionId, sub.subsectionId);
  const fresh = ensurePath(sub.tree, { section: "Музыка", sectionEn: "Music", subsection: "Сведение", subsectionEn: "Mixing" });
  assert.equal(fresh.createdSection, true);
  assert.equal(fresh.tree.sections.length, sub.tree.sections.length + 1);
});

test("family inference needs agreeing siblings", () => {
  const placed = [assignment("asc-release-flow", "dev", "mobile"), assignment("asc-xcode-build", "dev", "mobile")];
  assert.deepEqual(inferByFamily("asc-crash-triage", placed), { sectionId: "dev", subsectionId: "mobile" });
  assert.equal(inferByFamily("asc-crash-triage", placed.slice(0, 1)), null);
  const split = [assignment("app-architect", "dev", "arch"), assignment("app-designer", "design", "ui")];
  assert.equal(inferByFamily("app-builder", split), null);
  assert.equal(inferByFamily("drmax", placed), null);
});

test("an automatic placement never replaces a manual one", () => {
  const manual = [assignment("ru-text", "writing", "editing", "manual")];
  const auto = upsertAssignment(manual, assignment("ru-text", "marketing", "seo", "model"));
  assert.equal(auto.changed, false);
  assert.equal(auto.assignments[0].sectionId, "writing");
  const byHand = upsertAssignment(manual, assignment("ru-text", "marketing", "seo", "manual"));
  assert.equal(byHand.changed, true);
  assert.equal(byHand.assignments[0].sectionId, "marketing");
});

test("only skills without a category and not in review are queued", () => {
  const queued = unplacedSkills(
    ["a", "b", "c"],
    [assignment("a", "s", "x")],
    [{ skill: "b", section: "S", subsection: "X", confidence: 0.3, reason: null, at }],
  );
  assert.deepEqual(queued, ["c"]);
});

test("rename keeps ids, remove refuses a used category", () => {
  const tree = seedTree();
  const sub = tree.sections[0].subsections[0];
  const renamed = renameCategory(tree, sub.id, "Фронтенд");
  assert.equal(renamed.sections[0].subsections[0].id, sub.id);
  assert.equal(renamed.sections[0].subsections[0].title, "Фронтенд");
  assert.throws(() => removeCategory(tree, sub.id, [assignment("x", tree.sections[0].id, sub.id)]));
  assert.equal(removeCategory(tree, sub.id, []).sections[0].subsections.some((item) => item.id === sub.id), false);
  assert.equal(normalizeKey("  Ёлки — Палки "), "елки палки");
});

test("skill metadata follows BB's rules", () => {
  const ok = parseSkillMeta('---\nname: ru-text\ndescription: "Use when: editing Russian text"\n---\n# Body', "ru-text");
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.name, "ru-text");
  const colon = parseSkillMeta("---\nname: docs-maintain\ndescription: Keep docs honest. Use when: nightly docs\n---\n", "docs-maintain");
  assert.equal(colon.problems[0].code, "frontmatter-yaml");
  const badName = parseSkillMeta('---\nname: "Directus Backend"\ndescription: x\n---\n', "directus-backend");
  assert.equal(badName.problems[0].code, "name-invalid");
  const long = parseSkillMeta(`---\nname: a\ndescription: "${"x".repeat(1100)}"\n---\n`, "a");
  assert.equal(long.problems[0].code, "description-too-long");
  const dup = parseSkillMeta("---\nname: a\ndescription: b\nmetadata:\n  role: x\n  role: y\n---\n", "a");
  assert.equal(dup.problems[0].code, "frontmatter-yaml");
  const abs = parseSkillMeta("---\nname: a\ndescription: b\n---\nRun ~/.agents/skills/a/scripts/x.py", "a");
  assert.equal(abs.problems[0].code, "absolute-skill-path");
  assert.equal(abs.problems[0].blocking, false);
  assert.equal(parseSkillMeta(null, "a").problems[0].code, "no-skill-md");
  assert.equal(treeProblems(11 * 1024 * 1024, 10)[0].code, "too-big");
  assert.equal(treeProblems(10, 1001)[0].code, "too-many-files");
});
