import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { z } from "zod";

export type SkillCard = {
  does: string;
  not_for: string;
  neighbors: string;
  examples: string[];
  triggers_ru: string[];
};

export type StoredCard = { card: SkillCard; hash: string; source: "model" | "manual"; at: number };

const clip = (max: number) =>
  z.preprocess((value) => (value === undefined || value === null ? "" : String(value)), z.string()).transform((text) => text.trim().slice(0, max));

const clipList = (maxItems: number, maxItem: number) =>
  z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(z.unknown())).transform((items) =>
    items
      .map((item) => String(item ?? "").trim().slice(0, maxItem))
      .filter((item) => item !== "")
      .slice(0, maxItems),
  );

export const skillCardSchema: z.ZodType<SkillCard> = z.object({
  does: clip(220),
  not_for: clip(160),
  neighbors: clip(200),
  examples: clipList(3, 200),
  triggers_ru: clipList(8, 80),
});

function frontmatterBlock(content: string): string | null {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u.exec(content);
  return match === null ? null : match[1];
}

export function skillBody(content: string): string {
  return content.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u, "");
}

export function cardShort(name: string, card: SkillCard | undefined, description: string): string {
  const does = card?.does.trim() ?? "";
  if (does !== "") return does;
  const preview = description.slice(0, 250);
  return preview !== "" ? preview : name;
}

export function cardFull(name: string, card: SkillCard | undefined, description: string, body: string): string {
  if (card === undefined) return `${description}\n\n${body.slice(0, 700)}`;
  const lines = [`Does: ${card.does}`];
  if (card.not_for.trim() !== "") lines.push(`Not for: ${card.not_for}`);
  if (card.neighbors.trim() !== "") lines.push(`Versus neighbours: ${card.neighbors}`);
  if (card.examples.length > 0) lines.push(`Example requests: ${card.examples.join(" | ")}`);
  return lines.join("\n");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function parseCard(value: unknown): SkillCard {
  return skillCardSchema.parse(value);
}

/** Reads an optional `metadata.jev` block from SKILL.md frontmatter. */
export function manualCard(content: string): SkillCard | undefined {
  const block = frontmatterBlock(content);
  if (block === null) return undefined;
  let data: unknown;
  try {
    data = yaml.load(block);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object") return undefined;
  const metadata = (data as Record<string, unknown>).metadata;
  if (metadata === null || typeof metadata !== "object") return undefined;
  const jev = (metadata as Record<string, unknown>).jev;
  if (jev === null || jev === undefined || typeof jev !== "object") return undefined;
  return parseCard(jev);
}
