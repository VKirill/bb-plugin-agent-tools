# Changelog

## Unreleased

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
