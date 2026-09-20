// Инструменты агентов: слева устройства и шлюзы, справа рабочая область —
// таблицы «Каталог», «Новые», «CLI выбранной машины», «Скрытые» в стиле BB
// (рамка, шапка колонок, умеренная плотность строк).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Overview, HostView } from "./server";
import type {
  SkillBackup,
  CatalogEntry,
  McpServer,
  Pending,
  CliPluginItem,
  OpenCodeOverview,
  OpenCodeProviderRow,
  OpenCodeOp,
  OpenCodeModelItem,
} from "./contract";
import { agentLabel, supportsDisable } from "./agents";
import {
  locationPath,
  resolveRowAction,
  type SkillActionMode,
  type SkillRow as SkillRowT,
} from "./skills";
import { CANONICAL_OPENCODE_PROVIDERS, STALE_OPENCODE_PROVIDERS } from "./opencode";
import { t, tp, plural, setLang, setDictionary, type Lang } from "./i18n";
import { EN } from "./i18n.en";

setDictionary(EN);
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type CellState = "present" | "partial" | "missing" | "different" | "n/a";

/** Один срез списка предложенных серверов — переключается панелью фильтров. */
type PendingFilterKey = "all" | "new" | "gateway" | "local";

const PENDING_LIMIT = 12;

/** Снимок архива вместе с машиной, на которой он лежит. */
type SkillBackupRow = SkillBackup & { hostId: string; hostName: string };

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("overview", null).then((result) => {
      // Язык приходит вместе с данными: t() в дочерних компонентах читает его
      // из модуля, поэтому ставим до первой отрисовки.
      setLang(result.lang);
      setData(result);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(refetch, [refetch]);
  useRealtime("mcp-changed", refetch);

  /** Любое действие возвращает свежий обзор — состояние не устаревает. */
  const act = useCallback(
    async (run: () => Promise<Overview>) => {
      setBusy(true);
      try {
        const next = await run();
        setLang(next.lang);
        setData(next);
        setError(null);
      } catch (cause) {
        report(cause);
      } finally {
        setBusy(false);
      }
    },
    [report],
  );
  return { rpc, data, error, busy, act, refetch, report };
}

/** Русские склонения: 1 сервер, 2 сервера, 5 серверов. */
function relative(at: number | null): string {
  if (at === null) return t("никогда");
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return t("только что");
  if (minutes < 60) return tp("{0} мин назад", minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tp("{0} ч назад", hours);
  return tp("{0} дн назад", Math.round(hours / 24));
}

function describe(server: {
  transport: string;
  command?: string;
  url?: string;
  args?: string[];
}): string {
  if (server.transport === "stdio") {
    return [server.command ?? "", ...(server.args ?? [])].join(" ").trim();
  }
  return server.url ?? "";
}

/** Одна строка с полным описанием предложенного сервера — уходит в title, не в текст. */
function pendingTitle(item: Pending): string {
  const parts = [item.hostName, item.kind, describe(item.spec)];
  if (item.localOnly) parts.push(item.reason);
  return parts.filter((part) => part.length > 0).join(" · ");
}

/** Уникальные машины из всех occurrences, в порядке первого появления. */
function uniqueHostNames(item: Pending): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const occurrence of item.occurrences) {
    if (seen.has(occurrence.hostName)) continue;
    seen.add(occurrence.hostName);
    names.push(occurrence.hostName);
  }
  return names.length > 0 ? names : [item.hostName];
}

/** Где нашёлся предложенный сервер — все машины через запятую, для шлюзовых явно называет MetaMCP. */
function pendingWhere(item: Pending): string {
  const names = uniqueHostNames(item);
  const text =
    names.length > 2
      ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
      : names.join(", ");
  return item.kind === "metamcp-stdio" ? `${text} › MetaMCP` : text;
}

/** Полный состав ячейки «Где найден» — машина → CLI, и где выключен — уходит в title. */
function pendingWhereTitle(item: Pending): string {
  return item.occurrences
    .map((occurrence) => {
      const line = `${occurrence.hostName} → ${agentLabel(occurrence.kind)}`;
      return occurrence.disabled ? tp("{0} (выключен)", line) : line;
    })
    .join("\n");
}

/** Хотя бы одна occurrence умеет выключение — иначе сервер можно только удалить. */
function hasTogglable(item: Pending): boolean {
  return item.occurrences.some((occurrence) => occurrence.togglable);
}

/** Агрегат состояния «включён/выключен» по всем occurrences сервера. */
function occurrencesEnabledState(item: Pending): EnabledState {
  const allDisabled = item.occurrences.every(
    (occurrence) => occurrence.disabled,
  );
  if (allDisabled) return "disabled";
  const allEnabled = item.occurrences.every(
    (occurrence) => !occurrence.disabled,
  );
  return allEnabled ? "enabled" : "mixed";
}

/** Текст результата set_server_enabled — уходит в notice под действиями. */
function toggleNotice(
  name: string,
  enabled: boolean,
  result: { changed: number; skipped: number; errors: string[] },
): string {
  const verb = enabled ? t("включено") : t("выключено");
  let message = tp("{0}: {1} в {2}", name, verb, plural(result.changed, ["конфиге", "конфигах", "конфигах"]));
  if (result.skipped > 0)
    message += tp(", пропущено {0} (формат без флага выключения)", result.skipped);
  if (result.errors.length > 0) message += `\n${result.errors.join("\n")}`;
  return message;
}

/** Достаёт namespace шлюза MetaMCP из url ребёнка вида .../metamcp/<namespace>/... */
function namespaceOf(server: { url?: string }): string | null {
  const match = server.url?.match(/\/metamcp\/([^/]+)\//);
  return match ? match[1] : null;
}

/** Компактный размер кнопок внутри дерева ветвей. */
const TREE_ACTION = "h-6 px-2 text-xs";
/** На телефоне нет hover — кнопки строки всегда видны, на десктопе проявляются при наведении. */
const ROW_ACTIONS =
  "inline-flex items-center justify-end gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100";

function CollectionFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-border",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Команда локального запуска шлюза — «metamcp run» и подобные. */
const GATEWAY_LAUNCHER = /metamcp/i;

/** Серверы из .agents/metamcp.mcp.json той же машины — дети записи-лаунчера шлюза. */
function metamcpStdioServers(data: Overview, hostId: string): McpServer[] {
  const host = data.hosts.find((item) => item.hostId === hostId);
  return (
    host?.agents.find((agent) => agent.kind === "metamcp-stdio")?.servers ?? []
  );
}

const STATE_LABEL: Record<CellState, string> = {
  present: t("есть"),
  partial: t("есть не во всех CLI"),
  missing: t("не хватает"),
  different: t("отличается"),
  "n/a": t("агент не управляется"),
};

const STATE_COLOR: Record<CellState, string> = {
  present: "bg-emerald-500",
  partial: "bg-amber-500",
  missing: "bg-destructive",
  different: "bg-amber-500",
  "n/a": "bg-border",
};

function StateDot({ state }: { state: CellState }) {
  return (
    <span
      role="img"
      aria-label={STATE_LABEL[state]}
      title={STATE_LABEL[state]}
      className={cn("inline-block size-1.5 rounded-full", STATE_COLOR[state])}
    />
  );
}

/** Легенда над матрицей каталога — цвет точки дополнен словом, а не заменяет его. */
function StateLegend() {
  const items: Array<{ state: CellState; label: string }> = [
    { state: "present", label: t("есть") },
    { state: "partial", label: t("есть не везде") },
    { state: "different", label: t("отличается") },
    { state: "missing", label: t("не хватает") },
    { state: "n/a", label: t("не управляется") },
  ];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.state} className="inline-flex items-center gap-1.5">
          <StateDot state={item.state} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** Состояние «включён/выключен по конфигу»: одно значение или агрегат по нескольким occurrences. */
type EnabledState = "enabled" | "disabled" | "mixed";

const ENABLED_LABEL: Record<EnabledState, string> = {
  enabled: t("включён в конфиге"),
  disabled: t("выключен в конфиге"),
  mixed: t("включён не везде"),
};

const ENABLED_COLOR: Record<EnabledState, string> = {
  enabled: "bg-emerald-500",
  disabled: "bg-muted-foreground/40",
  mixed: "bg-amber-500",
};

/**
 * Точка «включён/выключен по конфигу» перед именем сервера. Это не «живость» —
 * плагин не опрашивает процессы, только читает spec.disabled из конфига (или
 * агрегат disabled по всем occurrences, если сервер найден в нескольких местах).
 */
function EnabledDot({ state, note }: { state: EnabledState; note?: string }) {
  const label = ENABLED_LABEL[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={note ? `${label} — ${note}` : label}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        ENABLED_COLOR[state],
      )}
    />
  );
}

/** Легенда точки «включён/выключен» — отдельно от легенды состояний матрицы каталога. */
function EnabledLegend() {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <EnabledDot state="enabled" />
        {t("включён в конфиге")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <EnabledDot state="disabled" />
        {t("выключен в конфиге")}
      </span>
    </div>
  );
}

/**
 * Состояния скиллов вне канона. Цвет по общей палитре страницы и только
 * дополняет слово: destructive — в каноне такого скилла нет, amber — содержимое
 * разошлось, emerald — содержимое совпадает с каноном (копию можно убрать
 * безопасно), bg-border — трогать не нужно.
 */
const SKILL_STATE_LABEL: Record<string, string> = {
  "only-here": t("новый — не в каноне"),
  diverged: t("расходится с каноном"),
  copy: t("копия канона"),
  "stray-link": t("лишняя ссылка"),
  "bb-registry": t("дубль реестра BB"),
  "canonical-source": t("источник канона"),
};

const SKILL_STATE_HINT: Record<string, string> = {
  "only-here": t("в каноне такого скилла нет — перенести"),
  diverged: t("содержимое папки отличается от канона — решить, кто прав"),
  copy: t("содержимое совпадает с каноном — дубликат"),
  "stray-link": t("ссылка в папке, которую мы не используем"),
  "bb-registry":
    t("ссылка в ~/.bb/skills — BB подставляет этот скилл в свои сессии сам, поэтому внутри BB он виден дважды; нужна только для запуска CLI вне BB"),
  "canonical-source": t("реальное хранилище, на которое ссылается канон"),
};

const SKILL_STATE_COLOR: Record<string, string> = {
  "only-here": "bg-destructive",
  diverged: "bg-amber-500",
  copy: "bg-emerald-500",
  "stray-link": "bg-border",
  "bb-registry": "bg-amber-500",
  "canonical-source": "bg-border",
};

function SkillStateDot({ state }: { state: string }) {
  const label = SKILL_STATE_LABEL[state] ?? state;
  return (
    <span
      role="img"
      aria-label={label}
      title={SKILL_STATE_HINT[state] ?? label}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        SKILL_STATE_COLOR[state] ?? "bg-border",
      )}
    />
  );
}

/** Легенда над таблицей скиллов — те же слова, что в колонке «Состояние». */
function SkillStateLegend() {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {(["only-here", "copy", "diverged", "stray-link", "bb-registry", "canonical-source"] as const).map(
        (state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <SkillStateDot state={state} />
            {SKILL_STATE_LABEL[state]}
          </span>
        ),
      )}
    </div>
  );
}

/** Срезы одного набора скиллов — панель фильтров со счётчиками, как у новых серверов. */
type SkillFilterKey = "all" | "copy" | "new" | "diverged" | "stray" | "bbdup";

const SKILL_FILTERS: Array<{ key: SkillFilterKey; label: string; hint: string }> = [
  { key: "all", label: t("Все"), hint: t("Все скиллы вне канона ~/.agents/skills") },
  { key: "copy", label: t("Копии"), hint: t("Содержимое совпадает с каноном — дубликаты") },
  { key: "new", label: t("Новые"), hint: t("В каноне такого скилла нет") },
  { key: "diverged", label: t("Расходятся"), hint: t("Содержимое отличается от канона") },
  { key: "stray", label: t("Лишние ссылки"), hint: t("Ссылки в папках, которые мы не используем") },
  {
    key: "bbdup",
    label: t("Дубли BB"),
    hint: t("Ссылки в ~/.bb/skills: внутри BB скилл виден дважды, вне BB ссылка нужна — решение по каждой строке за тобой"),
  },
];

function skillFilterOf(state: string): SkillFilterKey | null {
  if (state === "copy") return "copy";
  if (state === "only-here") return "new";
  if (state === "diverged") return "diverged";
  if (state === "stray-link") return "stray";
  if (state === "bb-registry") return "bbdup";
  return null;
}

/** Труcированный путь с полным значением в тултипе — используется для конфигов CLI. */
function TruncatedPath({ path }: { path: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="block max-w-[220px] truncate text-xs text-muted-foreground outline-none"
        >
          {path}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{path}</TooltipContent>
    </Tooltip>
  );
}

type ManagedAgent = HostView["agents"][number];

/** Состояние одной записи каталога на одной машине (по всем её агентам). */
function hostState(machine: HostView, entry: CatalogEntry): CellState {
  // CLI без установленного бинаря или без конфига не участвуют: плагин
  // никогда не создаёт конфиги с неподтверждённым путём, так что «там пусто» —
  // не «не хватает», а «не управляется».
  const agents = machine.agents.filter(
    (agent) =>
      agent.manageable &&
      agent.installed &&
      agent.configExists &&
      (entry.targets.length === 0 || entry.targets.includes(agent.kind)),
  );
  if (agents.length === 0) return "n/a";
  let present = 0;
  let missing = 0;
  let different = false;
  for (const agent of agents) {
    const found = agent.servers.find((server) => server.name === entry.name);
    if (found === undefined) {
      missing += 1;
      continue;
    }
    present += 1;
    // Локальная запись машинно-зависима: пути и команды на каждой машине свои,
    // сверять их с каталогом нельзя — иначе вечное ложное «отличается».
    if (entry.scope !== "local-only" && describe(found) !== describe(entry.spec))
      different = true;
  }
  if (present === 0) return "missing";
  if (missing > 0) return "partial";
  return different ? "different" : "present";
}

function agentState(agent: ManagedAgent, entry: CatalogEntry): CellState {
  if (!agent.manageable || !agent.installed || !agent.configExists) return "n/a";
  if (entry.targets.length > 0 && !entry.targets.includes(agent.kind))
    return "n/a";
  const found = agent.servers.find((server) => server.name === entry.name);
  if (found === undefined) return "missing";
  if (entry.scope === "local-only") return "present";
  return describe(found) === describe(entry.spec) ? "present" : "different";
}


/**
 * Сводка канона: строка на скилл, колонка на машину. Здесь видно главное —
 * одинаков ли набор навыков везде, и куда он раскатан внутри машины.
 */
function SkillCanon({ data, selected }: { data: Overview; selected: string | null }) {
  const [filter, setFilter] = useState<"all" | "gaps" | "differs" | "plugin">("all");
  const [query, setQuery] = useState("");
  const rows = data.skillCanon;
  const hosts = data.skills.map((view) => ({ hostId: view.hostId, hostName: view.hostName }));
  const counts = useMemo(
    () => ({
      all: rows.length,
      gaps: rows.filter((row) => row.hosts.some((item) => item.state === "missing")).length,
      differs: rows.filter((row) => row.hosts.some((item) => item.state === "differs")).length,
      plugin: rows.filter((row) => row.fromPlugin).length,
    }),
    [rows],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (needle !== "" && !row.name.toLowerCase().includes(needle)) return false;
      if (filter === "gaps") return row.hosts.some((item) => item.state === "missing");
      if (filter === "differs") return row.hosts.some((item) => item.state === "differs");
      if (filter === "plugin") return row.fromPlugin;
      return true;
    });
  }, [rows, filter, query]);

  if (rows.length === 0) {
    return (
      <Section title={t("Канон")} count={0}>
        <p className="text-sm text-muted-foreground">
          {t("Канон пуст или машины ещё не просканированы.")}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t("Канон ~/.agents/skills")} count={rows.length}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([
          ["all", t("Все")],
          ["gaps", t("Не на всех машинах")],
          ["differs", t("Расходятся")],
          ["plugin", t("Отдаёт плагин")],
        ] as const).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? "default" : "outline"}
            onClick={() => setFilter(key)}
          >
            {label}
            <span className="ml-1.5 text-xs opacity-70">{counts[key]}</span>
          </Button>
        ))}
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Поиск по имени")}
          className="h-8 w-52"
        />
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filter === "gaps"
            ? t("Набор навыков одинаковый на всех машинах.")
            : filter === "differs"
              ? t("Расхождений между машинами нет.")
              : t("Ничего не нашлось.")}
        </p>
      ) : (
        <div className="max-h-[32rem] max-w-full overflow-auto overscroll-x-contain rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Скилл")}</TableHead>
                {hosts.map((host) => (
                  <TableHead key={host.hostId} className="whitespace-nowrap">{host.hostName}</TableHead>
                ))}
                <TableHead>{t("Разложен в дома")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="font-medium">
                    {row.name}
                    {row.fromPlugin ? (
                      <Badge variant="outline" className="ml-2 py-0 font-normal text-muted-foreground">
                        {t("плагин")}
                      </Badge>
                    ) : null}
                  </TableCell>
                  {row.hosts.map((item) => (
                    <TableCell key={item.hostId}>
                      {item.state === "same" ? (
                        <span className="text-emerald-600" title={t("есть, содержимое как у всех")}>{t("есть")}</span>
                      ) : item.state === "differs" ? (
                        <span className="text-amber-600" title={t("есть, но содержимое отличается")}>{t("отличается")}</span>
                      ) : (
                        <span className="text-destructive" title={t("на этой машине нет")}>{t("нет")}</span>
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-xs text-muted-foreground">
                    {(() => {
                      // Выбрана машина — показываем её дома, иначе то, что есть везде:
                      // объединение соврало бы, будто дом есть на каждой машине.
                      const lists = row.hosts
                        .filter((item) => selected === null || item.hostId === selected)
                        .map((item) => item.homes);
                      const homes = lists.length === 0
                        ? []
                        : lists.reduce((acc, list) => acc.filter((id) => list.includes(id)));
                      return homes.length === 0
                        ? t("только канон")
                        : [...homes].sort().map((id) => locationPath(id)).join(", ");
                    })()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

/** Понятная дата снимка: «18 сентября, 05:57». */
function backupWhen(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

function backupSize(bytes: number): string {
  if (bytes < 1024) return tp("{0} Б", bytes);
  if (bytes < 1024 * 1024) return tp("{0} КБ", Math.round(bytes / 1024));
  return tp("{0} МБ", (bytes / 1024 / 1024).toFixed(1));
}

/**
 * Архив снимков скиллов: сюда попадает всё, что раскатка или правила заменили
 * или убрали. Любую версию можно вернуть в канон — и она разъедется по машинам
 * следующим синком.
 */
function SkillBackups({ hostId, lastScanAt }: { hostId: string | null; lastScanAt: number | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<SkillBackupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyUnique, setOnlyUnique] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("skills_backups", { hostId }).then(
      (result) => {
        setRows(result.backups);
        setError(result.errors.length === 0 ? null : result.errors.join("\n"));
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, hostId]);
  useEffect(load, [load, lastScanAt]);

  const visible = useMemo(
    () => (rows ?? []).filter((row) => !onlyUnique || row.unique),
    [rows, onlyUnique],
  );
  const uniqueCount = (rows ?? []).filter((row) => row.unique).length;

  if (rows === null) {
    return <p className="mt-4 text-sm text-muted-foreground">{t("Читаем архив на машинах…")}</p>;
  }

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant={onlyUnique ? "default" : "outline"} onClick={() => setOnlyUnique((value) => !value)}>
          {t("Только уникальные")} · {uniqueCount}
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="mb-3 whitespace-pre-wrap text-sm text-destructive">{t(error)}</p>
      )}
      {notice === null ? null : (
        <p className="mb-3 whitespace-pre-wrap text-sm text-muted-foreground">{t(notice)}</p>
      )}
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {rows.length === 0 ? t("Архив пуст: ничего не заменяли и не удаляли.") : t("Уникальных снимков нет — всё это уже есть в каноне.")}
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Скилл")}</TableHead>
                <TableHead>{t("Когда")}</TableHead>
                <TableHead>{t("Машина")}</TableHead>
                <TableHead>{t("Почему снят")}</TableHead>
                <TableHead className="text-right">{t("Размер")}</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={`${row.hostId}:${row.id}`}>
                  <TableCell className="font-medium">
                    {row.name}
                    {row.unique ? (
                      <Badge variant="outline" className="ml-2 py-0 font-normal text-amber-600">{t("уникальная")}</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{backupWhen(row.at)}</TableCell>
                  <TableCell className="text-muted-foreground">{row.hostName}</TableCell>
                  <TableCell className="text-muted-foreground">{row.reason}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {row.files} {t("ф")} · {backupSize(row.bytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    {confirming === `${row.hostId}:${row.id}` ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            rpc.call("skills_backup_restore", { hostId: row.hostId, id: row.id }).then(
                              (result) => {
                                setNotice(result.message ?? tp("{0}: восстановлен", row.name));
                                setConfirming(null);
                                setBusy(false);
                                load();
                              },
                              (cause: unknown) => {
                                setError(cause instanceof Error ? cause.message : String(cause));
                                setBusy(false);
                              },
                            );
                          }}
                        >
                          {t("Вернуть в канон")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                          {t("Отмена")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirming(`${row.hostId}:${row.id}`)}
                      >
                        {t("Восстановить")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">
          {title}
          {count === undefined ? null : (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {count}
            </span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function HostStrip({
  data,
  selected,
  onSelect,
}: {
  data: Overview;
  selected: string | null;
  onSelect: (hostId: string | null) => void;
}) {
  const value = selected ?? "all";
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onSelect(next === "all" ? null : next)}
      className="mb-3 max-w-full md:hidden"
    >
      <TabsList aria-label={t("Устройства")} className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabsTrigger value="all">{t("Все машины")}</TabsTrigger>
        {data.hosts.map((machine) => (
          <TabsTrigger key={machine.hostId} value={machine.hostId} className="max-w-[9rem] min-w-0 truncate">
            {machine.name}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function DeviceList({
  data,
  selected,
  onSelect,
}: {
  data: Overview;
  selected: string | null;
  onSelect: (hostId: string | null) => void;
}) {
  return (
    <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-border/60 p-3 md:block">
      <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("Устройства")}
      </h2>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "mb-1 w-full rounded-md border px-2 py-2 text-left text-sm hover:text-foreground",
          selected === null
            ? "border-border text-foreground"
            : "border-transparent text-muted-foreground",
        )}
      >
        {t("Все машины")}
        <span className="ml-2 text-xs text-muted-foreground">
          {data.hosts.length}
        </span>
      </button>
      {data.hosts.map((machine) => {
        const drift = data.drift.filter(
          (item) => item.hostId === machine.hostId,
        ).length;
        const agents = machine.agents.filter(
          (agent) => agent.installed && !agent.gateway,
        ).length;
        return (
          <button
            key={machine.hostId}
            type="button"
            onClick={() => onSelect(machine.hostId)}
            className={cn(
              "mb-1 w-full rounded-md border px-2 py-2 text-left hover:text-foreground",
              selected === machine.hostId
                ? "border-border text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            <span className="flex items-center gap-2">
              <Icon
                name={machine.platform === "linux" ? "Cloud" : "Laptop"}
                className={cn(
                  "size-4",
                  machine.status === "connected"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {machine.name}
              </span>
              {drift > 0 ? (
                <span className="rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">
                  {drift}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate pl-6 text-xs text-muted-foreground">
              {machine.status === "connected"
                ? `${plural(agents, ["CLI", "CLI", "CLI"])} · ${relative(machine.scannedAt)}`
                : t("не на связи")}
            </span>
          </button>
        );
      })}

      {data.hosts.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          {t("Нет подключённых машин. Подключите хотя бы одну — плагин читает конфиги CLI прямо на них.")}
        </p>
      ) : null}

      {data.metamcp.length === 0 &&
      !data.hosts.some(
        (machine) => metamcpStdioServers(data, machine.hostId).length > 0,
      ) ? null : (
        <>
          <h2 className="mt-4 px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Шлюзы")}
          </h2>

          {/* Содержимое хабового namespace одно на все машины: показываем его
              один раз и подписываем охват, иначе три одинаковых блока читаются
              как три независимых набора. */}
          {data.metamcp.map((remote) => {
            const linked = data.hosts.filter((machine) =>
              metamcpStdioServers(data, machine.hostId).some(
                (server) => namespaceOf(server) === remote.namespace,
              ),
            );
            const everywhere = linked.length === data.hosts.length && linked.length > 0;
            const coverage =
              linked.length === 0
                ? t("не подключён ни на одной машине")
                : everywhere
                  ? t("есть на всех машинах")
                  : tp("есть на: {0}", linked.map((machine) => machine.name).join(", "));
            return (
              <div key={remote.namespace} className="rounded-md border border-dashed px-2 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <Icon name="Cloud" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{tp("Через хаб · /{0}", remote.namespace)}</span>
                </span>
                <span
                  className={`mt-0.5 block pl-6 text-xs ${
                    linked.length === 0 ? "text-amber-600" : "text-muted-foreground"
                  }`}
                >
                  {coverage}
                </span>
                <ul className="mt-1 space-y-0.5 pl-6">
                  {remote.error !== null ? (
                    <li className="text-xs text-destructive">
                      {t("ошибка")}: {t(remote.error)}
                    </li>
                  ) : remote.servers.length === 0 ? (
                    <li className="text-xs text-muted-foreground">{t("пусто")}</li>
                  ) : (
                    remote.servers.map((inner) => (
                      <li key={inner.name} className="truncate text-xs text-foreground/80">
                        {inner.name}
                        <span className="ml-1 text-muted-foreground opacity-70">{inner.tools}</span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            );
          })}

          {data.hosts.map((machine) => {
            const children = metamcpStdioServers(data, machine.hostId);
            if (children.length === 0) return null;
            // Ссылки в хабовый namespace уже показаны общим блоком выше —
            // здесь остаётся только то, что живёт на самой машине.
            const own = children.filter((server) => {
              const namespace = namespaceOf(server);
              return (
                namespace === null ||
                !data.metamcp.some((entry) => entry.namespace === namespace)
              );
            });
            const viaHub = children.length - own.length;
            return (
              <div key={machine.hostId} className="rounded-md px-2 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <Icon name="Globe" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">MetaMCP</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {machine.name}
                  </span>
                </span>
                {own.length === 0 ? (
                  <span className="mt-0.5 block pl-6 text-xs text-muted-foreground">
                    {t("только через хаб")}
                  </span>
                ) : (
                  <ul className="mt-1 space-y-0.5 pl-6">
                    {own.map((server) => (
                      <li key={server.name} className="text-xs">
                        <span className="flex items-center gap-1.5">
                          <EnabledDot
                            state={server.disabled === true ? "disabled" : "enabled"}
                          />
                          <span className="truncate text-foreground/80">{server.name}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {viaHub === 0 ? null : (
                  <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                    {tp("плюс через хаб: {0}", viaHub)}
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}
    </aside>
  );
}

function CatalogTable({
  data,
  selected,
  onRemove,
  onPurge,
  busy,
}: {
  data: Overview;
  selected: string | null;
  onRemove: (name: string) => void;
  onPurge: (name: string) => void;
  busy: boolean;
}) {
  // Удаление с машин подтверждается вторым нажатием на ту же кнопку.
  const [confirming, setConfirming] = useState<string | null>(null);
  const machine =
    selected === null
      ? null
      : (data.hosts.find((item) => item.hostId === selected) ?? null);
  const columns = useMemo(() => {
    if (machine === null) {
      return data.hosts.map((item) => ({ id: item.hostId, label: item.name }));
    }
    return machine.agents
      .filter((agent) => agent.manageable)
      .map((agent) => ({ id: agent.kind, label: agent.label }));
  }, [data.hosts, machine]);

  if (data.catalog.length === 0) {
    // Пустой каталог бывает двух видов: серверы на машинах уже нашлись и ждут
    // приёмки — или не нашлось ничего, и совет «примите из списка ниже» упёрся
    // бы в пустоту. Во втором случае объясняем, с чего начать.
    return (
      <p className="max-w-2xl text-sm text-muted-foreground">
        {data.pending.length > 0
          ? t("Пусто. Примите серверы из списка ниже — они станут общим стандартом для всех машин.")
          : t("Пока пусто. Плагин не придумывает серверы сам: настройте MCP-сервер в любом CLI (Claude Code, Codex, OpenCode, Cursor…) и нажмите «Обновить» — он появится в списке «Новые», и оттуда его можно сделать общим для всех машин. Если серверы живут за шлюзом MetaMCP, укажите его адрес и ключ в настройках плагина.")}
      </p>
    );
  }

  return (
    <div>
      <StateLegend />
      <EnabledLegend />
      <CollectionFrame>
        <Table className="min-w-[36rem]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-3 text-xs font-medium text-muted-foreground">
                {t("Сервер")}
              </TableHead>
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  className="px-3 text-center text-xs font-medium text-muted-foreground"
                >
                  {column.label}
                </TableHead>
              ))}
              <TableHead className="px-3 text-right text-xs font-medium text-muted-foreground">
                {t("Область")}
              </TableHead>
              <TableHead className="w-10 px-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.catalog.map((entry) => (
              <TableRow key={entry.name} className="group">
                <TableCell className="max-w-[min(18rem,70vw)] px-3 py-2.5" title={describe(entry.spec)}>
                  <div
                    className={cn(
                      "flex items-center gap-1.5 text-sm font-medium",
                      entry.spec.disabled === true
                        ? "text-muted-foreground"
                        : undefined,
                    )}
                  >
                    <EnabledDot
                      state={
                        entry.spec.disabled === true ? "disabled" : "enabled"
                      }
                    />
                    {entry.name}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {describe(entry.spec)}
                  </div>
                </TableCell>
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className="px-3 py-2.5 text-center"
                  >
                    <span className="inline-flex justify-center">
                      <StateDot
                        state={
                          machine === null
                            ? hostState(
                                data.hosts.find(
                                  (item) => item.hostId === column.id,
                                )!,
                                entry,
                              )
                            : agentState(
                                machine.agents.find(
                                  (agent) => agent.kind === column.id,
                                )!,
                                entry,
                              )
                        }
                      />
                    </span>
                  </TableCell>
                ))}
                <TableCell className="px-3 py-2.5 text-right text-xs text-muted-foreground">
                  {entry.scope === "local-only" ? t("локальный") : null}
                </TableCell>
                <TableCell className="px-2 py-2.5 text-right">
                  <span className={ROW_ACTIONS}>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      aria-label={tp("Убрать {0} из каталога, на машинах оставить", entry.name)}
                      disabled={busy}
                      onClick={() => onRemove(entry.name)}
                    >
                      <Icon name="Trash2" className="size-4" />
                    </Button>
                    {confirming === entry.name ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null);
                          onPurge(entry.name);
                        }}
                      >
                        {t("Точно?")}
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        aria-label={tp("Удалить {0} со всех машин", entry.name)}
                        disabled={busy}
                        onClick={() => setConfirming(entry.name)}
                      >
                        <Icon name="CircleX" className="size-4" />
                      </Button>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollectionFrame>
    </div>
  );
}

/** Панель фильтров-пилюль над таблицей новых серверов — один набор данных в разных срезах. */
const PENDING_FILTERS: Array<{ key: PendingFilterKey; label: string; hint?: string }> = [
  { key: "all", label: t("В CLI"), hint: t("Подключены прямо в CLI. Состав шлюза — на вкладке «За шлюзом MetaMCP».") },
  { key: "new", label: t("Новые") },
  { key: "gateway", label: t("За шлюзом MetaMCP") },
  { key: "local", label: t("Локальные") },
];

/** Сегментированный переключатель среза — штатные вкладки BB, а не текст. */
function PendingFilters({
  value,
  onChange,
  counts,
  children,
}: {
  value: PendingFilterKey;
  onChange: (value: PendingFilterKey) => void;
  counts: Record<PendingFilterKey, number>;
  children: ReactNode;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(next as PendingFilterKey)}
    >
      <TabsList>
        {PENDING_FILTERS.map((option) => (
          <TabsTrigger key={option.key} value={option.key} title={option.hint}>
            {option.label}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {counts[option.key]}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value}>{children}</TabsContent>
    </Tabs>
  );
}

/**
 * Одна строка предложенного сервера. Если это шлюз (role === "gateway"),
 * строка раскрывается — показывает, что к нему подключено, как уже сделано
 * для шлюза в MachineTable: лаунчер разворачивает содержимое
 * `.agents/metamcp.mcp.json` той же машины (дети редактируемые, с отступом
 * `pl-6`), запись с namespace-URL разворачивает реальные серверы MetaMCP (без
 * действий, следующий уровень `pl-12`).
 */
function PendingRow({
  item,
  data,
  treeEnabled,
  rowExpanded,
  onToggleRow,
  confirming,
  onConfirm,
  onAdopt,
  onAdoptLocal,
  onIgnore,
  onPurge,
  onToggleEnabled,
  disabled,
}: {
  item: Pending;
  data: Overview;
  treeEnabled: boolean;
  rowExpanded: boolean;
  onToggleRow: () => void;
  confirming: string | null;
  onConfirm: (key: string | null) => void;
  onAdopt: (name: string) => void;
  onAdoptLocal: (name: string) => void;
  onIgnore: (name: string) => void;
  onPurge: (name: string) => void;
  onToggleEnabled: (item: Pending, enabled: boolean) => void;
  disabled: boolean;
}): ReactNode[] {
  const namespace = item.role === "gateway" ? namespaceOf(item.spec) : null;
  const isLauncher =
    item.role === "gateway" && GATEWAY_LAUNCHER.test(item.spec.command ?? "");
  const expandable = treeEnabled && (namespace !== null || isLauncher);
  const enabledState = occurrencesEnabledState(item);
  const isDisabled = enabledState === "disabled";
  const togglable = hasTogglable(item);
  // Хотя бы одна occurrence не выключена — предлагаем выключить всё, иначе включить.
  const anyEnabled = item.occurrences.some(
    (occurrence) => !occurrence.disabled,
  );
  const toggleLabel = anyEnabled ? t("Выключить") : t("Включить");

  const nameBlock = (
    <div className="min-w-0">
      <div
        className={cn(
          "flex items-center gap-1.5 text-sm font-medium",
          isDisabled ? "text-muted-foreground" : undefined,
        )}
      >
        <EnabledDot
          state={enabledState}
          note={
            togglable
              ? undefined
              : t("формат конфига не умеет выключать сервер, его можно только удалить")
          }
        />
        {item.name}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">
        {describe(item.spec)}
      </div>
    </div>
  );

  const rows: ReactNode[] = [
    <TableRow key={item.name} className="group" title={pendingTitle(item)}>
      <TableCell className="px-3 py-2.5">
        {/* У раскрываемой строки кликается всё имя целиком, а не только шеврон. */}
        {expandable ? (
          <button
            type="button"
            onClick={onToggleRow}
            aria-expanded={rowExpanded}
            className="flex w-full cursor-pointer items-start gap-1.5 text-left"
          >
            <Icon
              name={rowExpanded ? "ChevronDown" : "ChevronRight"}
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
            {nameBlock}
          </button>
        ) : (
          <div className="flex items-start gap-1.5 pl-[1.125rem]">
            {nameBlock}
          </div>
        )}
      </TableCell>
      <TableCell
        className="px-3 py-2.5 text-xs text-muted-foreground"
        title={pendingWhereTitle(item)}
      >
        <span className="block truncate">{pendingWhere(item)}</span>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <span className="flex flex-wrap items-center gap-1">
          <Badge
            variant="outline"
            className="whitespace-nowrap px-1.5 py-0 text-[11px] font-medium"
          >
            {item.spec.transport}
          </Badge>
          {item.role === "gateway" ? (
            <Badge
              variant="outline"
              className="whitespace-nowrap px-1.5 py-0 text-[11px] font-medium"
            >
              {t("шлюз")}
            </Badge>
          ) : null}
          {item.role === "vendor" ? (
            <Badge
              variant="outline"
              className="whitespace-nowrap px-1.5 py-0 text-[11px] font-medium"
              title={t("ставится самим CLI, на другие машины не переносится")}
            >
              {t("от CLI")}
            </Badge>
          ) : null}
          {/* выключенность и так видна серой точкой и приглушённым именем —
              метку добавляем только когда другой роли у строки нет */}
          {isDisabled && item.role === "server" ? (
            <Badge
              variant="outline"
              className="whitespace-nowrap px-1.5 py-0 text-[11px] font-medium"
            >
              {t("выключен")}
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="px-2 py-2.5 text-right">
        <span className="inline-flex items-center justify-end gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          {item.localOnly ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onAdopt(item.name)}
            >
              {t("Принять")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onAdoptLocal(item.name)}
          >
            {t("Локально")}
          </Button>
          {togglable ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onToggleEnabled(item, !anyEnabled)}
            >
              {toggleLabel}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onIgnore(item.name)}
          >
            {t("Скрыть")}
          </Button>
          {confirming === item.name ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                onConfirm(null);
                onPurge(item.name);
              }}
            >
              {t("Точно?")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onConfirm(item.name)}
            >
              {t("Удалить")}
            </Button>
          )}
        </span>
      </TableCell>
    </TableRow>,
  ];

  if (!expandable || !rowExpanded) return rows;

  if (namespace !== null) {
    const remote =
      data.metamcp.find((entry) => entry.namespace === namespace) ?? null;
    if (remote === null) {
      // Нет данных с MetaMCP — ничего не показываем, чем гадать.
    } else if (remote.error !== null) {
      rows.push(
        <TableRow key={`${item.name}-error`} className="hover:bg-transparent">
          <TableCell className="py-1.5 pl-6 pr-3 text-xs text-destructive">
            {t("ошибка")}: {remote.error}
          </TableCell>
          <TableCell className="py-1.5" />
          <TableCell className="py-1.5" />
          <TableCell className="py-1.5" />
        </TableRow>,
      );
    } else {
      for (const inner of remote.servers) {
        rows.push(
          <TableRow
            key={`${item.name}-${inner.name}`}
            className="hover:bg-transparent"
            title={t("управляется в самом MetaMCP")}
          >
            <TableCell className="py-1 pl-6 pr-3 text-xs text-muted-foreground">
              {inner.name}
            </TableCell>
            <TableCell className="py-1" />
            <TableCell className="py-1 px-3 text-right text-xs text-muted-foreground">
              {inner.tools}
            </TableCell>
            <TableCell className="py-1" />
          </TableRow>,
        );
      }
    }
    return rows;
  }

  // Лаунчер шлюза может стоять на нескольких машинах, и состав за ним у каждой
  // свой — показываем детей каждой машины, при нескольких подписываем чью.
  const gatewayHosts = [
    ...new Set(item.occurrences.map((occurrence) => occurrence.hostId)),
  ];
  const multiHost = gatewayHosts.length > 1;
  for (const gatewayHostId of gatewayHosts) {
    const children = metamcpStdioServers(data, gatewayHostId);
    if (children.length === 0) continue;
    if (multiHost) {
      rows.push(
        <TableRow
          key={`${item.name}-host-${gatewayHostId}`}
          className="border-0 hover:bg-transparent"
        >
          <TableCell className="py-0.5 pl-6 pr-3">
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Icon
                name={
                  data.hosts.find((host) => host.hostId === gatewayHostId)?.platform === "linux"
                    ? "Cloud"
                    : "Laptop"
                }
                className="size-3"
              />
              {data.hosts.find((host) => host.hostId === gatewayHostId)?.name ?? gatewayHostId}
            </span>
          </TableCell>
          <TableCell className="py-0.5" />
          <TableCell className="py-0.5" />
          <TableCell className="py-0.5" />
        </TableRow>,
      );
    }
    for (const server of children) {
      const innerNamespace = namespaceOf(server);
      const remote =
        innerNamespace === null
          ? null
          : (data.metamcp.find((entry) => entry.namespace === innerNamespace) ??
            null);
      const confirmKey = `${item.name}::${gatewayHostId}::${server.name}`;
      rows.push(
        <TableRow key={confirmKey} className="group border-0 hover:bg-transparent">
          <TableCell className={cn("py-0 pr-3", multiHost ? "pl-8" : "pl-6")}>
            <span className="flex items-center gap-1.5 border-l border-border/60 py-1.5 pl-3 text-xs text-muted-foreground">
              <EnabledDot state={server.disabled === true ? "disabled" : "enabled"} />
              <span className="truncate text-foreground/80">{server.name}</span>
              {remote ? (
                <span className="truncate">→ MetaMCP /{remote.namespace}</span>
              ) : null}
            </span>
          </TableCell>
          <TableCell className="py-0.5" />
          <TableCell className="py-0.5 px-3">
            <Badge
              variant="outline"
              className="whitespace-nowrap px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
            >
              {server.transport}
            </Badge>
          </TableCell>
          <TableCell className="py-0 px-2 text-right">
            {/* Кнопки внутри дерева компактнее обычных: иначе строка ветки
                вырастает вдвое и ломает ощущение вложенного списка. */}
            <span className="inline-flex items-center justify-end gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
              <Button
                size="sm"
                variant="ghost"
                className={TREE_ACTION}
                disabled={disabled}
                onClick={() => onIgnore(server.name)}
              >
                {t("Скрыть")}
              </Button>
              {confirming === confirmKey ? (
                <Button
                  size="sm"
                  variant="destructive"
                  className={TREE_ACTION}
                  disabled={disabled}
                  onClick={() => {
                    onConfirm(null);
                    onPurge(server.name);
                  }}
                >
                  {t("Точно?")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className={TREE_ACTION}
                  disabled={disabled}
                  onClick={() => onConfirm(confirmKey)}
                >
                  {t("Удалить")}
                </Button>
              )}
            </span>
          </TableCell>
        </TableRow>,
      );
      if (remote !== null && remote.error !== null) {
        rows.push(
          <TableRow
            key={`${confirmKey}-error`}
            className="hover:bg-transparent"
          >
            <TableCell
              className={cn(
                "py-1 pr-3 text-xs text-destructive",
                multiHost ? "pl-16" : "pl-12",
              )}
            >
              {t("ошибка")}: {remote.error}
            </TableCell>
            <TableCell className="py-1" />
            <TableCell className="py-1" />
            <TableCell className="py-1" />
          </TableRow>,
        );
      } else if (remote !== null) {
        for (const inner of remote.servers) {
          rows.push(
            <TableRow
              key={`${confirmKey}-${inner.name}`}
              className="hover:bg-transparent"
              title={t("управляется в самом MetaMCP")}
            >
              <TableCell className="py-0 pl-10 pr-3">
                <span className="flex items-center gap-1.5 border-l border-border/60 py-1.5 pl-3 text-xs text-muted-foreground">
                  <Icon name="Plug02" className="size-3 shrink-0 opacity-60" />
                  <span className="truncate">{inner.name}</span>
                </span>
              </TableCell>
              <TableCell className="py-0.5" />
              <TableCell className="py-0.5 px-3 text-right text-xs text-muted-foreground">
                {inner.tools}
              </TableCell>
              <TableCell className="py-0.5" />
            </TableRow>,
          );
        }
      }
    }
  }

  return rows;
}

/**
 * Таблица предложенных серверов с действиями по наведению: принять, оставить
 * локально, скрыть, удалить (с подтверждением вторым нажатием). Показывает
 * срез, выбранный панелью фильтров. Записи-шлюзы раскрываются деревом — см.
 * PendingRow; в срезе «За шлюзом MetaMCP» дерево не включается, список
 * остаётся плоским.
 */
function PendingTable({
  items,
  data,
  treeEnabled,
  onAdopt,
  onAdoptLocal,
  onIgnore,
  onPurge,
  onToggleEnabled,
  disabled,
}: {
  items: Pending[];
  data: Overview;
  treeEnabled: boolean;
  onAdopt: (name: string) => void;
  onAdoptLocal: (name: string) => void;
  onIgnore: (name: string) => void;
  onPurge: (name: string) => void;
  onToggleEnabled: (item: Pending, enabled: boolean) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleRow = (name: string) =>
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const visible = expanded ? items : items.slice(0, PENDING_LIMIT);
  const hidden = items.length - PENDING_LIMIT;

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Пусто — в этом срезе новых серверов нет.")}
      </p>
    );
  }

  return (
    <>
      <CollectionFrame>
        <Table className="min-w-[36rem]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-3 text-xs font-medium text-muted-foreground">
                {t("Сервер")}
              </TableHead>
              <TableHead className="w-[24%] px-3 text-xs font-medium text-muted-foreground">
                {t("Где найден")}
              </TableHead>
              <TableHead className="w-[14%] px-3 text-xs font-medium text-muted-foreground">
                {t("Тип")}
              </TableHead>
              <TableHead className="w-[26%] px-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((item) => (
              <PendingRow
                key={item.name}
                item={item}
                data={data}
                treeEnabled={treeEnabled}
                rowExpanded={expandedRows.has(item.name)}
                onToggleRow={() => toggleRow(item.name)}
                confirming={confirming}
                onConfirm={setConfirming}
                onAdopt={onAdopt}
                onAdoptLocal={onAdoptLocal}
                onIgnore={onIgnore}
                onPurge={onPurge}
                onToggleEnabled={onToggleEnabled}
                disabled={disabled}
              />
            ))}
          </TableBody>
        </Table>
      </CollectionFrame>
      {items.length > PENDING_LIMIT ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1.5 h-auto px-1.5 py-0.5 text-xs text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("свернуть") : tp("ещё {0}", hidden)}
        </Button>
      ) : null}
    </>
  );
}

/**
 * Строки одного CLI-агента в таблице CLI машины. Шлюз (metamcp-stdio)
 * разворачивается своим деревом MetaMCP без переключателей — выключение не
 * часть его формата. Агенты, чей формат умеет выключение (`supportsDisable`:
 * Codex, OpenCode, MimoCode, Grok), тоже разворачиваются — списком своих
 * серверов с точкой состояния и действием «Включить»/«Выключить».
 */
/**
 * Официальная эмблема CLI: берём запись провайдера BB как её читают штатные
 * пикеры, поэтому логотип и подсветка совпадают с остальным приложением.
 * Для CLI без провайдера (Qwen, Kimi, Grok, MimoCode) показываем нейтральный значок.
 */
function CliIcon({ providerId }: { providerId: string | null }) {
  const providers = useProviders();
  if (providerId === null) {
    return (
      <Icon
        name="ComputerTerminal01"
        className="size-4 shrink-0 text-muted-foreground"
      />
    );
  }
  const provider = providers.providers.find((item) => item.id === providerId);
  return (
    <ProviderIcon
      providerKind="agent"
      provider={provider ?? { id: providerId }}
      className="size-4 shrink-0"
      aria-hidden
    />
  );
}

function AgentRows({
  agent,
  data,
  expanded,
  onToggle,
  busy,
  onToggleServer,
}: {
  agent: ManagedAgent;
  data: Overview;
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  onToggleServer: (server: McpServer) => void;
}) {
  const disableAware = !agent.gateway && supportsDisable(agent.kind);
  const expandable =
    (agent.gateway || disableAware) && agent.servers.length > 0;
  const rows: ReactNode[] = [
    <TableRow key={agent.kind}>
      <TableCell className="px-3 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-sm">
          {expandable ? (
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center gap-1.5 hover:text-foreground"
              aria-expanded={expanded}
            >
              <Icon
                name={expanded ? "ChevronDown" : "ChevronRight"}
                className="size-3.5 text-muted-foreground"
              />
              <CliIcon providerId={agent.providerId} />
              {agent.label}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CliIcon providerId={agent.providerId} />
              {agent.label}
            </span>
          )}
          {agent.gateway ? (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {t("шлюз")}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        {agent.configPath === null ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <TruncatedPath path={agent.configPath} />
        )}
        {agent.configExists && agent.warning === null ? null : (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {agent.configExists ? "" : t("нет файла")}
            {agent.configExists || agent.warning === null ? "" : " · "}
            {agent.warning ?? ""}
          </div>
        )}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right text-sm">
        {agent.servers.length}
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <span className="flex flex-wrap gap-1">
          {agent.bridged ? null : (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-500"
            >
              {t("не проброшен")}
            </Badge>
          )}
          {agent.writable ? null : (
            <Badge variant="outline">{t("только чтение")}</Badge>
          )}
          {agent.manageable || agent.gateway ? null : (
            <Badge
              variant="outline"
              title={t("Путь конфига не подтверждён — плагин не создаёт файл сам")}
            >
              {t("не пишем")}
            </Badge>
          )}
        </span>
      </TableCell>
    </TableRow>,
  ];

  if (expandable && expanded && agent.gateway) {
    // Шлюз: дети — записи .agents/metamcp.mcp.json, без переключателей (формат их не умеет).
    // Следующий уровень — реальные серверы за namespace MetaMCP, тоже без действий.
    for (const server of agent.servers) {
      const namespace = namespaceOf(server);
      const remote =
        namespace === null
          ? null
          : (data.metamcp.find((item) => item.namespace === namespace) ?? null);
      rows.push(
        <TableRow
          key={`${agent.kind}-${server.name}`}
          className="hover:bg-transparent"
        >
          <TableCell className="py-1.5 pl-6 pr-3 text-xs text-muted-foreground">
            {server.name}
            {remote ? ` → MetaMCP /${remote.namespace}` : ""}
          </TableCell>
          <TableCell className="py-1.5" />
          <TableCell className="py-1.5" />
          <TableCell className="py-1.5 px-3 text-xs">
            {remote && remote.error !== null ? (
              <span className="text-destructive">{remote.error}</span>
            ) : null}
          </TableCell>
        </TableRow>,
      );
      if (remote && remote.error === null) {
        for (const inner of remote.servers) {
          rows.push(
            <TableRow
              key={`${agent.kind}-${server.name}-${inner.name}`}
              className="hover:bg-transparent"
              title={t("управляется в самом MetaMCP")}
            >
              <TableCell className="py-0 pl-10 pr-3">
                <span className="flex items-center gap-1.5 border-l border-border/60 py-1.5 pl-3 text-xs text-muted-foreground">
                  <Icon name="Plug02" className="size-3 shrink-0 opacity-60" />
                  <span className="truncate">{inner.name}</span>
                </span>
              </TableCell>
              <TableCell className="py-0.5" />
              <TableCell className="py-0.5 px-3 text-right text-xs text-muted-foreground">
                {inner.tools}
              </TableCell>
              <TableCell className="py-0.5" />
            </TableRow>,
          );
        }
      }
    }
  } else if (expandable && expanded && disableAware) {
    // Формат этого агента умеет выключение — показываем точку состояния и переключатель.
    for (const server of agent.servers) {
      const isDisabled = server.disabled === true;
      rows.push(
        <TableRow
          key={`${agent.kind}-${server.name}`}
          className="group hover:bg-transparent"
        >
          <TableCell className="py-1.5 pl-6 pr-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <EnabledDot state={isDisabled ? "disabled" : "enabled"} />
              {server.name}
            </span>
          </TableCell>
          <TableCell className="py-1.5" />
          <TableCell className="py-1.5" />
          <TableCell className="py-1.5 px-3 text-right">
            <span className={ROW_ACTIONS}>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onToggleServer(server)}
              >
                {isDisabled ? t("Включить") : t("Выключить")}
              </Button>
            </span>
          </TableCell>
        </TableRow>,
      );
    }
  }

  return rows;
}

function MachineTable({
  machine,
  data,
  busy,
  onToggleServer,
}: {
  machine: HostView;
  data: Overview;
  busy: boolean;
  onToggleServer: (hostId: string, server: McpServer) => void;
}) {
  const [expandedGateways, setExpandedGateways] = useState<Set<string>>(
    new Set(),
  );
  const toggleGateway = (kind: string) =>
    setExpandedGateways((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const installedAgents = machine.agents.filter((agent) => agent.installed);
  if (installedAgents.length === 0 && machine.otherClis.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("На этой машине не обнаружено ни одного CLI.")}
      </p>
    );
  }

  return (
    <CollectionFrame>
      <Table className="min-w-[32rem]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-3 text-xs font-medium text-muted-foreground">
              CLI
            </TableHead>
            <TableHead className="px-3 text-xs font-medium text-muted-foreground">
              {t("Конфиг")}
            </TableHead>
            <TableHead className="px-3 text-right text-xs font-medium text-muted-foreground">
              {t("Серверов")}
            </TableHead>
            <TableHead className="px-3 text-xs font-medium text-muted-foreground">
              {t("Состояние")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {installedAgents.map((agent) => (
            <AgentRows
              key={agent.kind}
              agent={agent}
              data={data}
              expanded={expandedGateways.has(agent.kind)}
              onToggle={() => toggleGateway(agent.kind)}
              busy={busy}
              onToggleServer={(server) =>
                onToggleServer(machine.hostId, server)
              }
            />
          ))}
          {machine.otherClis.map((cli) => (
            <TableRow key={cli.bin} className="text-muted-foreground">
              <TableCell className="px-3 py-2.5 text-sm">{cli.bin}</TableCell>
              <TableCell className="px-3 py-2.5">
                <TruncatedPath path={cli.path} />
              </TableCell>
              <TableCell className="px-3 py-2.5 text-right text-xs">
                —
              </TableCell>
              <TableCell className="px-3 py-2.5">
                <Badge variant="outline">{t("адаптера нет")}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CollectionFrame>
  );
}

interface GatewayHostChoice {
  hostId: string;
  hostName: string;
  existing: string[];
}

/** Разбор вставленного JSON для предпросмотра; сервер всё равно валидирует сам. */
function parseGatewayPreview(text: string): {
  ok: boolean;
  message: string | null;
  servers: Array<{ name: string; detail: string }>;
} {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: null, servers: [] };
  let document: unknown;
  try {
    document = JSON.parse(trimmed);
  } catch (cause) {
    return {
      ok: false,
      message: tp("JSON не разобран: {0}", cause instanceof Error ? cause.message : String(cause)),
      servers: [],
    };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, message: t("Ожидается JSON-объект"), servers: [] };
  }
  const doc = document as Record<string, unknown>;
  const inner = doc.mcpServers;
  const bucket =
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : doc;
  const servers: Array<{ name: string; detail: string }> = [];
  for (const [name, raw] of Object.entries(bucket)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      servers.push({ name, detail: t("непонятная запись") });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const command = typeof entry.command === "string" ? entry.command : null;
    const url = typeof entry.url === "string" ? entry.url : null;
    const args = Array.isArray(entry.args) ? entry.args.join(" ") : "";
    if (command !== null) {
      servers.push({ name, detail: args === "" ? command : `${command} ${args}` });
    } else if (url !== null) {
      servers.push({ name, detail: url });
    } else {
      servers.push({ name, detail: t("нет ни command, ни url") });
    }
  }
  return { ok: servers.length > 0, message: null, servers };
}

/**
 * Диалог «За шлюз…»: пользователь вставляет JSON вида {"mcpServers": {...}},
 * плагин дописывает этих детей в ~/.agents/metamcp.mcp.json выбранной машины.
 */
function GatewayAddDialog({
  open,
  onOpenChange,
  hosts,
  defaultHostId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: GatewayHostChoice[];
  defaultHostId: string | null;
  onDone: (result: { added: number; replaced: string[]; errors: string[] }) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [hostId, setHostId] = useState<string>(
    defaultHostId ?? hosts[0]?.hostId ?? "",
  );
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => {
    if (open && defaultHostId !== null) setHostId(defaultHostId);
  }, [open, defaultHostId]);
  const target = hosts.find((item) => item.hostId === hostId) ?? hosts[0] ?? null;
  const preview = parseGatewayPreview(text);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Добавить серверы за шлюз MetaMCP")}</DialogTitle>
            <DialogDescription>
              {t("Вставь JSON с картой mcpServers — записи будут дописаны в ~/.agents/metamcp.mcp.json выбранной машины (с бэкапом). Новые сессии CLI подхватят их автоматически.")}
            </DialogDescription>
        </DialogHeader>
        <label className="block text-xs font-medium text-muted-foreground">
          {t("Машина")}
        </label>
        <div
          role="group"
          aria-label={t("Машина")}
          className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-background p-0.5"
        >
          {hosts.map((item) => (
            <Button
              key={item.hostId}
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={item.hostId === hostId}
              className={cn(
                "h-7 shrink-0 rounded-[5px] px-3 text-xs",
                item.hostId === hostId
                  ? "bg-secondary font-medium text-secondary-foreground hover:bg-secondary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              disabled={submitting}
              onClick={() => setHostId(item.hostId)}
            >
              {item.hostName}
            </Button>
          ))}
        </div>
        <label className="block text-xs font-medium text-muted-foreground">
          {t("JSON со серверами")}
        </label>
        <textarea
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          placeholder={`{\n  "mcpServers": {\n    "${t("имя-сервера")}": {\n      "command": "node",\n      "args": ["${t("/путь/к/server.js")}"]\n    }\n  }\n}`}
          className="h-44 w-full resize-y rounded-md border border-border bg-transparent p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {preview.message === null ? null : (
          <p className="text-xs text-destructive">{preview.message}</p>
        )}
        {preview.servers.length > 0 && target !== null ? (
          <div className="rounded-md border border-border px-3 py-2">
            <p className="text-xs text-muted-foreground">
              {t("Будет добавлено в шлюз")} «{target.hostName}»:
            </p>
            <ul className="mt-1 space-y-0.5">
              {preview.servers.map((server) => {
                const replacing = target.existing.includes(server.name);
                const broken = server.detail.includes(t("нет ни command"));
                return (
                  <li
                    key={server.name}
                    className="flex items-baseline gap-2 text-xs"
                  >
                    <span className="font-medium">{server.name}</span>
                    <span className="truncate text-muted-foreground">
                      {server.detail}
                    </span>
                    {replacing ? (
                      <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                        {t("заменит существующий")}
                      </Badge>
                    ) : null}
                    {broken ? (
                      <Badge
                        variant="outline"
                        className="shrink-0 px-1 py-0 text-[10px] text-destructive"
                      >
                        {t("ошибка")}
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {submitError === null ? null : (
          <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
            {submitError}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t("Отмена")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || !preview.ok || target === null}
            onClick={() => {
              if (target === null) return;
              setSubmitting(true);
              setSubmitError(null);
              rpc
                .call("gateway_add", { hostId: target.hostId, text })
                .then((result) => {
                  onDone(result);
                  setText("");
                  onOpenChange(false);
                })
                .catch((cause: unknown) => {
                  setSubmitError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                })
                .finally(() => setSubmitting(false));
            }}
          >
            {submitting ? t("Добавляю…") : t("Добавить")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Вкладка «Плагины» (Плагины CLI-агентов)

function cliAgentProviderId(id: string): string | null {
  if (id === "claude-code" || id === "claude") return "claude-code";
  if (id === "opencode" || id === "zai-coding-plan" || id === "zai" || id === "deepseek") return "acp-opencode";
  if (id === "codex" || id === "openai") return "codex";
  if (id === "cursor") return "acp-cursor";
  if (id === "antigravity" || id === "agy" || id === "router9" || id === "google") return "acp-antigravity";
  return null;
}

function pluginScopeLabel(scope: CliPluginItem["scope"]): string {
  switch (scope) {
    case "user":
      return t("пользователь");
    case "project":
      return t("проект");
    case "bundled":
      return t("встроенный");
    case "npm":
      return "npm";
    case "local":
      return t("локальный");
    default:
      return scope ?? "—";
  }
}

function pluginVersionLabel(version: string | null | undefined): string {
  if (!version) return t("установлен");
  if (version === "latest") return "latest";
  if (/^v/i.test(version) || !/^\d/.test(version)) return version;
  return `v${version}`;
}

function PluginsTabContent({
  data,
  selected,
}: {
  data: Overview;
  selected: string | null;
}) {
  const [agentFilter, setAgentFilter] = useState<"all" | "claude-code" | "opencode" | "codex">("all");

  const plugins = (data.plugins as unknown as CliPluginItem[]) ?? [];
  const filtered = useMemo(() => {
    if (agentFilter === "all") return plugins;
    return plugins.filter((p) => p.agent === agentFilter);
  }, [plugins, agentFilter]);

  const counts = useMemo(
    () => ({
      all: plugins.length,
      claude: plugins.filter((p) => p.agent === "claude-code").length,
      opencode: plugins.filter((p) => p.agent === "opencode").length,
      codex: plugins.filter((p) => p.agent === "codex").length,
    }),
    [plugins],
  );

  const displayHosts = useMemo(() => {
    if (selected !== null) {
      return data.hosts.filter((h) => h.hostId === selected);
    }
    return data.hosts;
  }, [data.hosts, selected]);

  return (
    <div className="space-y-4">
      <Tabs value={agentFilter} onValueChange={(next) => setAgentFilter(next as typeof agentFilter)}>
        <TabsList className="flex h-auto min-h-9 flex-wrap">
          <TabsTrigger value="all">
            {t("Все")} <span className="ml-1.5 text-xs text-muted-foreground">{counts.all}</span>
          </TabsTrigger>
          <TabsTrigger value="claude-code" className="inline-flex items-center gap-1.5">
            <CliIcon providerId="claude-code" />
            Claude Code <span className="ml-1 text-xs text-muted-foreground">{counts.claude}</span>
          </TabsTrigger>
          <TabsTrigger value="opencode" className="inline-flex items-center gap-1.5">
            <CliIcon providerId="acp-opencode" />
            OpenCode <span className="ml-1 text-xs text-muted-foreground">{counts.opencode}</span>
          </TabsTrigger>
          <TabsTrigger value="codex" className="inline-flex items-center gap-1.5">
            <CliIcon providerId="codex" />
            Codex <span className="ml-1 text-xs text-muted-foreground">{counts.codex}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("В этом срезе плагинов не найдено.")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14 px-2 text-center text-xs font-medium text-muted-foreground">CLI</TableHead>
                <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Плагин")}</TableHead>
                <TableHead className="w-32 px-3 text-xs font-medium text-muted-foreground">{t("Область")}</TableHead>
                {displayHosts.map((h) => (
                  <TableHead key={h.hostId} className="px-3 text-center text-xs font-medium text-muted-foreground">
                    {h.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => (
                <TableRow key={`${p.agent}:${p.id}`} className="group">
                  <TableCell className="w-14 px-2 py-2.5 text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          role="img"
                          aria-label={p.agentLabel}
                          className="inline-flex items-center justify-center size-7 rounded-md bg-muted/40 border border-border/50"
                        >
                          <CliIcon providerId={cliAgentProviderId(p.agent)} />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p className="text-xs">{p.agentLabel}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="px-3 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{p.name}</span>
                      {p.marketplace && p.marketplace !== p.name ? (
                        <span className="font-mono text-xs text-muted-foreground" title={p.id}>
                          @{p.marketplace}
                        </span>
                      ) : p.scope === "local" ? (
                        <span className="font-mono text-xs text-muted-foreground truncate max-w-[280px]" title={p.id}>
                          {p.id}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2.5">
                    <Badge variant="outline" className="font-normal text-xs">
                      {pluginScopeLabel(p.scope)}
                    </Badge>
                  </TableCell>
                  {displayHosts.map((h) => {
                    const hp = p.hosts[h.hostId];
                    if (!hp || !hp.installed) {
                      return (
                        <TableCell key={h.hostId} className="px-3 py-2.5 text-center text-xs text-muted-foreground/30">
                          —
                        </TableCell>
                      );
                    }

                    return (
                      <TableCell key={h.hostId} className="px-3 py-2.5 text-center">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "font-normal text-xs",
                            hp.enabled && "bg-emerald-500/15 text-emerald-500 border-transparent",
                          )}
                          title={hp.installPath ?? undefined}
                        >
                          {hp.enabled
                            ? pluginVersionLabel(hp.version)
                            : `${t("выключен")}${hp.version ? ` · ${pluginVersionLabel(hp.version)}` : ""}`}
                        </Badge>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Вкладка «OpenCode»

function OpenCodeTabContent({
  data,
  selected,
  busy,
  onSync,
  onRemoveProvider,
  onSetDefaultModel,
}: {
  data: Overview;
  selected: string | null;
  busy: boolean;
  onSync: (dryRun?: boolean) => void;
  onRemoveProvider: (hostId: string, providerId: string) => void;
  onSetDefaultModel: (modelId: string) => void;
}) {
  const [providerFilter, setProviderFilter] = useState<"all" | "canonical" | "stale">("all");

  const opencode = data.opencode;

  const displayHosts = useMemo(() => {
    if (!opencode) return [];
    if (selected !== null) {
      return opencode.hosts.filter((h) => h.hostId === selected);
    }
    return opencode.hosts;
  }, [opencode, selected]);

  const filteredProviders = useMemo(() => {
    if (!opencode) return [];
    switch (providerFilter) {
      case "canonical":
        return opencode.providers.filter((p) => p.isCanonical);
      case "stale":
        return opencode.providers.filter((p) => p.isStale);
      default:
        return opencode.providers;
    }
  }, [opencode, providerFilter]);

  const providerCounts = useMemo(() => {
    if (!opencode) return { all: 0, canonical: 0, stale: 0 };
    return {
      all: opencode.providers.length,
      canonical: opencode.providers.filter((p) => p.isCanonical).length,
      stale: opencode.providers.filter((p) => p.isStale).length,
    };
  }, [opencode]);

  if (!opencode) {
    return <p className="text-sm text-muted-foreground">{t("Загрузка данных OpenCode…")}</p>;
  }

  return (
    <div className="space-y-5">
      {/* Любимая / предустановленная модель */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium flex items-center gap-2">
              <Icon name="AiBrain01" className="size-4 text-emerald-500" />
              {t("Любимая модель")}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("Модель, которая автоматически выбирается при создании нового чата в BB и является основной в CLI OpenCode.")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("Сейчас в BB:")}</span>
            <Badge variant="secondary" className="font-mono text-xs bg-emerald-500/15 text-emerald-500 border-transparent">
              {opencode.bbPreselectedModel ?? t("не задана")}
            </Badge>
          </div>
        </div>

        {/* Список подключённых моделей */}
        <div className="pt-1">
          <CollectionFrame>
            <Table className="min-w-[32rem]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Модель")}</TableHead>
                  <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Провайдер")}</TableHead>
                  <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Статус")}</TableHead>
                  <TableHead className="w-36 px-3 text-right text-xs font-medium text-muted-foreground" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {opencode.availableModels.map((m) => {
                  const isPreselected = m.id === opencode.bbPreselectedModel;
                  return (
                    <TableRow key={m.id} className={cn("group", isPreselected && "bg-muted/40")}>
                      <TableCell className="px-3 py-2.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">{m.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{m.id}</span>
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-2.5 text-xs">
                        <div className="inline-flex items-center gap-2">
                          <div className="inline-flex items-center justify-center size-5 rounded bg-muted/40 border border-border/50 shrink-0">
                            <CliIcon providerId={cliAgentProviderId(m.providerId)} />
                          </div>
                          <span className="text-muted-foreground">{m.providerName}</span>
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {isPreselected ? (
                            <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-500 border-transparent text-xs font-normal">
                              {t("⭐ Предустановлена в BB")}
                            </Badge>
                          ) : null}
                          {m.isDefaultInOpenCode ? (
                            <Badge variant="outline" className="border-border text-xs font-normal">
                              {t("⚡ Основная в OpenCode")}
                            </Badge>
                          ) : null}
                          {m.isSmallInOpenCode ? (
                            <Badge variant="outline" className="border-border text-xs font-normal text-muted-foreground">
                              {t("быстрая")}
                            </Badge>
                          ) : null}
                          {!isPreselected && !m.isDefaultInOpenCode && !m.isSmallInOpenCode ? (
                            <span className="text-xs text-muted-foreground">{t("подключена")}</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-2.5 text-right">
                        {isPreselected ? (
                          <span className="text-xs text-emerald-500 font-medium mr-2">{t("Активна")}</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
                            disabled={busy}
                            onClick={() => onSetDefaultModel(m.id)}
                          >
                            {t("Сделать любимой")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CollectionFrame>
        </div>
      </div>

      {/* Карточки состояния по машинам */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {displayHosts.map((h) => (
          <div key={h.hostId} className="rounded-lg border border-border bg-card p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{h.hostName}</span>
              <Badge
                variant={h.installed ? "secondary" : "outline"}
                className={cn("font-normal", h.installed && "bg-emerald-500/15 text-emerald-500 border-transparent")}
              >
                {h.installed ? t("OpenCode готов") : t("Не установлен")}
              </Badge>
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>{t("Конфиг:")}</span>
                <span className="font-mono text-[11px] truncate max-w-[180px]" title={h.configPath ?? ""}>
                  {h.configPath ? h.configPath.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~") : t("нет")}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("Основная модель:")}</span>
                <span className="font-mono text-[11px] text-foreground font-medium truncate max-w-[180px]">
                  {h.model ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("Быстрая модель:")}</span>
                <span className="font-mono text-[11px] text-foreground truncate max-w-[180px]">
                  {h.smallModel ?? "—"}
                </span>
              </div>
            </div>
            <div className="pt-1 flex flex-wrap gap-1">
              {h.enabledProviders.map((ep) => (
                <Badge key={ep} variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                  {ep}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Предупреждение о расхождениях */}
      {opencode.drift.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-amber-500">
              {t("Обнаружены расхождения")} ({opencode.drift.length}):
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => onSync(false)}
            >
              {t("Исправить всё с эталона")}
            </Button>
          </div>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {opencode.drift.map((d, i) => {
              const hName = opencode.hosts.find((x) => x.hostId === d.hostId)?.hostName ?? d.hostId;
              return (
                <li key={i}>
                  <b>{hName}</b>: {d.description}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Tabs value={providerFilter} onValueChange={(next) => setProviderFilter(next as typeof providerFilter)}>
        <TabsList className="flex h-auto min-h-9 flex-wrap">
            <TabsTrigger value="all">
              {t("Все провайдеры")} <span className="ml-1.5 text-xs text-muted-foreground">{providerCounts.all}</span>
            </TabsTrigger>
            <TabsTrigger value="canonical">
              {t("Канонические")} <span className="ml-1.5 text-xs text-muted-foreground">{providerCounts.canonical}</span>
            </TabsTrigger>
            <TabsTrigger value="stale">
              {t("Устаревшие")} <span className="ml-1.5 text-xs text-muted-foreground">{providerCounts.stale}</span>
            </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Матрица провайдеров */}
      <CollectionFrame>
        <Table className="min-w-[40rem]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Провайдер")}</TableHead>
              <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Параметры")}</TableHead>
              <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Модели")}</TableHead>
              {displayHosts.map((h) => (
                <TableHead key={h.hostId} className="px-3 text-xs font-medium text-muted-foreground">
                  {h.hostName}
                </TableHead>
              ))}
              <TableHead className="w-16 px-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredProviders.map((p) => (
              <TableRow key={p.id} className="group">
                <TableCell className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center justify-center size-7 rounded-md bg-muted/40 border border-border/50 shrink-0">
                      <CliIcon providerId={cliAgentProviderId(p.id)} />
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{p.name}</span>
                        {p.isCanonical ? (
                          <Badge variant="outline" className="border-emerald-500/40 text-emerald-500 text-[10px] px-1 py-0 font-normal">
                            {t("канон")}
                          </Badge>
                        ) : p.isStale ? (
                          <Badge variant="outline" className="border-amber-500/40 text-amber-500 text-[10px] px-1 py-0 font-normal">
                            {t("устаревший")}
                          </Badge>
                        ) : null}
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="px-3 py-2.5 text-xs text-muted-foreground">
                  {p.npm ? <span className="block font-mono">{p.npm}</span> : null}
                  {p.baseURL ? <span className="block truncate max-w-[200px]" title={p.baseURL}>{p.baseURL}</span> : null}
                  {!p.npm && !p.baseURL ? <span>{t("встроенный")}</span> : null}
                </TableCell>
                <TableCell className="px-3 py-2.5">
                  {(() => {
                    const allModels = new Set<string>();
                    for (const h of Object.values(p.hosts)) {
                      for (const m of h.models) allModels.add(m);
                    }
                    const mList = [...allModels];
                    if (mList.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                    return (
                      <div className="flex flex-wrap gap-1">
                        {mList.slice(0, 2).map((m) => (
                          <Badge key={m} variant="secondary" className="px-1.5 py-0 text-[10px] font-mono font-normal">
                            {m.replace(/^ag\//, "")}
                          </Badge>
                        ))}
                        {mList.length > 2 ? (
                          <span className="text-[10px] text-muted-foreground">+{mList.length - 2}</span>
                        ) : null}
                      </div>
                    );
                  })()}
                </TableCell>
                {displayHosts.map((h) => {
                  const hp = p.hosts[h.hostId];
                  if (!hp || (!hp.configured && !hp.enabled)) {
                    return (
                      <TableCell key={h.hostId} className="px-3 py-2.5 text-xs text-muted-foreground">
                        —
                      </TableCell>
                    );
                  }
                  if (hp.enabled) {
                    return (
                      <TableCell key={h.hostId} className="px-3 py-2.5">
                        <Badge
                          variant="secondary"
                          className="bg-emerald-500/15 text-emerald-500 border-transparent font-normal inline-flex items-center gap-1.5"
                        >
                          <span className="size-1.5 rounded-full bg-emerald-500" />
                          {t("Включён")}
                        </Badge>
                      </TableCell>
                    );
                  }
                  return (
                    <TableCell key={h.hostId} className="px-3 py-2.5">
                      <Badge variant="secondary" className="font-normal inline-flex items-center gap-1.5">
                        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
                        {t("Настроен")}
                      </Badge>
                    </TableCell>
                  );
                })}
                <TableCell className="px-2 py-2.5 text-right">
                  <span className="inline-flex items-center justify-end gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    {p.isStale ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs"
                        disabled={busy}
                        onClick={() => {
                          for (const h of displayHosts) {
                            if (p.hosts[h.hostId]?.configured) {
                              onRemoveProvider(h.hostId, p.id);
                            }
                          }
                        }}
                      >
                        {t("Удалить")}
                      </Button>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollectionFrame>

      {/* Плагины OpenCode */}
      {(() => {
        const pluginsByHost = displayHosts.filter((h) => h.plugins.length > 0);
        if (pluginsByHost.length === 0) return null;
        return (
          <div className="space-y-2 pt-2">
            <h2 className="text-sm font-medium">{t("Плагины OpenCode в конфигурации")}</h2>
            <CollectionFrame>
              <Table className="min-w-[28rem]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Плагин")}</TableHead>
                    {displayHosts.map((h) => (
                      <TableHead key={h.hostId} className="px-3 text-xs font-medium text-muted-foreground">
                        {h.hostName}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const allPlugins = new Set<string>();
                    for (const h of displayHosts) {
                      for (const pl of h.plugins) allPlugins.add(pl);
                    }
                    return [...allPlugins].map((pl) => (
                      <TableRow key={pl}>
                        <TableCell className="px-3 py-2 text-xs font-mono font-medium">{pl}</TableCell>
                        {displayHosts.map((h) => (
                          <TableCell key={h.hostId} className="px-3 py-2">
                            {h.plugins.includes(pl) ? (
                              <Badge variant="secondary" className="font-normal text-xs">
                                {t("подключён")}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ));
                  })()}
                </TableBody>
              </Table>
            </CollectionFrame>
          </div>
        );
      })()}
    </div>
  );
}

function CatalogPage() {
  const { rpc, data, error, busy, act } = useOverview();
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingFilter, setPendingFilter] = useState<PendingFilterKey>("new");
  const [gatewayAddOpen, setGatewayAddOpen] = useState(false);
  const [toolTab, setToolTab] = useState<"mcp" | "skills" | "backups" | "plugins" | "opencode">("mcp");
  const [skillFilter, setSkillFilter] = useState<SkillFilterKey>("all");

  const syncOpenCode = useCallback((dryRun = false) =>
    act(async () => {
      const result = await rpc.call("opencode_sync", {
        sourceHostId: null,
        targetHostId: selected,
        syncProviders: true,
        syncModels: true,
        syncEnabled: true,
        dryRun,
      });
      setNotice(
        `OpenCode sync${dryRun ? " [dry-run]" : ""}: ${tp("синхронизировано машин {0}", result.synced)}` +
          (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
      );
      return result.overview;
    }), [act, rpc, selected]);

  const cleanOpenCode = useCallback((dryRun = false) =>
    act(async () => {
      const result = await rpc.call("opencode_clean", {
        hostId: selected,
        dryRun,
      });
      setNotice(
        `OpenCode clean${dryRun ? " [dry-run]" : ""}: ${tp("удалено устаревших провайдеров {0}", result.removed)}` +
          (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
      );
      return result.overview;
    }), [act, rpc, selected]);

  const removeOpenCodeProvider = useCallback((hostId: string, providerId: string) =>
    act(async () => {
      const result = await rpc.call("opencode_apply", {
        hostId,
        ops: [{ action: "remove_provider", providerId }],
        dryRun: false,
      });
      setNotice(
        result.ok
          ? tp("Провайдер «{0}» удалён с машины", providerId)
          : tp("Ошибка удаления: {0}", t(result.error ?? "не удалось")),
      );
      return result.overview;
    }), [act, rpc]);

  const setDefaultModel = useCallback((modelId: string) =>
    act(async () => {
      const result = await rpc.call("opencode_set_default_model", {
        modelId,
        setAsBbDefault: true,
        setAsOpenCodeDefault: true,
      });
      setNotice(
        result.ok
          ? tp("Предустановленная модель: {0} (BB: {1}, хосты: {2})", modelId, result.bbUpdated ? t("обновлено") : t("пропущено"), result.updatedHosts)
          : t("Не удалось установить модель"),
      );
      return result.overview;
    }), [act, rpc]);

  if (data === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {error === null ? t("Загрузка каталога…") : t(error)}
      </div>
    );
  }

  const machine =
    selected === null
      ? null
      : (data.hosts.find((item) => item.hostId === selected) ?? null);
  // Счётчики и список новых сужаются до выбранной машины.
  const drift = data.drift.filter(
    (item) => selected === null || item.hostId === selected,
  );
  const missing = drift.filter((item) => item.state === "missing").length;
  const different = drift.filter((item) => item.state === "different").length;
  const toSync = missing + different;
  // Сервер живёт на нескольких машинах: при выборе машины и отбор, и агрегаты
  // состояния считаются по её вхождениям, а не по первому найденному.
  const pending =
    selected === null
      ? data.pending
      : data.pending
          .filter((item) =>
            item.occurrences.some(
              (occurrence) => occurrence.hostId === selected,
            ),
          )
          .map((item) => {
            const occurrences = item.occurrences.filter(
              (occurrence) => occurrence.hostId === selected,
            );
            const first = occurrences[0];
            return first === undefined
              ? item
              : {
                  ...item,
                  occurrences,
                  kind: first.kind,
                  hostName: first.hostName,
                  hostId: first.hostId,
                };
          });
  // За шлюзом важнее локальности: сервер, который одновременно и за MetaMCP,
  // и «локальный» по эвристике, попадает в группу шлюза.
  const pendingGateway = pending.filter(
    (item) => item.kind === "metamcp-stdio",
  );
  // Записи из .agents/metamcp.mcp.json не дублируются верхним уровнем — они
  // видны деревом внутри своего шлюза (см. PendingRow).
  const pendingAll = pending.filter((item) => item.kind !== "metamcp-stdio");
  // «Новые» — то, что реально можно раскатать: обычный сервер, не машинно-
  // зависимый и не выключенный в конфиге. Шлюзы и вендорские серверы CLI сюда
  // не попадают, у них своя судьба.
  const pendingNew = pending.filter(
    (item) =>
      item.role === "server" && !item.localOnly && item.spec.disabled !== true,
  );
  const pendingLocal = pending.filter(
    (item) => item.kind !== "metamcp-stdio" && item.localOnly,
  );
  const pendingCounts: Record<PendingFilterKey, number> = {
    all: pendingAll.length,
    new: pendingNew.length,
    gateway: pendingGateway.length,
    local: pendingLocal.length,
  };
  const pendingVisible =
    pendingFilter === "all"
      ? pendingAll
      : pendingFilter === "new"
        ? pendingNew
        : pendingFilter === "gateway"
          ? pendingGateway
          : pendingLocal;

  // Скиллы вне канона: строки вкладки «Скиллы». Информационные внешние
  // ссылки (симлинки на ~/.bb/skills и т.п.) без действий не показываем.
  const skillRows = data.skills
    .filter((view) => selected === null || view.hostId === selected)
    .flatMap((view) =>
      view.rows
        .filter((row) => row.state !== "linked-external")
        .map((row) => ({ ...row, hostId: view.hostId, hostName: view.hostName })),
    );
  const skillsAttention = data.skillsPending.filter(
    (item) => selected === null || item.hostId === selected,
  ).length;
  const skillCounts: Record<SkillFilterKey, number> = {
    all: skillRows.length,
    copy: skillRows.filter((row) => row.state === "copy").length,
    new: skillRows.filter((row) => row.state === "only-here").length,
    diverged: skillRows.filter((row) => row.state === "diverged").length,
    stray: skillRows.filter((row) => row.state === "stray-link").length,
    bbdup: skillRows.filter((row) => row.state === "bb-registry").length,
  };
  const skillVisible =
    skillFilter === "all"
      ? skillRows
      : skillRows.filter((row) => skillFilterOf(row.state) === skillFilter);

  const statusItems: Array<{ key: string; node: ReactNode }> = [];
  if (data.catalog.length > 0) {
    statusItems.push({
      key: "catalog",
      node: <span>{t("каталог")} {data.catalog.length}</span>,
    });
  }
  if (missing > 0) {
    statusItems.push({
      key: "missing",
      node: <span className="text-destructive">{t("не хватает")} {missing}</span>,
    });
  }
  if (different > 0) {
    statusItems.push({
      key: "different",
      node: <span className="text-amber-500">{t("отличается")} {different}</span>,
    });
  }
  if (pending.length > 0) {
    statusItems.push({
      key: "pending",
      node: <span>{t("новых")} {pending.length}</span>,
    });
  }

  const sync = (includeDifferent: boolean) =>
    act(async () => {
      const result = await rpc.call("sync", {
        hostId: selected,
        dryRun: false,
        includeDifferent,
      });
      setNotice(
        tp("Применено: {0}, ошибок: {1}", result.applied, result.failed) +
          (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
      );
      return result.overview;
    });

  const purgeName = (name: string) =>
    act(async () => {
      const result = await rpc.call("purge", {
        name,
        hostId: selected,
        includeGateways: true,
        dryRun: false,
      });
      setNotice(
        tp("{0}: удалено записей {1}, ошибок {2}", name, result.removed, result.failed) +
          (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
      );
      return result.overview;
    });

  const onAdopt = (name: string) =>
    act(() => rpc.call("adopt", { names: [name], scope: "global" }));
  const onAdoptLocal = (name: string) =>
    act(() => rpc.call("adopt", { names: [name], scope: "local-only" }));
  const onIgnore = (name: string) =>
    act(() => rpc.call("ignore", { names: [name] }));

  // «Серверы вне каталога»: переключатель бьёт по выбранной машине (или всем, если ничего не выбрано).
  const onTogglePending = (item: Pending, enabled: boolean) =>
    act(async () => {
      const result = await rpc.call("set_server_enabled", {
        name: item.name,
        hostId: selected,
        enabled,
      });
      setNotice(toggleNotice(item.name, enabled, result));
      return result.overview;
    });

  // «CLI выбранной машины»: переключатель конкретного сервера у конкретного агента этой машины.
  const onToggleAgentServer = (hostId: string, server: McpServer) =>
    act(async () => {
      const enabled = server.disabled === true;
      const result = await rpc.call("set_server_enabled", {
        name: server.name,
        hostId,
        enabled,
      });
      setNotice(toggleNotice(server.name, enabled, result));
      return result.overview;
    });

  // Машины, на которых конфиг шлюза существует и его можно править.
  const gatewayHosts: GatewayHostChoice[] = data.hosts.flatMap((machine) => {
    const gateway = machine.agents.find((agent) => agent.kind === "metamcp-stdio");
    if (gateway === undefined || !gateway.configExists || !gateway.writable) {
      return [];
    }
    return [
      {
        hostId: machine.hostId,
        hostName: machine.name,
        existing: gateway.servers.map((server) => server.name),
      },
    ];
  });
  const gatewayAddTarget =
    selected !== null && gatewayHosts.some((item) => item.hostId === selected)
      ? selected
      : (gatewayHosts[0]?.hostId ?? null);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
        <DeviceList data={data} selected={selected} onSelect={setSelected} />
        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-scroll md:[scrollbar-gutter:stable]">
          <div className="mx-auto box-border w-full max-w-7xl px-3 pb-8 pt-3 md:px-5 md:pt-4">
            <HostStrip data={data} selected={selected} onSelect={setSelected} />
            <Tabs
              value={toolTab}
              onValueChange={(value) =>
                setToolTab(value as "mcp" | "skills" | "backups" | "plugins" | "opencode")
              }
            >
              {/* Шапка: заголовок слева, язык и обновление всегда справа — не делят строку с кнопками вкладки. */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-medium">
                    {machine === null ? t("Инструменты агентов") : machine.name}
                  </h1>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plural(data.hosts.length, ["машина", "машины", "машин"])} · {t("обход")}{" "}
                    {relative(data.lastScanAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                  <div className="flex overflow-hidden rounded-md border" role="group" aria-label={t("Язык интерфейса")}>
                    {(["ru", "en"] as Lang[]).map((option) => (
                      <button
                        key={option}
                        type="button"
                        disabled={busy || data.lang === option}
                        className={`px-2 py-1 text-xs ${
                          data.lang === option
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        onClick={() => act(() => rpc.call("set_language", { lang: option }))}
                      >
                        {option === "ru" ? "RU" : "EN"}
                      </button>
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("Обновить")}
                    disabled={busy}
                    onClick={() =>
                      act(() => rpc.call("rescan", { hostId: selected }))
                    }
                  >
                    <Icon name="ArrowReloadHorizontal" className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-3">
                <TabsList>
                  <TabsTrigger value="mcp">{t("MCP-серверы")}</TabsTrigger>
                  <TabsTrigger value="skills">
                    {t("Скиллы")}
                    {skillsAttention === 0 ? null : ` · ${skillsAttention}`}
                  </TabsTrigger>
                  <TabsTrigger value="backups">{t("Архив")}</TabsTrigger>
                  <TabsTrigger value="plugins">
                    {t("Плагины")}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {data.plugins?.length ?? 0}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="opencode">
                    OpenCode
                    {(data.opencode?.drift?.length ?? 0) === 0 ? null : (
                      <span className="ml-1.5 text-xs font-medium text-amber-500">
                        · {data.opencode.drift.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              {error === null ? null : (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {t(error)}
                </p>
              )}
              {notice === null ? null : (
                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                  {t(notice)}
                </p>
              )}

              <Separator className="mt-3" />

              {toolTab === "mcp" ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                    {statusItems.map((item, index) => (
                      <span key={item.key} className="flex items-center gap-1.5">
                        {index > 0 ? <span aria-hidden="true">·</span> : null}
                        {item.node}
                      </span>
                    ))}
                  </div>
                  <span className="flex-1" />
                  {gatewayHosts.length !== 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setGatewayAddOpen(true)}
                    >
                      {t("За шлюз…")}
                    </Button>
                  ) : null}
                  {toSync > 0 ? (
                    <Button size="sm" disabled={busy} onClick={() => sync(true)}>
                      {t("Синхронизировать")} · {toSync}
                    </Button>
                  ) : null}
                  <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                    <Switch
                      checked={data.autoSync}
                      disabled={busy}
                      aria-label={tp("Автосинхронизация {0}", data.autoSync ? t("включена") : t("выключена"))}
                      onCheckedChange={(enabled) =>
                        act(() => rpc.call("set_auto_sync", { enabled }))
                      }
                    />
                    {t("Автосинхронизация")}
                  </label>
                </div>
              ) : null}

              {toolTab === "skills" ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        rpc.call("skills_fanout", { hostId: selected, dryRun: false }).then((result) => {
                          setNotice(
                            (result.ops.length === 0
                              ? t("Дома уже совпадают с каноном.")
                              : tp("Разложено: {0}, ошибок: {1}", result.applied, result.failed)) +
                              (result.skippedByPlugin.length === 0
                                ? ""
                                : `\n${tp("Отдаёт плагин, не дублируем: {0}", result.skippedByPlugin.length)}`) +
                              (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
                          );
                          return result.overview;
                        }),
                      )
                    }
                  >
                    {t("Разложить канон по домам")}
                  </Button>
                  <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                    <Switch
                      checked={data.skillsFanOutAuto}
                      disabled={busy}
                      aria-label={tp(
                        "Автораскатка {0}",
                        data.skillsFanOutAuto ? t("включена") : t("выключена"),
                      )}
                      onCheckedChange={(enabled) =>
                        act(() => rpc.call("set_skills_fanout_auto", { enabled }))
                      }
                    />
                    {t("Раскатывать по расписанию")}
                  </label>
                </div>
              ) : null}

              {toolTab === "opencode" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={busy} onClick={() => syncOpenCode(false)}>
                    {t("Синхронизировать OpenCode")}
                  </Button>
                  {data.opencode?.drift?.some((d) => d.type === "stale_provider") ||
                  data.opencode?.providers?.some((p) => p.isStale && Object.values(p.hosts).some((h) => h.configured)) ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => cleanOpenCode(false)}>
                      {t("Очистить устаревшие")}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <TabsContent value="mcp" className="mt-4 space-y-6">
            <Section title={t("Каталог")} count={data.catalog.length || undefined}>
              <CatalogTable
                data={data}
                selected={selected}
                busy={busy}
                onRemove={(name) =>
                  act(() => rpc.call("catalog_remove", { name }))
                }
                onPurge={purgeName}
              />
            </Section>

            {pending.length === 0 ? null : (
              <Section title={t("Серверы вне каталога")}>
                <PendingFilters
                  value={pendingFilter}
                  onChange={setPendingFilter}
                  counts={pendingCounts}
                >
                  <PendingTable
                    items={pendingVisible}
                    data={data}
                    treeEnabled={pendingFilter !== "gateway"}
                    disabled={busy}
                    onAdopt={onAdopt}
                    onAdoptLocal={onAdoptLocal}
                    onIgnore={onIgnore}
                    onPurge={purgeName}
                    onToggleEnabled={onTogglePending}
                  />
                </PendingFilters>
              </Section>
            )}

            {machine === null ? null : (
              <Section title={t("CLI выбранной машины")}>
                {machine.error === null ? (
                  <MachineTable
                    machine={machine}
                    data={data}
                    busy={busy}
                    onToggleServer={onToggleAgentServer}
                  />
                ) : (
                  <p className="text-sm text-destructive">{t(machine.error)}</p>
                )}
              </Section>
            )}

            {data.ignored.length === 0 ? null : (
              <Section title={t("Скрытые")} count={data.ignored.length}>
                <div className="flex flex-wrap gap-2">
                  {data.ignored.map((name) => (
                    <Badge
                      key={name}
                      variant="outline"
                      className="gap-1 py-0.5 pl-2.5 pr-1 font-normal"
                    >
                      {name}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-5 text-muted-foreground hover:text-foreground"
                        aria-label={tp("Вернуть {0} в предложения", name)}
                        disabled={busy}
                        onClick={() =>
                          act(() => rpc.call("unignore", { names: [name] }))
                        }
                      >
                        <Icon name="ArrowTurnBackward" className="size-3.5" />
                      </Button>
                    </Badge>
                  ))}
                </div>
              </Section>
            )}
              </TabsContent>
              <TabsContent value="skills" className="mt-4">
                <SkillCanon data={data} selected={selected} />
                <Separator className="my-4" />
                <SkillStateLegend />
                <Tabs
                  className="mt-3"
                  value={skillFilter}
                  onValueChange={(next) => setSkillFilter(next as SkillFilterKey)}
                >
                  <TabsList className="flex h-auto min-h-9 flex-wrap">
                    {SKILL_FILTERS.map((option) => (
                      <TabsTrigger key={option.key} value={option.key} title={option.hint}>
                        {option.label}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {skillCounts[option.key]}
                        </span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <TabsContent value={skillFilter} className="mt-3">
                {(() => {
                  const ops = skillVisible
                    .map((row) => ({ row, action: resolveRowAction(row as unknown as SkillRowT) }))
                    .filter((item): item is { row: (typeof skillVisible)[number]; action: NonNullable<ReturnType<typeof resolveRowAction>> } => item.action !== null && item.action.manual !== true);
                  const ambiguous = skillVisible.filter((row) => row.state === "diverged" && (row.mtime === null || row.canonicalMtime === null || row.mtime === row.canonicalMtime)).length;
                  return ops.length > 1 ? (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            rpc
                              .call(
                                "skill_adopt_bulk",
                                { ops: ops.map(({ row, action }) => ({ hostId: row.hostId, locationId: row.locationId, name: row.name, mode: action.mode })) },
                              )
                              .then((result) => {
                                setNotice(
                                  tp("Правила применились: {0}, ошибок: {1}", result.changed, result.failed) +
                                    (result.errors.length === 0 ? "" : `\n${result.errors.join("\n")}`),
                                );
                                return result.overview;
                              }),
                          )
                        }
                      >
                        {t("Применить все правила")} · {ops.length}
                      </Button>
                      {ambiguous > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {t("расходятся с одинаковой датой")}: {ambiguous} — {t("решить вручную")}
                        </span>
                      ) : null}
                    </div>
                  ) : null;
                })()}
                {skillVisible.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {skillRows.length === 0
                      ? t("Всё на местах: вне канона скиллов не найдено.")
                      : t("В этом срезе пусто — посмотри другие.")}
                  </p>
                ) : (
                <CollectionFrame>
                  <Table className="min-w-[32rem]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Скилл")}</TableHead>
                        {selected === null ? (
                          <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Машина")}</TableHead>
                        ) : null}
                        <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Папка")}</TableHead>
                        <TableHead className="px-3 text-xs font-medium text-muted-foreground">{t("Состояние")}</TableHead>
                        <TableHead className="w-10 px-2" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {skillVisible.map((row) => (
                        <TableRow key={`${row.hostId}:${row.locationId}:${row.name}`} className="group">
                          <TableCell className="px-3 py-2.5 text-sm font-medium">
                            <span className="inline-flex items-center gap-2">
                              <SkillStateDot state={row.state} />
                              {row.name}
                            </span>
                          </TableCell>
                          {selected === null ? (
                            <TableCell className="px-3 py-2.5 text-sm">{row.hostName}</TableCell>
                          ) : null}
                          <TableCell className="px-3 py-2.5">
                            <TruncatedPath path={locationPath(row.locationId)} />
                          </TableCell>
                          <TableCell className="px-3 py-2.5">
                            <Badge
                              variant={row.state === "only-here" || row.state === "diverged" ? "secondary" : "outline"}
                              className="font-normal"
                              title={SKILL_STATE_HINT[row.state]}
                            >
                              {SKILL_STATE_LABEL[row.state] ?? row.state}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-2 py-2.5 text-right">
                            <span className="inline-flex items-center justify-end gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                              {(() => {
                                const action = resolveRowAction(row as unknown as SkillRowT);
                                if (action === null) return null;
                                const destructive = action.mode === "take" || action.mode === "delete";
                                return (
                                  <span
                                    title={row.mtime !== null ? new Date(row.mtime).toLocaleString() : undefined}
                                    className="inline-flex"
                                  >
                                    <Button
                                      size="sm"
                                      variant={destructive ? "destructive" : "outline"}
                                      className={TREE_ACTION}
                                      disabled={busy}
                                      onClick={() => act(() => rpc.call("skill_adopt", { hostId: row.hostId, locationId: row.locationId, name: row.name, mode: action.mode as SkillActionMode }))}
                                    >
                                      {action.label}
                                    </Button>
                                  </span>
                                );
                              })()}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CollectionFrame>
                )}
                  </TabsContent>
                </Tabs>
              </TabsContent>
              <TabsContent value="backups" className="mt-4">
                <SkillBackups hostId={selected} lastScanAt={data.lastScanAt} />
              </TabsContent>
              <TabsContent value="plugins" className="mt-4">
                <PluginsTabContent data={data} selected={selected} />
              </TabsContent>
              <TabsContent value="opencode" className="mt-4">
                <OpenCodeTabContent
                  data={data}
                  selected={selected}
                  busy={busy}
                  onSync={syncOpenCode}
                  onRemoveProvider={removeOpenCodeProvider}
                  onSetDefaultModel={setDefaultModel}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
      <GatewayAddDialog
        open={gatewayAddOpen}
        onOpenChange={setGatewayAddOpen}
        hosts={gatewayHosts}
        defaultHostId={gatewayAddTarget}
        onDone={(result) => {
          setNotice(
            tp("За шлюз добавлено: {0}", result.added) +
              (result.replaced.length > 0
                ? tp(", заменены: {0}", result.replaced.join(", "))
                : "") +
              (result.errors.length === 0
                ? ""
                : `\n${result.errors.join("\n")}`) +
              t("\nНовые сессии CLI увидят серверы автоматически."),
          );
        }}
      />
    </TooltipProvider>
  );
}

/** Бейдж в боковой панели: сколько всего требует внимания. */
function SidebarBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [badge, setBadge] = useState(0);
  const refetch = useCallback(() => {
    rpc.call("overview", null).then(
      (result) => setBadge(result.badge),
      () => {},
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("mcp-changed", (payload: unknown) => {
    const next = (payload as { badge?: number } | null)?.badge;
    if (typeof next === "number") setBadge(next);
    else refetch();
  });
  if (badge === 0) return null;
  return (
    <span className="rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">
      {badge}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "catalog",
    title: t("Инструменты"),
    icon: "Toolbox",
    path: "catalog",
    component: CatalogPage,
    experimental_sidebarAccessory: SidebarBadge,
  });
});
