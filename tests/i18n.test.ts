import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setLang, getLang, t, tp, plural, setDictionary } from "../i18n.ts";
import { EN } from "../i18n.en.ts";

setDictionary(EN);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("русский отдаёт оригинал, английский — перевод, пропуск не ломает экран", () => {
  setLang("ru");
  assert.equal(getLang(), "ru");
  assert.equal(t("Устройства"), "Устройства");
  setLang("en");
  assert.equal(t("Устройства"), "Machines");
  assert.equal(t("Такой строки в словаре нет"), "Такой строки в словаре нет");
  setLang("ru");
});

test("подстановки сохраняют места значений в обоих языках", () => {
  setLang("ru");
  assert.equal(tp("Готово: {0}, ошибок: {1}", 3, 0), "Готово: 3, ошибок: 0");
  setLang("en");
  assert.equal(tp("Готово: {0}, ошибок: {1}", 3, 0), "Done: 3, failed: 0");
  setLang("ru");
});

test("склонения: три формы по-русски, две по-английски", () => {
  setLang("ru");
  assert.equal(plural(1, ["машина", "машины", "машин"]), "1 машина");
  assert.equal(plural(3, ["машина", "машины", "машин"]), "3 машины");
  assert.equal(plural(11, ["машина", "машины", "машин"]), "11 машин");
  setLang("en");
  assert.equal(plural(1, ["машина", "машины", "машин"]), "1 machine");
  assert.equal(plural(3, ["машина", "машины", "машин"]), "3 machines");
  setLang("ru");
});

test("каждая строка интерфейса и CLI переведена", () => {
  const keys = new Set<string>();
  for (const file of ["app.tsx", "server.ts"]) {
    const source = readFileSync(path.join(root, file), "utf8");
    // В исходнике переносы записаны как \n — в ключе это один символ.
    const unescape = (value: string) => value.replace(/\\n/g, "\n");
    for (const match of source.matchAll(/\bt\("([^"]+)"\)/g)) keys.add(unescape(match[1]!));
    for (const match of source.matchAll(/\btp\("([^"]+)"/g)) keys.add(unescape(match[1]!));
    for (const match of source.matchAll(/plural\([^,]+,\s*\[([^\]]+)\]/g)) {
      for (const form of match[1]!.split(",")) keys.add(form.trim().replace(/^"|"$/g, ""));
    }
  }
  const missing = [...keys].filter((key) => /[А-Яа-яЁё]/.test(key) && EN[key] === undefined);
  assert.deepEqual(missing, [], `нет перевода: ${missing.join(" | ")}`);
});
