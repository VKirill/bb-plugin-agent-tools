# Agent Tools for BB — one inventory of MCP servers and skills across every machine

[![BB Compatibility](https://img.shields.io/badge/BB-%3E%3D0.43-blue.svg)](https://getbb.app)
[![Plugin SDK](https://img.shields.io/badge/Plugin%20SDK-%3E%3D0.4.87-green.svg)](https://getbb.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Your agents run on several machines, and each one drifts its own way: a server configured on the laptop is missing on the box, a skill edited on the desktop never reaches the server. This plugin walks every machine connected to BB, reads the config of each installed CLI agent and every skills folder, and brings them to one catalogue and one canon.

*[Русская версия ниже](#инструменты-агентов--плагин-bb).*

## What it does

- **Machine catalogue.** Every BB machine with the number of CLIs found, the time of the last sweep and a drift badge. MetaMCP gateways and the servers behind them are listed below.
- **Server matrix.** A row is an MCP server from the catalogue, a column is a machine (or a CLI on the selected machine): ✓ present, ✗ missing, ⚠ configured differently, · agent not managed.
- **Adopting new servers.** Anything found on a machine but absent from the catalogue lands in "New servers". Accept it everywhere, keep it local to one machine, or hide it from suggestions.
- **Sync.** One action brings a machine (or all of them) to the catalogue: adds what is missing and, on request, rewrites what differs. It never deletes on its own — removal is a separate confirmed action, optionally including gateway configs.
- **Hourly sweep.** Optional: tops up missing servers by itself. The sidebar badge shows how many new servers and drifts are waiting for a decision.

### Skills: one canon, many homes

The source of truth is `~/.agents/skills`. It is a git repository, and it is the only thing that travels between machines; every CLI home is derived from it.

| Folder | Policy | What the plugin does |
| --- | --- | --- |
| `~/.agents/skills` | canon | source of truth, synced over your own git remote |
| `~/.claude/skills`, `~/.qwen/skills` | link | symlinks into the canon — these CLIs read only their own home |
| `~/.codex/skills`, `~/.cursor/skills`, `~/.config/opencode/skills` | native | nothing: these CLIs read the canon themselves |
| `~/.bb/skills` | own | never rewritten — BB indexes only real folders there, so a symlink would drop the skill out of BB's registry; fan-out puts a mirror copy next to it |
| `~/.gemini/config/skills` | drop | unused: both copies and links are removed |

- **Canon summary.** The Skills tab opens with a row per skill and a column per machine: present / differs / missing. Same from the shell: `bb tools skills --canon`.
- **Sync and fan-out.** `bb tools skills-sync` keeps the canon identical on every machine through your own git remote; `bb tools skills-fanout` lays it out inside a machine. Both run hourly on their own.
- **Version archive.** Anything replaced or deleted is snapshotted to `~/.agents/skills-backups/<name>/<time>/` with the date, machine and reason, and marked *unique* when that content exists nowhere else. Restore any version into the canon in one click, and it travels to the other machines with the next sync.
- **Two guards against silent loss.** A replacement is cancelled when the losing version has files the winning one does not — that is a different branch of work, not a fresher edit, so a human decides. And a skill missing from a home counts as "deleted by a human" only if the plugin actually put it there.

## Supported CLIs

| CLI | Config | Format |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.*]` |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `mcp` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Antigravity (agy) | `~/.agents/mcp_config.json` | `mcpServers` + `serverUrl` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers`, remote via `httpUrl` |
| Qwen Code | `~/.qwen/settings.json` | `mcpServers` |
| Kimi CLI | `~/.kimi-code/mcp.json` | `mcpServers` |
| Grok CLI | `~/.grok/config.toml` | `[mcp_servers.*]`, TOML |
| MimoCode | `~/.config/mimocode/mimocode.json` | `mcp`, OpenCode format |
| Crush | `~/.config/crush/crush.json` | `mcp` |
| MetaMCP (local gateway) | `~/.agents/metamcp.mcp.json` | read only |

Every installed CLI is shown even when BB has no provider for it — those are marked as not bridged. CLIs without an adapter (`aider`, `amp`, `goose`, `droid`, `copilot`) appear as a separate line for the machine.

## Safety rules

- Every write leaves a `*.bak-bb-mcp-<time>` copy next to the config; the last five are kept.
- Writes are atomic: temp file plus `rename`, preserving the original file's permissions.
- A config with comments (for example `opencode.jsonc`) is read but never rewritten.
- For Kimi and Crush the config path is not yet confirmed from a live machine, so the plugin writes there only if the file already exists.
- Machine-specific servers (an absolute binary path, a `127.0.0.1` address, a `${SECRET}` reference) are marked local and never fanned out.
- Codex `config.toml` is edited as text, so comments, section order and every other setting stay untouched.

## Commands

```bash
bb tools status            # catalogue, machines, drift
bb tools scan              # sweep the machines now
bb tools pending           # new servers
bb tools adopt <name>...   # accept into the catalogue
bb tools forget <name>     # drop the entry, leave the machines alone
bb tools remove <name> [--with-gateways] [--dry-run]   # remove a server from machines
bb tools plan              # what sync would change
bb tools sync [--dry-run]  # apply
bb tools auto on|off       # hourly sweep

bb tools skills [--canon]          # skills outside the canon, or the canon per machine
bb tools skills-sync               # sync the canon through your git remote
bb tools skills-fanout [--dry-run] # lay the canon out into the CLI homes
bb tools skills-backups            # version archive
bb tools skills-restore <id>       # restore a snapshot into the canon

bb tools plugins           # CLI plugins per machine
bb tools opencode          # OpenCode providers and models
bb tools opencode-sync     # sync OpenCode from the reference machine
bb tools opencode-clean    # drop stale OpenCode providers
```

## Settings

`bb plugin config agent-tools` — the MetaMCP address, its API key (secret), the namespaces to read, the git remote for the skills canon (secret), and whether to fan out names that a marketplace plugin already provides.

## Install and develop

```sh
npm ci
npm run build          # or: bb plugin build .
bb plugin install .
```

For development: `bb plugin dev`. Tests and types: `npm test`, `npm run typecheck`.

---

# Инструменты агентов — плагин BB

> Агенты работают на нескольких машинах, и каждая разъезжается по-своему: сервер, настроенный на ноутбуке, отсутствует на сервере; навык, поправленный на десктопе, туда не доезжает. Плагин обходит каждую подключённую к BB машину, читает конфиги установленных CLI-агентов и папки навыков и приводит их к одному каталогу и одному канону.

## Что он делает

- **Каталог устройств.** Слева все машины BB с числом найденных CLI, временем последнего обхода и бейджем расхождений. Ниже — шлюзы MetaMCP и серверы внутри них.
- **Матрица серверов.** Строка — MCP-сервер из каталога, столбец — машина (или CLI выбранной машины): ✓ есть, ✗ не хватает, ⚠ настроен иначе, · агент не управляется.
- **Приём новых серверов.** Всё, что найдено на машинах, но отсутствует в каталоге, попадает в список «Новые серверы»: принять везде, оставить локальным или скрыть из предложений.
- **Синхронизация.** Одно действие приводит выбранную машину или все сразу к каталогу: добавляет недостающее, по запросу переписывает отличающееся. Сама ничего не удаляет — удаление отдельным действием с подтверждением, при желании вместе с конфигами шлюзов.
- **Часовой обход.** По желанию сам доливает недостающие серверы. Бейдж в боковой панели показывает, сколько новых серверов и расхождений ждут решения.

### Навыки: один канон, много домов

Источник правды — `~/.agents/skills`. Это git-репозиторий и единственное, что ездит между машинами; дома CLI — производные от него.

| Папка | Политика | Что делает плагин |
| --- | --- | --- |
| `~/.agents/skills` | канон | источник правды, синк через ваш git-remote |
| `~/.claude/skills`, `~/.qwen/skills` | ссылки | симлинки в канон: эти CLI читают только свой дом |
| `~/.codex/skills`, `~/.cursor/skills`, `~/.config/opencode/skills` | сами | ничего: эти CLI читают канон напрямую |
| `~/.bb/skills` | своя | не переписываем: BB заносит в реестр только реальные папки, симлинк оттуда выпадает из списка навыков — раскатка кладёт рядом копию-зеркало |
| `~/.gemini/config/skills` | не используем | убираются и копии, и ссылки |

- **Сводка канона.** Вкладка «Скиллы» открывается таблицей: строка на навык, колонка на машину — есть / отличается / нет. То же в терминале: `bb tools skills --canon`.
- **Синк и раскатка.** `bb tools skills-sync` держит канон одинаковым на всех машинах через ваш git-remote, `bb tools skills-fanout` раскладывает его внутри машины. Оба раз в час происходят сами.
- **Архив версий.** Всё заменённое и удалённое уходит снимком в `~/.agents/skills-backups/<имя>/<время>/` с датой, машиной и причиной, с пометкой «уникальная», если такого содержимого больше нигде нет. Любая версия возвращается в канон одной кнопкой и следующим синком разъезжается по машинам.
- **Две защиты от тихой потери.** Замена отменяется, если в проигравшей версии есть файлы, которых нет в победившей: это не свежая правка, а другая ветка работы — решает человек. А исчезновение навыка в доме считается удалением только тогда, когда плагин сам его туда раскладывал.

## Поддерживаемые CLI

Таблица конфигов — [в английской части](#supported-clis). Каждый установленный CLI показывается, даже если у BB нет провайдера для него: такие помечены как «не проброшен». CLI без адаптера (`aider`, `amp`, `goose`, `droid`, `copilot`) видны в списке машины отдельной строкой.

## Правила безопасности

- Перед каждой записью рядом с конфигом остаётся копия `*.bak-bb-mcp-<время>`; хранятся последние пять.
- Запись атомарная: временный файл и `rename`, права исходного файла сохраняются.
- Файл с комментариями (например `opencode.jsonc`) читается, но не переписывается.
- Для Kimi и Crush путь конфига пока не подтверждён фактом с машины, поэтому плагин пишет туда, только если файл уже существует.
- Машинно-зависимые серверы (абсолютный путь к бинарю, адрес на `127.0.0.1`, ссылка `${SECRET}`) помечаются как локальные и не раскатываются.
- Codex `config.toml` правится по тексту, поэтому комментарии, порядок секций и остальные настройки остаются нетронутыми.

## Команды

Полный список — [в английской части](#commands); названия команд одинаковые.

## Настройки

`bb plugin config agent-tools` — адрес MetaMCP, API-ключ (секрет), список namespace'ов, git-remote канона навыков (секрет) и переключатель «раскатывать и то, что уже отдают плагины-маркетплейсы».

## Установка и разработка

```sh
npm ci
npm run build          # либо: bb plugin build .
bb plugin install .
```

Для разработки: `bb plugin dev`. Тесты и типы: `npm test`, `npm run typecheck`.

## License

MIT
