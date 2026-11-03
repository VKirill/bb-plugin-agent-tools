---
title: Skill suggestion through Jev
type: component
created: 2026-11-03
updated: 2026-11-03
status: shadow
tags: [skills, jev, typesafe, routing]
sources:
  - skill-suggest/suggest.ts
  - skill-suggest/cards.ts
  - skill-suggest/jev.ts
  - skill-suggest/card-writer.ts
  - skill-suggest/log.ts
  - skills-hub-service.ts
---
# Skill suggestion through Jev

BB puts every skill's description and path into each session (hundreds of lines). This feature
picks at most one hub skill per user message with TypeSafe's System One model Jev, so an agent can
get one relevant line instead of the whole list. It ports TypeSafe's
[Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md) with three changes
measured on real BB traffic.

## Pipeline

1. **Routing cards.** One English card per hub skill: `does`, `not_for`, `neighbors` (how it differs
   from the closest skills, by name), `examples`, `triggers_ru`. A hidden thread
   (`agent-tools-card-writer`, provider/model of the skill classifier) writes them in batches of 10
   through `agent_tools_skill_card_save`; a card is stale when the SKILL.md hash changes. A
   `metadata.jev` block in SKILL.md frontmatter overrides the generated card.
2. **Pass 1** (one request): the roster in code-point order, split into Choice questions of at most 200
   options (Jev accepts 255), each option described by `card.does`; three gate Nouls. Shortlist: top 3
   of each chunk.
3. **Pass 2** (one request): a Choice over the shortlist with full cards, plus one `fits::<name>` Noul
   per candidate.
4. **Decision:** suggest the pass-2 winner when the gate mean ≥ 0.6 and the best `fits` ≥ 0.5, unless
   it was already suggested in the same thread in the last 6 h. Errors fail open (no suggestion).

State sent to Jev: `request` (the message, 2000 chars) and `recent_context` (previous user message,
600 chars, and the tail of the agent's last reply, 900 chars). Payload keys are sorted at every level:
Jev's answers depend on question order, and the thresholds were measured on sorted payloads.

### Gate questions

The cookbook's gates ("acts on the user's files…") open on nearly every turn of a coding agent. The
gates here ask whether a new procedure is needed:

| key | question | inverted |
|---|---|---|
| `new_kind_of_task` | starts a different kind of task rather than continuing the work just discussed | no |
| `needs_specific_instructions` | needs instructions for a particular tool, service, API, product or house method | no |
| `only_ack_or_continue` | only an acknowledgement, approval, request to continue or question about what was done | yes |

Rule-driven skills (journals, memory discipline, code-graph checks, Markdown formatting) are never
suggested: setting `skillsSuggestExclude`.

## Measurement

636 real user turns from BB thread exports (336 where the agent loaded a skill, 300 random others),
349 skills, an independent judge model deciding which candidate skills fit each turn.

| | useful | wrong skill | missed | noise on turns needing none |
|---|---|---|---|---|
| agent alone, full skill list in prompt | 26.9% | 24.5% | 48.6% | 29.1% |
| cookbook gates, thresholds 0.6 / 0.6 | 35.1% | 6.5% | 58.4% | 28.4% |
| **this pipeline, 0.6 / 0.5** | **37.0%** | **7.1%** | 56.0% | **10.8%** |
| this TypeScript port, same data | 38.6% | 7.1% | 54.3% | 11.6% |

Findings: conversation context lifts shortlist recall from ~42% to ~57%; cards beat
description + SKILL.md excerpt and cost 20% fewer tokens; translating Russian messages to English
gave no gain. Cost ≈ 22.5k input tokens per turn (≈ $0.0009 at $0.042 / Mtok), ≈ 0.45 s for both
requests.

Limits: the judge only saw skills some arm or the agent proposed; thresholds were tuned on the same
sample; turns were not consecutive, so the per-thread repeat filter was not measured.

## Surfaces

| Surface | What it does |
|---|---|
| `bb tools skills-suggest --message <text> [--prev-user …] [--prev-assistant …] [--thread <id>] [--json]` | prints a `<skill_relevance>` block or nothing; the caller's thread id is used when `--thread` is absent |
| `bb tools skills-cards [--refresh] [--wait] [--json]` | card counts; queues stale cards |
| `bb tools skills-suggest-log [--limit N] [--json]` | last entries of the 500-entry log (KV `skillSuggestLog`) |
| tools `skills_find`, `skill_read` | ranked search and SKILL.md / file reading for ordinary threads; setting `skillsSuggestTools`, off by default |

Settings: `jevApiKey` (secret), `jevModel` (`jev-1.14.0`), `skillsSuggestGate`, `skillsSuggestFits`,
`skillsSuggestExclude`, `skillsSuggestTools`.

Not in this phase: per-turn hooks for Claude Code / OpenCode, a screen, hiding BB's skill list.
