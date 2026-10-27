# Changelog

## Unreleased

## 0.2.9

- Навыки живут на хабе. Канон — `~/.bb/skills` сервера BB (git-рабочая копия репозитория навыков): BB сам отдаёт эти навыки в каждую сессию на любой машине. Новый раздел «Навыки» показывает их деревом категорий, списком и карточкой навыка (описание, проблемы, файлы, просмотр `SKILL.md`, история git).
- Категории в два уровня (раздел → подраздел) хранятся в плагине, файлы навыков не меняются. Новый навык встаёт к соседям с тем же префиксом имени, остальные по одному уходят в скрытый тред BB с Claude Haiku 5.5 (тред живёт час, потом открывается новый). Модель отвечает вызовом инструмента плагина; если категории нет — создаёт её; неуверенный ответ уходит «На проверку». Разложенный навык автоматически больше не переносится.
- Публикация и правка: `bb tools skills-publish <папка>` проверяет навык по правилам BB (шапка YAML, имя, описание до 1024, до 10 МБ и 1000 файлов), заменяет его на хабе, коммитит и пушит; `bb tools skills-pull <навык>` кладёт копию в `~/skill-drafts`. Ещё `skills-hub`, `skills-tree`, `skills-move`, `skills-classify`, `skills-remove`, `skills-machines`, `skills-cleanup`.
- Копии навыков на машинах (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.bb/skills` и папки других CLI) показаны полосой на странице и убираются в датированный архив `~/.agents/skills-backups/cleanup-…`; папки самих CLI (`synced` у Claude Code, `.system` у Codex) остаются.
- Интерфейс: слева разделы (Навыки, MCP-серверы, Плагины CLI, OpenCode) со счётчиками «требует внимания», машины — только у разделов, где они нужны. Старые вкладки «Скиллы» (матрица канона по машинам) и «Архив» убраны; часовой обход больше не раскладывает навыки по машинам.
- Встроенный навык `agent-tools`: описание в кавычках (раньше BB отбрасывал его из-за двоеточия) и новые правила хранения навыков.
- Стили экрана — набор Pokecut (`app.css`, префикс `at-`).

## 0.2.8

- Windows: настоящая причина сбоя синка канона — в хост-процессе BB на Windows `promisify(execFile)` возвращал результат без `stdout`, поэтому каждое чтение git (`remote get-url`, `rev-parse`, `status`) давало `undefined`. Git и tar теперь запускаются через явную обёртку над колбэком `execFile`, которая всегда отдаёт `{ stdout, stderr }`.
- Подмена `Git\cmd\git.exe` на `Git\mingw64\bin\git.exe` из 0.2.7 отменена: лаунчер был ни при чём.

## 0.2.7

- Windows: синк канона навыков берёт настоящий `Git\mingw64\bin\git.exe` вместо лаунчера `Git\cmd\git.exe`. В фоновом процессе хоста лаунчер терял вывод: `remote get-url` возвращал пустую строку, и синк падал на «remote origin already exists».
- Если `remote add origin` отвечает «already exists», синк переходит к `remote set-url`, а не останавливается.

## 0.2.6

- Поддержка Windows-машин. Раньше плагин видел там только часть картины: Claude Code числился «не установленным», хотя `claude.exe` лежал в `~/.local/bin`.
- Поиск CLI и git учитывает `PATHEXT` (`claude.exe`, `kimi.exe`, `codex.cmd`, `git.exe`) и типичные каталоги Windows: `%APPDATA%\npm`, `Program Files\Git`, `Program Files\nodejs`, `~\.local\bin`, `~\.bun\bin`, scoop.
- Git канона навыков запускается с `core.autocrlf=false`: иначе checkout с CRLF менял размеры файлов, отпечатки расходились с другими машинами и каждый скилл выглядел изменённым. На macOS и Linux поведение прежнее.
- Ссылки на скиллы в домах CLI создаются как junction — Developer Mode и права администратора не нужны.
- Машинно-зависимыми считаются и Windows-пути (`C:\…`, `C:/…`, UNC) в команде и аргументах, а также каталоги приложений (`AppData\Local\Programs`, `WindowsApps`). Шлюз MetaMCP узнаётся и за обёрткой `cmd /c …\metamcp-run.cmd`.
- Сервер `npx -y pkg` раскатывается на Windows в рабочей форме `cmd /c npx -y pkg` (нативные Claude Code и Codex не запускают `.cmd`-шимы напрямую), а при сравнении `cmd /c npx -y pkg` равен `npx -y pkg`, как и `C:\…\gitnexus.cmd` равен `/usr/bin/gitnexus`.
- Тесты запускаются на Windows: `tests/skills-sync.test.ts` больше не падает на `bb.cmd`, ищет `git.exe`, а новый `tests/windows.test.ts` покрывает правила платформы.

## 0.2.5

- MCP scans accept structured environment values up to 131,072 characters, preserving them without truncation. BB’s Cursor bridge stores serialized tool schemas in `BB_ACP_DYNAMIC_TOOLS`; the old 8192-character limit could reject an entire machine scan. HTTP header limits stay unchanged.
- Added regression coverage for full host scans, lossless config round trips, and limit boundaries. Found during the follow-up to @Jehu’s English localization PR #1 — thanks for helping improve Agent Tools!


## 0.2.4

- Keep Agent Tools’ own English/Russian dictionary in control when a global UI translator is active, including dialogs. Discovered while verifying the English localization from @Jehu’s PR #1; thanks again for the contribution!


## 0.2.3

- English plugin metadata, marketplace overview, bundled skill, and default CLI language. Thanks to @Jehu for PR #1 and the English translation work.
- The page follows BB’s interface language (`ru*` selects Russian); Russian skill triggers and translated skill action labels are retained.
- Configuration warnings and machine-local reasons are translated at display time without losing diagnostic details. Existing theme styling is preserved.


## 0.2.2

- Английский интерфейс переведён целиком: легенда состояний скиллов, фильтры «Копии / Новые / Дубли BB», срезы новых серверов, подписи точек матрицы, дата и причина снимка в архиве. Раньше эти подписи вычислялись при загрузке модуля, до выбора языка, и оставались русскими.
- Цвета состояний берутся из токенов темы BB.
- README переписан: зачем плагин, что на каждой вкладке, как устроена запись в конфиги, настройки, CLI. Скриншоты английского интерфейса для всех пяти вкладок.

- Мусор (`node_modules`, `.venv`, `__pycache__`, `.cache` …) больше не разъезжается по машинам: раскатка, забор в канон, восстановление из архива, бэкапы и упаковка скилла для сервера BB (`skills_archive`, распаковка на сервере) копируют дерево без него. Симлинки внутри скилла разворачиваются в файлы — BB их не принимает.
- Копия в `~/.bb/skills` или в `dataDir/skills` сервера, в которой лежит мусор, перекладывается чистой при следующей раскатке, даже если хеш содержимого совпадает с каноном. Раньше хеш мусор не учитывал, и раздутая копия оставалась навсегда.
- Скилл, который и без мусора больше лимита BB (10 МБ или 1000 файлов), в дом BB и на сервер не кладётся: раскатка возвращает ошибку с причиной вместо копии, ломающей старт чатов («Skill tree exceeds max byte count»).
- Скан меряет реальные папки так, как их считает BB (`bbBytes`, `bbFiles`, `junk`): отметка «BB не примет» теперь видит `node_modules` в копии BB.
- Синк канона добавляет `node_modules/`, `.venv/`, `__pycache__/` и т.п. в `.gitignore` канона — `git add -A` их не коммитит.

- Канон скиллов тяжелее 10 МБ (лимит BB для `$`) помечается в сводке и в `bb tools skills --canon`. Размер берётся из копии в `~/.bb/skills`, иначе из канона.
- Раскатка скиллов зеркалит канон в `experimental_dataDir/skills` процесса BB-сервера (реальные папки). Хаб не угадывается по `~/.bb` другой машины. Совпадение hostname с enrolled-машиной больше не пропускает этот шаг: `$` читает `dataDir/skills`, а дом машины — `~/.bb/skills`, это разные папки. Нет локального канона — упаковка с машины (`skills_archive`); деревья крупнее 8 МБ требуют git-remote.
- Синк канона возвращает `ok:false`, если pull/checkout недостающих или push не выполнены; `ok:true` только когда локальный канон сведён с remote. Недоступный push — отдельная ошибка «push не выполнен», раскатка на машине не идёт.
- `host.call` синка и раскатки ограничен 25 с: «машина не ответила за 25 с». Отключённые машины не входят в цели и перечислены в errors; после отказа повторный scan эту машину не ждёт.
- Кнопка «Разложить канон по домам» при выборе «Все машины» просит подтверждение со списком машин.
- Синк канона на машине ищет `git` по тем же путям, что CLI-агенты (`/usr/bin`, Homebrew, Xcode). Отказ git возвращается `ok:false` с stderr (до 2000 символов), схемой remote и именем машины — без исключения. Незакоммиченные файлы не затираются: своё оставляем, с remote доливаем только отсутствующие папки. Конфликт rebase — `git rebase --abort`.
- Провал синка на машине пропускает раскатку домов на ней: устаревший канон не раскладывается. То же в часовом обходе.
- Ошибка и успех на экране больше не исчезают от `mcp-changed` / refetch и перемонтирования страницы: блок с кнопкой «Закрыть» и копируемым текстом. Диалог «Все машины» тоже остаётся до явной отмены или запуска.
- Кнопка «Разложить канон по домам» сначала синхронизирует git-канон на целевых машинах (если remote задан), затем раскладывает дома. Пустой результат и ошибка машины больше не маскируются фразой «дома уже совпадают».
- Текст результата: без remote при раскладке домов явно сказано, что межмашинный перенос нуждается в git-remote; пробный запуск не выдаёт успешный синк, если синк не выполнялся — в том числе при пустом каноне.

## 0.1.0

First public release.

- MCP catalogue across every BB machine: server × machine matrix, adopting new servers, sync that only adds, confirmed removal, hourly sweep.
- Adapters for Claude Code, Codex, OpenCode, Cursor, Antigravity, Gemini CLI, Qwen Code, Kimi CLI, Grok CLI, MimoCode, Crush and read-only MetaMCP gateways.
- Skills: one canon in `~/.agents/skills` synced over your own git remote, fan-out into the CLI homes (symlinks for Claude Code and Qwen, a mirror copy for BB, nothing for the CLIs that read the canon themselves), and a per-folder policy so BB's own registry is never rewritten.
- Version archive with restore: every replaced or deleted skill is snapshotted with date, machine and reason; a replacement is cancelled when it would drop files that exist only in the older version.
- OpenCode tab: provider and model hygiene, preselected model for new chats, one-click sync from a reference machine.
