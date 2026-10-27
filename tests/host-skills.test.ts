import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupSkillHomes, countSkillHomes, packSkillDir, unpackSkill } from "../host-skills.ts";

function skill(dir: string, name: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
}

function fakeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "host-skills-home-"));
  skill(path.join(home, ".agents/skills"), "ru-text");
  skill(path.join(home, ".agents/skills"), "seo");
  mkdirSync(path.join(home, ".agents/skills/.git"));
  mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
  symlinkSync(path.join(home, ".agents/skills/ru-text"), path.join(home, ".claude/skills/ru-text"));
  skill(path.join(home, ".claude/skills/synced"), "pdf");
  skill(path.join(home, ".codex/skills/.system"), "imagegen");
  skill(path.join(home, ".bb/skills"), "edo");
  return home;
}

test("count and clean CLI skill folders, keeping what the CLI owns", async () => {
  const home = fakeHome();
  const counts = await countSkillHomes(home);
  assert.deepEqual(
    counts.map((item) => [item.id, item.skills, item.links]),
    [["agents", 2, 0], ["claude", 0, 1], ["bb", 1, 0]],
  );
  const dry = await cleanupSkillHomes(true, home);
  assert.equal(dry.backup, null);
  assert.equal(existsSync(path.join(home, ".agents/skills/ru-text")), true);
  const done = await cleanupSkillHomes(false, home);
  assert.deepEqual(done.errors, []);
  assert.ok(done.backup !== null);
  assert.deepEqual(await countSkillHomes(home), []);
  assert.equal(existsSync(path.join(home, ".claude/skills/synced/pdf/SKILL.md")), true);
  assert.equal(existsSync(path.join(home, ".codex/skills/.system/imagegen/SKILL.md")), true);
  assert.equal(existsSync(path.join(home, ".agents/skills/.git")), false);
  assert.deepEqual(readdirSync(path.join(done.backup as string, "agents")).sort(), [".git", "ru-text", "seo"]);
  assert.equal(existsSync(path.join(done.backup as string, "bb/edo/SKILL.md")), true);
});

test("pack a draft and unpack it into drafts, keeping the previous copy", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "host-skills-pack-"));
  skill(path.join(home, "work"), "my-skill");
  const packed = await packSkillDir(path.join(home, "work/my-skill"), "tar");
  assert.equal(packed.ok, true, packed.error ?? "");
  assert.equal(packed.name, "my-skill");
  const drafts = path.join(home, "drafts");
  const first = await unpackSkill("my-skill", packed.archiveBase64 as string, drafts, "tar");
  assert.equal(first.ok, true, first.error ?? "");
  assert.equal(existsSync(path.join(drafts, "my-skill/SKILL.md")), true);
  const second = await unpackSkill("my-skill", packed.archiveBase64 as string, drafts, "tar");
  assert.ok(second.previous !== null && existsSync(second.previous));
  const missing = await packSkillDir(path.join(home, "work"), "tar");
  assert.equal(missing.ok, false);
});
