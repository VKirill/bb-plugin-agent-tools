import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { SkillsHub, SkillsHubDetail } from "./skills-hub-service";
import { t, tp, plural, getLang } from "./i18n";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type HubSkillView = SkillsHub["skills"][number];
type Node =
  | { kind: "all" }
  | { kind: "review" }
  | { kind: "problems" }
  | { kind: "unplaced" }
  | { kind: "section"; id: string }
  | { kind: "sub"; id: string };

const PROBLEM_TEXT: Record<string, () => string> = {
  "no-skill-md": () => t("Нет файла SKILL.md"),
  "frontmatter-delimiter": () => t("Шапка SKILL.md должна начинаться строкой ---"),
  "frontmatter-yaml": () => t("Шапка SKILL.md не читается: ошибка YAML"),
  "name-missing": () => t("В шапке нет имени"),
  "name-invalid": () => t("Имя не подходит BB: только строчные латинские буквы, цифры и дефисы"),
  "name-mismatch": () => t("Имя в шапке не совпадает с папкой"),
  "description-missing": () => t("Нет описания"),
  "description-too-long": () => t("Описание длиннее 1024 символов"),
  "too-big": () => t("Больше 10 МБ — BB не перенесёт в сессию"),
  "too-many-files": () => t("Больше 1000 файлов — BB не перенесёт в сессию"),
  "absolute-skill-path": () => t("Ссылается на ~/.agents/skills: в сессии навык лежит в другом месте"),
};

const SOURCE_TEXT: Record<string, () => string> = {
  manual: () => t("вручную"),
  family: () => t("по соседям"),
  model: () => t("модель"),
};

function problemText(code: string, detail: string): string {
  return PROBLEM_TEXT[code]?.() ?? detail;
}

function blocking(skill: HubSkillView): boolean {
  return skill.problems.some((problem) => problem.blocking);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Category names follow the interface language; the model writes both. */
function label(item: { title: string; titleEn: string }): string {
  return getLang() === "en" ? item.titleEn || item.title : item.title;
}

const SECTION_ICONS: Array<[RegExp, string]> = [
  [/^development|разработ/u, "Code"],
  [/^bb|агент/u, "Bot"],
  [/^marketing|маркет/u, "Target"],
  [/^writing|текст/u, "Edit"],
  [/^design|дизайн/u, "Palette"],
  [/3d|blender/u, "Layers"],
  [/^video|видео/u, "Play"],
  [/^business|бизнес|документ/u, "FileText"],
  [/^research|исслед/u, "Search"],
];

function sectionIcon(id: string): string {
  return SECTION_ICONS.find(([pattern]) => pattern.test(id))?.[1] ?? "Folder";
}

function ServiceRow({
  icon,
  selected,
  onClick,
  label: text,
  count,
  tone,
}: {
  icon: string;
  selected: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "warning" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className="at-nav-item flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left text-sm"
    >
      <Icon
        name={icon}
        className={`size-4 shrink-0 ${tone === "danger" ? "at-text-danger" : tone === "warning" ? "at-text-warning" : "text-muted-foreground"}`}
      />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {tone === undefined ? (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : (
        <span className={`at-pill ${tone === "danger" ? "at-pill-danger" : "at-pill-warning"}`}>{count}</span>
      )}
    </button>
  );
}

function CategoryPicker({
  tree,
  value,
  onChange,
  id,
}: {
  tree: SkillsHub["tree"];
  value: string;
  onChange: (subsectionId: string) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="at-raised h-8 w-full rounded-[8px] border border-input bg-background px-2 text-sm"
    >
      <option value="">{t("Выберите подраздел…")}</option>
      {tree.sections.map((section) => (
        <optgroup key={section.id} label={label(section)}>
          {section.subsections.map((sub) => (
            <option key={sub.id} value={sub.id}>
              {label(sub)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function SkillsPage({ onAttention }: { onAttention?: (count: number) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [hub, setHub] = useState<SkillsHub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [node, setNode] = useState<Node>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillsHubDetail | null>(null);
  const [fileView, setFileView] = useState<{ path: string; text: string | null } | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createSection, setCreateSection] = useState("");
  const [createSub, setCreateSub] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [pullOpen, setPullOpen] = useState(false);
  const [pullHost, setPullHost] = useState("");
  const [pullTarget, setPullTarget] = useState("~/skill-drafts");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [cleanup, setCleanup] = useState<{ hostId: string; hostName: string; moved: Array<{ id: string; count: number }> } | null>(null);

  const act = useCallback(
    async (fn: () => Promise<SkillsHub | void>) => {
      setBusy(true);
      setError(null);
      try {
        const next = await fn();
        if (next) setHub(next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const load = useCallback(() => act(() => rpc.call("skills_hub", null)), [act, rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the classifier works, refresh so new categories appear as they are made.
  useEffect(() => {
    if (!hub?.classifier.running) return;
    const timer = setInterval(() => {
      void rpc.call("skills_hub", null).then(setHub).catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [hub?.classifier.running, rpc]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail(null);
    void rpc
      .call("skills_hub_detail", { name: selected })
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, [selected, rpc, hub?.skills]);

  const skills = hub?.skills ?? [];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const skill of skills) {
      if (skill.category === null) continue;
      map.set(skill.category.subsectionId, (map.get(skill.category.subsectionId) ?? 0) + 1);
      map.set(skill.category.sectionId, (map.get(skill.category.sectionId) ?? 0) + 1);
    }
    return map;
  }, [skills]);
  const reviewCount = skills.filter((skill) => skill.review !== null).length;
  const problemCount = skills.filter(blocking).length;
  const unplacedCount = skills.filter((skill) => skill.category === null && skill.review === null).length;
  const leftovers = (hub?.machines ?? []).filter((machine) => machine.homes.length > 0);

  useEffect(() => {
    onAttention?.(reviewCount + problemCount + leftovers.length);
  }, [onAttention, reviewCount, problemCount, leftovers.length]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showEmpty, setShowEmpty] = useState(false);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (needle !== "") {
        return skill.name.toLowerCase().includes(needle) || (skill.description ?? "").toLowerCase().includes(needle);
      }
      switch (node.kind) {
        case "all":
          return true;
        case "review":
          return skill.review !== null;
        case "problems":
          return skill.problems.length > 0;
        case "unplaced":
          return skill.category === null && skill.review === null;
        case "section":
          return skill.category?.sectionId === node.id;
        case "sub":
          return skill.category?.subsectionId === node.id;
      }
    });
  }, [skills, node, query]);

  const tree = hub?.tree ?? { sections: [] };
  const allOpen = tree.sections.length > 0 && tree.sections.every((section) => expanded.has(section.id));
  const nodeSection = node.kind === "section" ? tree.sections.find((section) => section.id === node.id) : undefined;
  const nodeSubParent =
    node.kind === "sub" ? tree.sections.find((section) => section.subsections.some((sub) => sub.id === node.id)) : undefined;
  const nodeSub = nodeSubParent?.subsections.find((sub) => node.kind === "sub" && sub.id === node.id);
  const categoryEmpty = (nodeSub !== undefined || nodeSection !== undefined) && visible.length === 0;
  const listTitle =
    query.trim() !== ""
      ? tp("Поиск: {0}", query.trim())
      : node.kind === "all"
        ? t("Все навыки")
        : node.kind === "review"
          ? t("На проверке")
          : node.kind === "problems"
            ? t("С ошибками")
            : node.kind === "unplaced"
              ? t("Без категории")
              : nodeSub !== undefined && nodeSubParent !== undefined
                ? `${label(nodeSubParent)} → ${label(nodeSub)}`
                : nodeSection !== undefined ? label(nodeSection) : "";

  const pathOf = (skill: HubSkillView): string | null => {
    if (skill.category === null) return null;
    const section = tree.sections.find((item) => item.id === skill.category?.sectionId);
    const sub = section?.subsections.find((item) => item.id === skill.category?.subsectionId);
    return section && sub ? `${label(section)} → ${label(sub)}` : null;
  };

  const selectedRow = skills.find((skill) => skill.name === selected) ?? null;

  if (hub === null) {
    return (
      <div className="at-card mt-4 p-6 text-sm text-muted-foreground">
        {error === null ? t("Загрузка навыков с хаба…") : error}
      </div>
    );
  }

  if (!hub.available) {
    return (
      <div className="at-card mt-4 p-6 text-sm">
        <p className="font-medium">{t("Папки навыков на хабе нет")}</p>
        <p className="mt-1 text-muted-foreground">{tp("Ожидалась папка {0} на сервере BB.", hub.root)}</p>
      </div>
    );
  }

  const classifierLine = hub.classifier.running
    ? t("Классификатор раскладывает новые навыки…")
    : hub.classifier.lastError !== null
      ? tp("Классификатор остановился: {0}", hub.classifier.lastError)
      : hub.classifier.lastRunAt !== null
        ? tp("Классификатор: последний запуск {0}", formatDate(hub.classifier.lastRunAt))
        : t("Классификатор ещё не запускался");

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>{plural(skills.length, ["навык на хабе", "навыка на хабе", "навыков на хабе"])}</span>
          <span aria-hidden="true">·</span>
          <span>
            {hub.git.isRepo
              ? tp("git {0}{1}", hub.git.head?.sha.slice(0, 7) ?? "?", hub.git.dirty > 0 ? tp(", не закоммичено: {0}", hub.git.dirty) : "")
              : t("без git")}
          </span>
          <span aria-hidden="true">·</span>
          <span className={hub.classifier.lastError !== null ? "at-text-danger" : undefined}>{classifierLine}</span>
        </div>
        <span className="flex-1" />
        <div className="relative w-full sm:w-64">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Поиск по всем навыкам")}
            aria-label={t("Поиск по всем навыкам")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || hub.classifier.running}
          onClick={() => act(() => rpc.call("skills_classify", null))}
        >
          {unplacedCount > 0 ? tp("Разложить новые · {0}", unplacedCount) : t("Разложить новые")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Обновить")}
          disabled={busy}
          onClick={() => act(() => rpc.call("skills_machines_refresh", null))}
        >
          <Icon name="ArrowReloadHorizontal" className="size-4" />
        </Button>
      </div>

      {error === null ? null : (
        <div role="alert" className="at-card flex items-start gap-2 px-3 py-2 text-sm at-text-danger">
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" className="text-xs underline" onClick={() => setError(null)}>
            {t("Скрыть")}
          </button>
        </div>
      )}
      {notice === null ? null : (
        <div role="status" className="at-card flex items-start gap-2 px-3 py-2 text-sm">
          <Icon name="CircleCheck" className="mt-0.5 size-4 shrink-0 at-text-success" />
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button type="button" className="text-xs underline" onClick={() => setNotice(null)}>
            {t("Скрыть")}
          </button>
        </div>
      )}

      {leftovers.length === 0 ? null : (
        <div className="at-card px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon name="AlertTriangle" className="size-4 at-text-warning" />
            <span className="font-medium">{t("На машинах остались копии навыков")}</span>
            <span className="text-xs text-muted-foreground">
              {t("BB и так отдаёт навыки хаба в каждую сессию — копии на машинах дают дубли.")}
            </span>
          </div>
          <ul className="mt-2 space-y-1.5">
            {leftovers.map((machine) => (
              <li key={machine.hostId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{machine.hostName}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {machine.homes.map((home) => `${home.path} ${home.skills + home.links}`).join(" · ")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const preview = await rpc.call("skills_machines_cleanup", { hostId: machine.hostId, dryRun: true });
                      setCleanup({ hostId: machine.hostId, hostName: machine.hostName, moved: preview.moved });
                      return preview.hub;
                    })
                  }
                >
                  {t("Очистить…")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex min-h-[28rem] flex-col gap-3 lg:flex-row">
        {/* Category tree */}
        <nav aria-label={t("Категории навыков")} className="at-panel shrink-0 lg:w-72">
          <div className="at-panel-head flex items-center gap-2">
            <h2 className="flex-1 text-sm font-medium">{t("Категории")}</h2>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t("Новая категория")}
              onClick={() => {
                setCreateSection(nodeSection?.title ?? nodeSubParent?.title ?? "");
                setCreateSub("");
                setCreateOpen(true);
              }}
            >
              <Icon name="Plus" className="size-4" />
            </Button>
          </div>
          <div className="at-panel-body max-h-[60vh] overflow-y-auto p-1.5 lg:max-h-[78vh]">
            <div className="space-y-0.5">
              <ServiceRow icon="ListTodo" selected={node.kind === "all" && query === ""} onClick={() => { setQuery(""); setNode({ kind: "all" }); }} label={t("Все")} count={skills.length} />
              {reviewCount > 0 ? (
                <ServiceRow icon="AlertTriangle" selected={node.kind === "review"} onClick={() => { setQuery(""); setNode({ kind: "review" }); }} label={t("На проверке")} count={reviewCount} tone="warning" />
              ) : null}
              {skills.some((skill) => skill.problems.length > 0) ? (
                <ServiceRow
                  icon="AlertCircle"
                  selected={node.kind === "problems"}
                  onClick={() => { setQuery(""); setNode({ kind: "problems" }); }}
                  label={t("С ошибками")}
                  count={problemCount > 0 ? problemCount : skills.filter((skill) => skill.problems.length > 0).length}
                  tone={problemCount > 0 ? "danger" : undefined}
                />
              ) : null}
              {unplacedCount > 0 ? (
                <ServiceRow icon="FolderUnknown" selected={node.kind === "unplaced"} onClick={() => { setQuery(""); setNode({ kind: "unplaced" }); }} label={t("Без категории")} count={unplacedCount} />
              ) : null}
            </div>

            <div className="mt-3 flex items-center gap-2 px-2 pb-1.5">
              <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("Разделы")}</span>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setExpanded(allOpen ? new Set() : new Set(tree.sections.map((section) => section.id)))
                }
              >
                {allOpen ? t("Свернуть все") : t("Развернуть все")}
              </button>
            </div>

            <div className="space-y-1">
              {tree.sections
                .filter((section) => showEmpty || (counts.get(section.id) ?? 0) > 0)
                .map((section) => {
                  const open = expanded.has(section.id) || (node.kind === "sub" && nodeSubParent?.id === section.id);
                  const subs = section.subsections.filter((sub) => showEmpty || (counts.get(sub.id) ?? 0) > 0);
                  const hiddenEmpty = section.subsections.length - subs.length;
                  const sectionSelected = node.kind === "section" && node.id === section.id && query === "";
                  return (
                    <div key={section.id}>
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          aria-current={sectionSelected ? "page" : undefined}
                          aria-expanded={open}
                          onClick={() => {
                            setQuery("");
                            // A second click on the open, selected section folds it.
                            if (sectionSelected && open) {
                              setExpanded((current) => {
                                const next = new Set(current);
                                next.delete(section.id);
                                return next;
                              });
                              return;
                            }
                            setNode({ kind: "section", id: section.id });
                            setExpanded((current) => new Set(current).add(section.id));
                          }}
                          className="at-nav-item flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5 text-left"
                        >
                          <span className="at-tile flex size-7 shrink-0 items-center justify-center">
                            <Icon name={sectionIcon(section.id)} className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1 text-sm font-medium leading-tight">{label(section)}</span>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">{counts.get(section.id) ?? 0}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={open ? t("Свернуть") : t("Развернуть")}
                          aria-expanded={open}
                          onClick={() => toggle(section.id)}
                          className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
                        </button>
                      </div>
                      {open ? (
                        <ul className="mb-1.5 ml-[21px] mt-0.5 space-y-px border-l border-border pl-2">
                          {subs.map((sub) => {
                            const count = counts.get(sub.id) ?? 0;
                            return (
                              <li key={sub.id}>
                                <button
                                  type="button"
                                  aria-current={node.kind === "sub" && node.id === sub.id && query === "" ? "page" : undefined}
                                  onClick={() => {
                                    setQuery("");
                                    setNode({ kind: "sub", id: sub.id });
                                  }}
                                  className={`at-nav-item flex w-full min-w-0 items-start gap-2 px-2 py-1 text-left text-[13px] ${count === 0 ? "text-muted-foreground" : ""}`}
                                >
                                  <span className="min-w-0 flex-1 leading-snug">{label(sub)}</span>
                                  <span className="pt-px font-mono text-[11px] tabular-nums text-muted-foreground">{count === 0 ? "—" : count}</span>
                                </button>
                              </li>
                            );
                          })}
                          {hiddenEmpty > 0 ? (
                            <li className="px-2 py-0.5 text-[11px] text-muted-foreground">
                              {tp("ещё пустых: {0}", hiddenEmpty)}
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
            </div>

            <label className="mt-3 flex items-center gap-2 border-t border-border/60 px-2 pt-2.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} className="size-3.5" />
              {t("Показывать пустые категории")}
            </label>
          </div>
        </nav>

        {/* Skill list */}
        <section aria-label={listTitle} className="at-panel min-w-0 flex-1">
          <div className="at-panel-head flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{listTitle}</h2>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{visible.length}</span>
            {(nodeSub !== undefined || nodeSection !== undefined) && query === "" ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenameValue(nodeSub?.title ?? nodeSection?.title ?? "");
                    setRenameOpen(true);
                  }}
                >
                  {t("Переименовать")}
                </Button>
                {categoryEmpty ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const next = await rpc.call("skills_category_remove", { id: nodeSub?.id ?? nodeSection?.id ?? "" });
                        setNode({ kind: "all" });
                        return next;
                      })
                    }
                  >
                    {t("Удалить пустую")}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="at-panel-body overflow-hidden">
            {visible.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                {query.trim() !== ""
                  ? t("Ничего не нашлось. Поиск идёт по имени и описанию.")
                  : node.kind === "review"
                    ? t("Нет навыков на проверке.")
                    : t("В этой категории пока нет навыков. Перенесите сюда навык из карточки или дождитесь классификатора.")}
              </div>
            ) : (
              <ul className="max-h-[70vh] divide-y divide-border/60 overflow-y-auto">
                {visible.map((skill) => (
                  <li key={skill.name}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(skill.name);
                        setMoveTarget(skill.category?.subsectionId ?? "");
                      }}
                      aria-current={selected === skill.name ? "true" : undefined}
                      className={`flex w-full min-w-0 flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-muted/50 ${selected === skill.name ? "bg-muted/70" : ""}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-sm">{skill.name}</span>
                        {blocking(skill) ? <span className="at-pill at-pill-danger">{t("BB не примет")}</span> : null}
                        {!blocking(skill) && skill.problems.length > 0 ? <span className="at-pill at-pill-warning">{t("замечание")}</span> : null}
                        {skill.review !== null ? <span className="at-pill at-pill-warning">{t("на проверке")}</span> : null}
                      </span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">{skill.description ?? t("без описания")}</span>
                      {node.kind === "all" || node.kind === "problems" || query !== "" ? (
                        <span className="truncate text-[11px] text-muted-foreground/80">{pathOf(skill) ?? t("без категории")}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Skill card */}
        {selectedRow === null ? null : (
          <aside aria-label={selectedRow.name} className="at-panel min-w-0 lg:w-[26rem] lg:shrink-0">
            <div className="at-panel-head flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{selectedRow.name}</h2>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("Закрыть")} onClick={() => setSelected(null)}>
                <Icon name="CircleX" className="size-4" />
              </Button>
            </div>
            <div className="at-panel-body max-h-[75vh] space-y-4 overflow-y-auto p-3 text-sm">
              <p className="whitespace-pre-wrap break-words">{selectedRow.description ?? t("без описания")}</p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(selectedRow.bytes)} · {plural(selectedRow.files, ["файл", "файла", "файлов"])} · {tp("изменён {0}", formatDate(selectedRow.mtime))}
              </p>

              {selectedRow.problems.length === 0 ? null : (
                <ul className="space-y-1">
                  {selectedRow.problems.map((problem) => (
                    <li key={problem.code} className={`flex gap-2 text-xs ${problem.blocking ? "at-text-danger" : "at-text-warning"}`}>
                      <Icon name={problem.blocking ? "AlertCircle" : "AlertTriangle"} className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        {problemText(problem.code, problem.detail)}
                        <span className="block text-muted-foreground">{problem.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t("Категория")}</h3>
                {selectedRow.review !== null ? (
                  <div className="at-card space-y-2 p-2.5">
                    <p className="text-xs">
                      {selectedRow.review.section !== ""
                        ? tp("Модель предлагает: {0} → {1}", selectedRow.review.section, selectedRow.review.subsection)
                        : t("Модель не ответила")}
                      {selectedRow.review.confidence !== null ? ` (${Math.round(selectedRow.review.confidence * 100)}%)` : ""}
                    </p>
                    {selectedRow.review.reason ? <p className="text-xs text-muted-foreground">{selectedRow.review.reason}</p> : null}
                    {selectedRow.review.section !== "" ? (
                      <Button size="sm" className="at-accent" disabled={busy} onClick={() => act(() => rpc.call("skills_review_accept", { skill: selectedRow.name }))}>
                        {t("Принять")}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p>
                    {pathOf(selectedRow) ?? t("без категории")}
                    {selectedRow.category !== null ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {SOURCE_TEXT[selectedRow.category.source]?.() ?? selectedRow.category.source}
                        {selectedRow.category.confidence !== null ? ` · ${Math.round(selectedRow.category.confidence * 100)}%` : ""}
                      </span>
                    ) : null}
                  </p>
                )}
                {selectedRow.category?.reason ? <p className="text-xs text-muted-foreground">{selectedRow.category.reason}</p> : null}
                <div className="flex gap-2">
                  <CategoryPicker tree={tree} value={moveTarget} onChange={setMoveTarget} />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || moveTarget === "" || moveTarget === selectedRow.category?.subsectionId}
                    onClick={() => {
                      const section = tree.sections.find((item) => item.subsections.some((sub) => sub.id === moveTarget));
                      if (section === undefined) return;
                      void act(() => rpc.call("skills_move", { skill: selectedRow.name, sectionId: section.id, subsectionId: moveTarget }));
                    }}
                  >
                    {t("Перенести")}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t("Файлы")}</h3>
                {detail === null ? (
                  <p className="text-xs text-muted-foreground">{t("Загрузка…")}</p>
                ) : (
                  <ul className="space-y-0.5">
                    {detail.fileList.map((file) => (
                      <li key={file.path}>
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left hover:bg-muted"
                          onClick={() =>
                            void rpc
                              .call("skills_hub_file", { name: selectedRow.name, path: file.path })
                              .then((value) => setFileView({ path: file.path, text: value.text }))
                              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                          }
                        >
                          <Icon name="FileText" className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{formatBytes(file.bytes)}</span>
                        </button>
                      </li>
                    ))}
                    {detail.fileListTruncated ? <li className="text-xs text-muted-foreground">{t("Показаны первые 400 файлов")}</li> : null}
                  </ul>
                )}
              </div>

              {detail !== null && detail.history.length > 0 ? (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">{t("История в git")}</h3>
                  <ul className="space-y-1">
                    {detail.history.map((commit) => (
                      <li key={commit.sha} className="text-xs">
                        <span className="font-mono text-muted-foreground">{commit.sha.slice(0, 7)}</span> {commit.subject}
                        <span className="block text-muted-foreground">{formatDate(commit.at)} · {commit.author}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPullHost(hub.machines[0]?.hostId ?? "");
                    setPullOpen(true);
                  }}
                >
                  <Icon name="Download" className="size-3.5" />
                  {t("Взять в работу")}
                </Button>
                <Button size="sm" variant="ghost" className="at-text-danger" onClick={() => setRemoveOpen(true)}>
                  <Icon name="Archive" className="size-3.5" />
                  {t("Убрать с хаба")}
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>

      <Dialog open={fileView !== null} onOpenChange={(open) => (open ? null : setFileView(null))}>
        <DialogContent data-bb-ru-skip="" className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{fileView?.path}</DialogTitle>
            <DialogDescription>{selectedRow?.name}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-[12px] bg-muted/50 p-3 font-mono text-xs">
            {fileView?.text ?? t("Файл не текстовый или слишком большой")}
          </pre>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-bb-ru-skip="" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Новая категория")}</DialogTitle>
            <DialogDescription>{t("Раздел и подраздел. Если раздел уже есть, подраздел добавится в него.")}</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1 text-xs font-medium text-muted-foreground">
            <span>{t("Раздел")}</span>
            <Input value={createSection} onChange={(event) => setCreateSection(event.target.value)} maxLength={60} />
          </label>
          <label className="block space-y-1 text-xs font-medium text-muted-foreground">
            <span>{t("Подраздел")}</span>
            <Input value={createSub} onChange={(event) => setCreateSub(event.target.value)} maxLength={60} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("Отмена")}</Button>
            <Button
              className="at-accent"
              disabled={busy || createSection.trim() === "" || createSub.trim() === ""}
              onClick={() =>
                act(async () => {
                  const next = await rpc.call("skills_category_create", { section: createSection.trim(), subsection: createSub.trim() });
                  setCreateOpen(false);
                  return next;
                })
              }
            >
              {t("Создать")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent data-bb-ru-skip="" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Переименовать категорию")}</DialogTitle>
            <DialogDescription>{t("Навыки остаются на месте, меняется только название.")}</DialogDescription>
          </DialogHeader>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={60} aria-label={t("Название")} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>{t("Отмена")}</Button>
            <Button
              className="at-accent"
              disabled={busy || renameValue.trim() === ""}
              onClick={() =>
                act(async () => {
                  const next = await rpc.call("skills_category_rename", { id: nodeSub?.id ?? nodeSection?.id ?? "", title: renameValue.trim() });
                  setRenameOpen(false);
                  return next;
                })
              }
            >
              {t("Сохранить")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pullOpen} onOpenChange={setPullOpen}>
        <DialogContent data-bb-ru-skip="" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tp("Взять в работу: {0}", selectedRow?.name ?? "")}</DialogTitle>
            <DialogDescription>
              {t("Копия навыка с хаба ляжет в папку на машине. Поправьте её и опубликуйте обратно: bb tools skills-publish <папка>.")}
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1 text-xs font-medium text-muted-foreground">
            <span>{t("Машина")}</span>
            <select
              value={pullHost}
              onChange={(event) => setPullHost(event.target.value)}
              className="at-raised h-8 w-full rounded-[8px] border border-input bg-background px-2 text-sm text-foreground"
            >
              {hub.machines.map((machine) => (
                <option key={machine.hostId} value={machine.hostId}>{machine.hostName}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs font-medium text-muted-foreground">
            <span>{t("Папка")}</span>
            <Input value={pullTarget} onChange={(event) => setPullTarget(event.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPullOpen(false)}>{t("Отмена")}</Button>
            <Button
              className="at-accent"
              disabled={busy || pullHost === "" || selectedRow === null}
              onClick={() =>
                act(async () => {
                  const result = await rpc.call("skills_pull", { name: selectedRow?.name ?? "", hostId: pullHost, target: pullTarget.trim() || null });
                  setPullOpen(false);
                  if (result.ok) setNotice(tp("Навык скопирован в {0}", result.path ?? ""));
                  else setError(result.error ?? t("Не удалось"));
                })
              }
            >
              {t("Скопировать")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent data-bb-ru-skip="" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tp("Убрать {0} с хаба?", selectedRow?.name ?? "")}</DialogTitle>
            <DialogDescription>
              {t("Навык пропадёт из всех сессий BB. Папка уйдёт в архив на хабе, удаление запишется в git — вернуть можно из истории.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>{t("Отмена")}</Button>
            <Button
              variant="destructive"
              disabled={busy || selectedRow === null}
              onClick={() =>
                act(async () => {
                  const result = await rpc.call("skills_remove", { name: selectedRow?.name ?? "" });
                  setRemoveOpen(false);
                  if (result.ok) {
                    setNotice(tp("Убрано с хаба: {0}", selectedRow?.name ?? ""));
                    setSelected(null);
                  } else setError(result.error ?? t("Не удалось"));
                  return result.hub;
                })
              }
            >
              {t("Убрать")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cleanup !== null} onOpenChange={(open) => (open ? null : setCleanup(null))}>
        <DialogContent data-bb-ru-skip="" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tp("Очистить папки навыков на {0}?", cleanup?.hostName ?? "")}</DialogTitle>
            <DialogDescription>
              {t("Всё переедет в архив ~/.agents/skills-backups/cleanup-<дата> на этой машине, ничего не удаляется. Папки самих CLI (synced у Claude Code, .system у Codex) остаются.")}
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-0.5 text-sm">
            {(cleanup?.moved ?? []).map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span className="font-mono text-xs">{item.id}</span>
                <span className="font-mono text-xs tabular-nums">{item.count}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {t("Вне BB (терминал, codex exec, writer-линии) этих навыков больше не будет.")}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanup(null)}>{t("Отмена")}</Button>
            <Button
              className="at-accent"
              disabled={busy || cleanup === null}
              onClick={() =>
                act(async () => {
                  const target = cleanup;
                  if (target === null) return;
                  const result = await rpc.call("skills_machines_cleanup", { hostId: target.hostId, dryRun: false });
                  setCleanup(null);
                  if (result.errors.length > 0) setError(result.errors.join("; "));
                  else setNotice(tp("Готово: копии с {0} перенесены в {1}", target.hostName, result.backup ?? ""));
                  return result.hub;
                })
              }
            >
              {t("Очистить")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
