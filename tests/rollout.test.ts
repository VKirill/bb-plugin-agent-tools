import { test } from "node:test";
import assert from "node:assert/strict";
import { setDictionary, setLang, countSkillsNotOnAllMachines, describeRollout } from "../i18n.ts";
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
