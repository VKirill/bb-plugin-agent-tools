import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setDictionary,
  setLang,
  countSkillsNotOnAllMachines,
  describeRollout,
  summarizeCanonSync,
  selectFanOutHostIds,
  gitBinSearchDirs,
  formatSkillsSyncError,
  parseUntrackedOverwriteNames,
  clipErrorText,
  SKILLS_SYNC_ERROR_LIMIT,
  SKILLS_HOST_CALL_TIMEOUT_MS,
  partitionSkillHosts,
  formatHostCallTimeout,
  hostCallFailureReason,
  disconnectedHostError,
  callHostTimed,
} from "../i18n.ts";
import { EN } from "../i18n.en.ts";

setDictionary(EN);
setLang("ru");

const empty = {
  dryRun: false,
  remoteConfigured: false,
  canonEmpty: false,
  notOnAllMachines: 0,
  synced: 0,
  syncFailed: 0,
  applied: 0,
  failed: 0,
  skippedByPlugin: [] as string[],
  errors: [] as string[],
};

test("канон пуст", () => {
  const text = describeRollout({ ...empty, canonEmpty: true });
  assert.equal(text, "Канон пуст");
  assert.match(text, /Канон пуст/);
});

test("0 операций без remote при скиллах не на всех машинах", () => {
  const text = describeRollout({ ...empty, notOnAllMachines: 2 });
  assert.match(text, /2 скилла есть не на всех машинах/);
  assert.match(text, /только внутри машины/);
  assert.match(text, /git-remote/);
  assert.doesNotMatch(text, /уже совпадают/);
});

test("0 операций с remote", () => {
  const text = describeRollout({
    ...empty,
    remoteConfigured: true,
    synced: 3,
    syncFailed: 0,
  });
  assert.equal(text, "Канон синхронизирован: машин 3, ошибок 0. Разложено: 0, ошибок 0");
});

test("ошибки синка и раскатки попадают в текст", () => {
  const text = describeRollout({
    ...empty,
    remoteConfigured: true,
    synced: 1,
    syncFailed: 1,
    applied: 0,
    failed: 1,
    errors: ["OVH: timeout", "MAC Mini · typesafe-ai: нет прав"],
  });
  assert.match(text, /Канон синхронизирован: машин 1, ошибок 1\. Разложено: 0, ошибок 1/);
  assert.match(text, /OVH: timeout/);
  assert.match(text, /MAC Mini · typesafe-ai: нет прав/);
});

test("skippedByPlugin попадает в текст", () => {
  const text = describeRollout({
    ...empty,
    remoteConfigured: true,
    synced: 1,
    applied: 2,
    skippedByPlugin: ["ru-text", "agency"],
  });
  assert.match(text, /Отдаёт плагин, не дублируем: ru-text, agency/);
});

test("пробный запуск добавляет префикс, countSkillsNotOnAllMachines считает gaps", () => {
  const dry = describeRollout({ ...empty, dryRun: true, canonEmpty: true });
  assert.equal(dry, "Пробный запуск. Канон пуст");
  assert.equal(
    countSkillsNotOnAllMachines([
      { hosts: [{ state: "same" }, { state: "missing" }] },
      { hosts: [{ state: "same" }, { state: "same" }] },
    ]),
    1,
  );
});

test("без remote при раскладке домов говорит про git-remote", () => {
  const text = describeRollout({ ...empty, applied: 2, notOnAllMachines: 1 });
  assert.match(text, /Разложено: 2, ошибок: 0/);
  assert.match(text, /только внутри машины/);
  assert.match(text, /git-remote/);
  assert.doesNotMatch(text, /Канон синхронизирован/);
});

test("dry-run с remote не выдаёт успешный синк", () => {
  const text = describeRollout({
    ...empty,
    dryRun: true,
    remoteConfigured: true,
    synced: 3,
    syncFailed: 0,
    applied: 2,
  });
  assert.match(text, /^Пробный запуск\. /);
  assert.match(text, /Синк канона не выполнялся/);
  assert.match(text, /План раскладки: 2, ошибок 0/);
  assert.doesNotMatch(text, /Канон синхронизирован/);
  assert.doesNotMatch(text, /машин 3/);
});

test("dry-run с remote и пустым каноном сообщает, что синк не выполнялся", () => {
  const text = describeRollout({
    ...empty,
    dryRun: true,
    remoteConfigured: true,
    canonEmpty: true,
    synced: 0,
    syncFailed: 0,
    applied: 0,
    failed: 0,
  });
  assert.match(text, /^Пробный запуск\. /);
  assert.match(text, /Синк канона не выполнялся/);
  assert.doesNotMatch(text, /Канон синхронизирован/);
});

test("ошибка синка одной машины из трёх попадает в describeRollout", () => {
  const text = describeRollout({
    ...empty,
    remoteConfigured: true,
    synced: 2,
    syncFailed: 1,
    applied: 4,
    failed: 0,
    errors: [
      "MacBook Pro — Кирилл: незакоммиченные файлы оставлены: cocoon-chainsmith/SKILL.md",
    ],
  });
  assert.match(text, /Канон синхронизирован: машин 2, ошибок 1\. Разложено: 4, ошибок 0/);
  assert.match(text, /MacBook Pro — Кирилл/);
  assert.match(text, /cocoon-chainsmith/);
});

test("сбор ошибок синка считает syncFailed и не отдаёт машину в fan-out", () => {
  const summary = summarizeCanonSync([
    { hostId: "host_mini", hostName: "MAC Mini", ok: true, error: null },
    {
      hostId: "host_macbook",
      hostName: "MacBook Pro — Кирилл",
      ok: false,
      error: "untracked files would be overwritten: cocoon-chainsmith/SKILL.md",
    },
    { hostId: "host_ovh", hostName: "OVH Server", ok: true, error: null },
  ]);
  assert.equal(summary.synced, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failedHostIds, ["host_macbook"]);
  assert.deepEqual(summary.okHostIds, ["host_mini", "host_ovh"]);
  assert.match(summary.errors[0] ?? "", /MacBook Pro — Кирилл/);
  assert.match(summary.errors[0] ?? "", /cocoon-chainsmith/);
  assert.deepEqual(
    selectFanOutHostIds(["host_mini", "host_macbook", "host_ovh"], summary.failedHostIds),
    ["host_mini", "host_ovh"],
  );
});

test("путь git включает launchd-безопасные каталоги", () => {
  const dirs = gitBinSearchDirs("", "/Users/example");
  assert.ok(dirs.includes("/usr/bin"));
  assert.ok(dirs.includes("/opt/homebrew/bin"));
  assert.ok(dirs.includes("/Library/Developer/CommandLineTools/usr/bin"));
  assert.ok(dirs.includes("/Users/example/.local/bin"));
});

test("ошибка git обрезается до 2000 и называет незакоммиченные файлы", () => {
  const stderr =
    "error: The following untracked working tree files would be overwritten by merge:\n" +
    "\tcocoon-chainsmith/ORIGINAL.md\n" +
    "\tcocoon-chainsmith/SKILL.md\n" +
    "Please move or remove them before you merge.\nAborting\n";
  assert.deepEqual(parseUntrackedOverwriteNames(stderr), [
    "cocoon-chainsmith/ORIGINAL.md",
    "cocoon-chainsmith/SKILL.md",
  ]);
  const text = formatSkillsSyncError({ stderr, message: "Command failed: git pull" }, "git@github.com:org/repo.git", "/usr/bin/git");
  assert.match(text, /git: \/usr\/bin\/git/);
  assert.match(text, /remote: ssh/);
  assert.match(text, /cocoon-chainsmith\/SKILL.md/);
  assert.ok(text.length <= SKILLS_SYNC_ERROR_LIMIT);
  assert.equal(clipErrorText("x".repeat(2500)).length, SKILLS_SYNC_ERROR_LIMIT);
  assert.ok(clipErrorText("x".repeat(2500)).endsWith("…"));
});

test("отключённые машины не в целях, а в errors", () => {
  const { targets, disconnected } = partitionSkillHosts(
    [
      { id: "host_mini", name: "MAC Mini", status: "connected" },
      { id: "host_macbook", name: "MacBook Pro — Кирилл", status: "disconnected" },
      { id: "host_ovh", name: "OVH Server", status: "connected" },
    ],
    null,
  );
  assert.deepEqual(targets.map((item) => item.id), ["host_mini", "host_ovh"]);
  assert.deepEqual(disconnected.map((item) => item.id), ["host_macbook"]);
  const one = partitionSkillHosts(
    [
      { id: "host_macbook", name: "MacBook Pro — Кирилл", status: "disconnected" },
    ],
    "host_macbook",
  );
  assert.equal(one.targets.length, 0);
  assert.equal(one.disconnected[0]?.id, "host_macbook");
  assert.equal(disconnectedHostError("MacBook Pro — Кирилл"), "MacBook Pro — Кирилл: машина не на связи");
});

test("таймаут host.call даёт именованную ошибку раньше 30 с", async () => {
  assert.equal(SKILLS_HOST_CALL_TIMEOUT_MS, 25_000);
  assert.equal(formatHostCallTimeout(25_000), "машина не ответила за 25 с");
  assert.equal(
    hostCallFailureReason(new Error("Timed out waiting for command result")),
    "машина не ответила за 25 с",
  );
  await assert.rejects(
    () =>
      callHostTimed(async (timeoutMs) => {
        assert.equal(timeoutMs, 25_000);
        throw new Error("Timed out waiting for command result");
      }),
    (cause: unknown) => {
      assert.match(cause instanceof Error ? cause.message : String(cause), /машина не ответила за 25 с/);
      return true;
    },
  );
});

test("локальный deadline завершает зависший host.call фактически", async () => {
  const startedAt = performance.now();
  await assert.rejects(
    () => callHostTimed(() => new Promise<never>(() => undefined), 50),
    /машина не ответила за 1 с/,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 35, `deadline сработал слишком рано: ${elapsedMs} ms`);
  assert.ok(elapsedMs < 1_000, `зависший вызов не был оборван: ${elapsedMs} ms`);
});

test("deadline по умолчанию реально укладывается в 30 с", { timeout: 30_000 }, async () => {
  const startedAt = performance.now();
  await assert.rejects(
    () => callHostTimed(() => new Promise<never>(() => undefined)),
    /машина не ответила за 25 с/,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 24_000, `deadline сработал раньше заданных 25 с: ${elapsedMs} ms`);
  assert.ok(elapsedMs < 30_000, `deadline нарушил лимит 30 с: ${elapsedMs} ms`);
});

test("dry-run с remote при совпадающих домах сообщает, что синк не выполнялся", () => {
  const text = describeRollout({
    ...empty,
    dryRun: true,
    remoteConfigured: true,
    canonEmpty: false,
    synced: 0,
    applied: 0,
    failed: 0,
  });
  assert.match(text, /Синк канона не выполнялся/);
  assert.match(text, /План раскладки: 0, ошибок 0/);
  assert.doesNotMatch(text, /Канон синхронизирован/);
  assert.doesNotMatch(text, /уже совпадают/);
});
