/**
 * Two-level skill categories (section → subsection) kept by the plugin. Skill
 * files are never touched: the tree and the assignments live in plugin KV.
 * Pure functions only, shared by the server, the classifier tools and tests.
 */

export type SkillSubsection = {
  id: string;
  title: string;
  titleEn: string;
  description: string;
};

export type SkillSection = SkillSubsection & {
  subsections: SkillSubsection[];
};

export type SkillTree = {
  sections: SkillSection[];
};

/** Who placed the skill. A manual placement is never changed automatically. */
export type AssignmentSource = "manual" | "family" | "model";

export type SkillAssignment = {
  skill: string;
  sectionId: string;
  subsectionId: string;
  source: AssignmentSource;
  confidence: number | null;
  reason: string | null;
  at: number;
};

export type ReviewItem = {
  skill: string;
  section: string;
  subsection: string;
  confidence: number | null;
  reason: string | null;
  at: number;
};

/** Below this the model's answer goes to review instead of creating anything. */
export const CONFIDENCE_FLOOR = 0.6;
/** A family decides only when this many placed siblings all agree. */
export const FAMILY_QUORUM = 2;

/** Comparison key: case, spaces, punctuation and ё/е do not make a new category. */
export function normalizeKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[\s_\-–—/\\.,:;!?()«»"'`]+/gu, " ")
    .trim();
}

function makeId(base: string, taken: ReadonlySet<string>): string {
  const slug =
    normalizeKey(base)
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim()
      .replace(/ +/gu, "-")
      .slice(0, 48) || "category";
  let id = slug;
  let n = 2;
  while (taken.has(id)) {
    id = `${slug}-${n}`;
    n += 1;
  }
  return id;
}

function allIds(tree: SkillTree): Set<string> {
  const ids = new Set<string>();
  for (const section of tree.sections) {
    ids.add(section.id);
    for (const sub of section.subsections) ids.add(sub.id);
  }
  return ids;
}

function matches(item: SkillSubsection, title: string): boolean {
  const key = normalizeKey(title);
  return key !== "" && (normalizeKey(item.title) === key || normalizeKey(item.titleEn) === key);
}

export function findSection(tree: SkillTree, title: string): SkillSection | null {
  return tree.sections.find((section) => matches(section, title) || section.id === title) ?? null;
}

export function findSubsection(section: SkillSection, title: string): SkillSubsection | null {
  return section.subsections.find((sub) => matches(sub, title) || sub.id === title) ?? null;
}

export function locate(
  tree: SkillTree,
  sectionId: string,
  subsectionId: string,
): { section: SkillSection; subsection: SkillSubsection } | null {
  const section = tree.sections.find((item) => item.id === sectionId);
  const subsection = section?.subsections.find((item) => item.id === subsectionId);
  return section === undefined || subsection === undefined ? null : { section, subsection };
}

export type EnsurePathInput = {
  section: string;
  subsection: string;
  sectionEn?: string;
  subsectionEn?: string;
  description?: string;
};

export type EnsurePathResult = {
  tree: SkillTree;
  sectionId: string;
  subsectionId: string;
  createdSection: boolean;
  createdSubsection: boolean;
};

/**
 * Finds section/subsection by title (Russian or English, any case) and adds
 * whichever is missing. Never goes deeper than two levels.
 */
export function ensurePath(tree: SkillTree, input: EnsurePathInput): EnsurePathResult {
  const sectionTitle = input.section.trim();
  const subTitle = input.subsection.trim();
  if (sectionTitle === "" || subTitle === "") throw new Error("section and subsection are required");
  if (sectionTitle.length > 60 || subTitle.length > 60) throw new Error("category names are limited to 60 characters");
  const ids = allIds(tree);
  let createdSection = false;
  let createdSubsection = false;
  let section = findSection(tree, sectionTitle);
  let sections = tree.sections;
  if (section === null) {
    section = {
      id: makeId(input.sectionEn || sectionTitle, ids),
      title: sectionTitle,
      titleEn: input.sectionEn?.trim() || sectionTitle,
      description: "",
      subsections: [],
    };
    ids.add(section.id);
    sections = [...sections, section];
    createdSection = true;
  }
  let subsection = findSubsection(section, subTitle);
  if (subsection === null) {
    subsection = {
      id: makeId(`${section.id} ${input.subsectionEn || subTitle}`, ids),
      title: subTitle,
      titleEn: input.subsectionEn?.trim() || subTitle,
      description: input.description?.trim() ?? "",
    };
    const nextSection: SkillSection = { ...section, subsections: [...section.subsections, subsection] };
    sections = sections.map((item) => (item.id === nextSection.id ? nextSection : item));
    createdSubsection = true;
  }
  return {
    tree: { sections },
    sectionId: section.id,
    subsectionId: subsection.id,
    createdSection,
    createdSubsection,
  };
}

/** Family of a skill name: `asc-release-flow` → `asc`. */
export function familyKey(name: string): string {
  return name.split("-")[0] ?? name;
}

/**
 * Places a skill next to its siblings when enough of them already sit in one
 * subsection and none sits elsewhere. Otherwise the model decides.
 */
export function inferByFamily(
  name: string,
  assignments: readonly SkillAssignment[],
): { sectionId: string; subsectionId: string } | null {
  const family = familyKey(name);
  if (family === name) return null;
  const siblings = assignments.filter((item) => item.skill !== name && familyKey(item.skill) === family);
  if (siblings.length < FAMILY_QUORUM) return null;
  const first = siblings[0];
  const unanimous = siblings.every(
    (item) => item.sectionId === first.sectionId && item.subsectionId === first.subsectionId,
  );
  return unanimous ? { sectionId: first.sectionId, subsectionId: first.subsectionId } : null;
}

/** Upserts an assignment; an automatic one never replaces a manual one. */
export function upsertAssignment(
  assignments: readonly SkillAssignment[],
  next: SkillAssignment,
): { assignments: SkillAssignment[]; changed: boolean } {
  const current = assignments.find((item) => item.skill === next.skill);
  if (current !== undefined && current.source === "manual" && next.source !== "manual") {
    return { assignments: [...assignments], changed: false };
  }
  const rest = assignments.filter((item) => item.skill !== next.skill);
  return { assignments: [...rest, next].sort((a, b) => a.skill.localeCompare(b.skill)), changed: true };
}

/** Skills that still need a category: not placed and not waiting in review. */
export function unplacedSkills(
  skills: readonly string[],
  assignments: readonly SkillAssignment[],
  review: readonly ReviewItem[],
): string[] {
  const placed = new Set(assignments.map((item) => item.skill));
  const waiting = new Set(review.map((item) => item.skill));
  return skills.filter((name) => !placed.has(name) && !waiting.has(name));
}

/** Drops assignments and review items of skills that left the hub. */
export function pruneMissing<T extends { skill: string }>(items: readonly T[], skills: readonly string[]): T[] {
  const present = new Set(skills);
  return items.filter((item) => present.has(item.skill));
}

export function renameCategory(
  tree: SkillTree,
  id: string,
  title: string,
  titleEn?: string,
): SkillTree {
  const clean = title.trim();
  if (clean === "") throw new Error("name is required");
  const rename = <T extends SkillSubsection>(item: T): T =>
    item.id === id ? { ...item, title: clean, titleEn: titleEn?.trim() || item.titleEn } : item;
  return {
    sections: tree.sections.map((section) => ({
      ...rename(section),
      subsections: section.subsections.map(rename),
    })),
  };
}

/** Removes an empty subsection, or a section whose subsections are all empty. */
export function removeCategory(tree: SkillTree, id: string, assignments: readonly SkillAssignment[]): SkillTree {
  const used = new Set(assignments.flatMap((item) => [item.sectionId, item.subsectionId]));
  if (used.has(id)) throw new Error("category is not empty");
  return {
    sections: tree.sections
      .filter((section) => section.id !== id)
      .map((section) => ({ ...section, subsections: section.subsections.filter((sub) => sub.id !== id) })),
  };
}

/** Tree as compact text for the classifier prompt and the CLI. */
export function treeOutline(tree: SkillTree, counts?: ReadonlyMap<string, number>): string {
  const lines: string[] = [];
  for (const section of tree.sections) {
    lines.push(`${section.title} (${section.titleEn})`);
    for (const sub of section.subsections) {
      const count = counts?.get(sub.id);
      const note = sub.description ? ` — ${sub.description}` : "";
      lines.push(`  - ${sub.title} (${sub.titleEn})${count === undefined ? "" : ` [${count}]`}${note}`);
    }
  }
  return lines.join("\n");
}

type Seed = [string, string, string, Array<[string, string, string]>];

const SEED: Seed[] = [
  ["Разработка", "Development", "", [
    ["Веб-фронтенд и UI", "Web front end and UI", "React, Vue, Tailwind, вёрстка, интерфейсы сайтов"],
    ["Мобильные приложения", "Mobile apps", "Expo, React Native, iOS, App Store Connect"],
    ["Бэкенд и базы данных", "Back end and databases", "API, Postgres, Prisma, Directus"],
    ["3D в браузере", "3D in the browser", "three.js, WebGPU, шейдеры"],
    ["Игры", "Games", "Roblox, Warcraft III, разбор игр"],
    ["Архитектура и качество кода", "Architecture and code quality", "проектирование, ревью, тесты"],
    ["Навигация по коду", "Code navigation", "GitNexus, граф кода"],
    ["Инфраструктура и серверы", "Infrastructure and servers", "Linux, облака, прокси, деплой"],
    ["Безопасность", "Security", "аудит безопасности"],
  ]],
  ["BB и агенты", "BB and agents", "", [
    ["Плагины и ядро BB", "BB plugins and core", "плагины BB, ядро, CLI bb"],
    ["Провайдеры CLI", "CLI providers", "Codex, Claude Code, OpenCode, ACP"],
    ["Lane Stack и Lane Pilot", "Lane Stack and Lane Pilot", "оркестрация писателей, контракты линий"],
    ["Память агентов", "Agent memory", "agentmemory, память BB"],
    ["Инструкции и навыки", "Instructions and skills", "AGENTS.md, промпты, создание навыков"],
    ["MCP", "MCP", "MCP-серверы, MetaMCP"],
  ]],
  ["Маркетинг", "Marketing", "", [
    ["SEO", "SEO", "DrMax, семантический кокон, аудит сайта"],
    ["Яндекс Директ", "Yandex Direct", "кампании и объявления Директа"],
    ["Telegram Ads", "Telegram Ads", "реклама в Telegram"],
    ["Google Ads", "Google Ads", "реклама Google"],
    ["Соцсети и инсайты", "Social media and insights", "Threads, Instagram, VK, Telegram, сбор инсайтов"],
    ["Аналитика", "Analytics", "Метрика, Вебмастер, Search Console"],
  ]],
  ["Тексты", "Writing", "", [
    ["Копирайт", "Copywriting", "офферы, лендинги, микрокопи"],
    ["Русский текст и редактура", "Russian text and editing", "вычитка, типографика, нейрослоп"],
    ["Истории и сценарии", "Stories and scripts", "сюжеты, сценарии, кейсы"],
    ["Голос автора", "Author voice", "личный стиль автора"],
  ]],
  ["Дизайн", "Design", "", [
    ["UI/UX и дизайн-системы", "UI/UX and design systems", "DESIGN.md, прототипы, ревью интерфейса"],
    ["Генерация изображений", "Image generation", "промпты и модели картинок"],
    ["Стили изображений", "Image styles", "художественные стили"],
  ]],
  ["3D и Blender", "3D and Blender", "", [
    ["Пайплайн и экспорт", "Pipeline and export", "постановка задачи, экспорт в движки"],
    ["Моделирование", "Modelling", "моделинг, скульпт, ретопология, UV"],
    ["Материалы, свет, рендер", "Materials, lighting, rendering", "лукдев, свет, рендер, композитинг"],
    ["Персонажи и анимация", "Characters and animation", "риг, анимация, одежда, волосы"],
    ["Стили и арт-дирекция", "Styles and art direction", "визуальные стили и настроение"],
    ["Жанры игр", "Game genres", "жанровые требования к ассетам"],
    ["Миры и окружение", "Worlds and environments", "миры, биомы, окружение"],
  ]],
  ["Видео", "Video", "", [
    ["Монтаж кодом", "Video from code", "Remotion, HyperFrames"],
    ["Процедурные фильмы", "Procedural films", "анимация кодом, мультфильмы"],
    ["Короткие ролики", "Short videos", "Reels, Shorts, нарезка"],
  ]],
  ["Бизнес и документы", "Business and documents", "", [
    ["Бухгалтерия и ЭДО", "Accounting and e-documents", "Эльба, Диадок"],
    ["Платежи", "Payments", "платёжные системы"],
    ["Офисные документы", "Office documents", "таблицы, PDF, презентации"],
  ]],
  ["Исследования", "Research", "", [
    ["Поиск в вебе", "Web search", "поиск и отчёты с источниками"],
    ["Научные статьи", "Papers", "arXiv и научная литература"],
    ["Прочие исследования", "Other research", "генеалогия и прочее"],
  ]],
];

/** Starting tree; the classifier grows it from here. */
export function seedTree(): SkillTree {
  let tree: SkillTree = { sections: [] };
  for (const [section, sectionEn, , subs] of SEED) {
    for (const [sub, subEn, description] of subs) {
      tree = ensurePath(tree, { section, sectionEn, subsection: sub, subsectionEn: subEn, description }).tree;
    }
  }
  return tree;
}
