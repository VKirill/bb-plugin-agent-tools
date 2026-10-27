import yaml from "js-yaml";

/**
 * The rules BB applies before it registers a skill from its data dir and
 * stages it into sessions (packages/skill-index/src/metadata.ts and
 * apps/server/src/services/skills/injected-skills.ts in BB). A skill that
 * breaks any of them is silently skipped by BB, so the plugin checks the same
 * rules before publishing and shows the result on the Skills page.
 */
export const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const SKILL_DESCRIPTION_MAX = 1024;
export const BB_SKILL_MAX_BYTES = 10 * 1024 * 1024;
export const BB_SKILL_MAX_FILES = 1000;

export type SkillProblemCode =
  | "no-skill-md"
  | "frontmatter-delimiter"
  | "frontmatter-yaml"
  | "name-missing"
  | "name-invalid"
  | "name-mismatch"
  | "description-missing"
  | "description-too-long"
  | "too-big"
  | "too-many-files"
  | "absolute-skill-path";

export type SkillProblem = {
  code: SkillProblemCode;
  /** Short English detail for logs and the CLI; the UI renders its own text by code. */
  detail: string;
  /** Problems BB rejects the skill for. Warnings still load. */
  blocking: boolean;
};

export type SkillMeta = {
  name: string | null;
  description: string | null;
  problems: SkillProblem[];
};

/** Splits off the frontmatter block the way gray-matter does for BB. */
function frontmatterBlock(content: string): string | null {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u.exec(content);
  return match === null ? null : match[1];
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Parses SKILL.md metadata and lists what BB would reject. `dirName` is the
 * skill folder; BB itself only needs a valid name, but a name that differs
 * from the folder makes the same skill show under two names, so it is a
 * warning.
 */
export function parseSkillMeta(content: string | null, dirName: string): SkillMeta {
  if (content === null) {
    return {
      name: null,
      description: null,
      problems: [{ code: "no-skill-md", detail: "SKILL.md is missing", blocking: true }],
    };
  }
  if (!/^\s*---\r?\n/u.test(content)) {
    return {
      name: null,
      description: null,
      problems: [
        { code: "frontmatter-delimiter", detail: "SKILL.md must start with a plain --- line", blocking: true },
      ],
    };
  }
  const block = frontmatterBlock(content);
  let data: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(block ?? "");
    data = loaded !== null && typeof loaded === "object" ? (loaded as Record<string, unknown>) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "invalid YAML";
    return {
      name: null,
      description: null,
      problems: [{ code: "frontmatter-yaml", detail: message, blocking: true }],
    };
  }
  const name = stringField(data, "name");
  const description = stringField(data, "description");
  const problems: SkillProblem[] = [];
  if (name === null) {
    problems.push({ code: "name-missing", detail: "name is missing", blocking: true });
  } else if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    problems.push({
      code: "name-invalid",
      detail: `name "${name}" must be lowercase letters, digits and single hyphens, up to 64 characters`,
      blocking: true,
    });
  } else if (name !== dirName) {
    problems.push({ code: "name-mismatch", detail: `name "${name}" differs from folder "${dirName}"`, blocking: false });
  }
  if (description === null) {
    problems.push({ code: "description-missing", detail: "description is missing", blocking: true });
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    problems.push({
      code: "description-too-long",
      detail: `description is ${description.length} characters, BB accepts up to ${SKILL_DESCRIPTION_MAX}`,
      blocking: true,
    });
  }
  if (/(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(?:agents|claude)\/skills\//u.test(content)) {
    problems.push({
      code: "absolute-skill-path",
      detail: "SKILL.md points at ~/.agents/skills or ~/.claude/skills; sessions get a copy elsewhere, use relative paths",
      blocking: false,
    });
  }
  return { name, description, problems };
}

/** Size problems of the tree BB would copy into a session. */
export function treeProblems(bytes: number, files: number): SkillProblem[] {
  const problems: SkillProblem[] = [];
  if (bytes > BB_SKILL_MAX_BYTES) {
    problems.push({
      code: "too-big",
      detail: `${(bytes / 1024 / 1024).toFixed(1)} MB, BB copies up to 10 MB`,
      blocking: true,
    });
  }
  if (files > BB_SKILL_MAX_FILES) {
    problems.push({ code: "too-many-files", detail: `${files} files, BB copies up to ${BB_SKILL_MAX_FILES}`, blocking: true });
  }
  return problems;
}

/** First lines of the body, for the classifier prompt. */
export function skillBodyExcerpt(content: string | null, maxLines = 40): string {
  if (content === null) return "";
  const body = content.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u, "");
  return body.split(/\r?\n/u).slice(0, maxLines).join("\n").trim();
}
