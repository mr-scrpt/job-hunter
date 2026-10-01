# job-hunter

Personal job-search assistant for the Ukrainian IT market.

Every 30 minutes it reads the Djinni and DOU vacancy feeds, drops what clearly doesn't fit, asks Claude to rate the rest against the CV, writes a tailored cover letter (in Ukrainian) for the good ones and sends a card to Telegram. You read the card, copy the letter, apply on the site and press "✅ Отправил".

Applying itself stays manual on purpose: DOU forbids automated applications, and a human glance per vacancy keeps the quality up.

## How it works

```
RSS (Djinni, DOU) ──► rules filter ──► page enrichment ──► rules again ──► cross-board dedupe
                       (age, title       (Djinni: company,     (English,
                        stop-words,       salary, English)      salary, remote)
                        company)
        ──► Claude: assess (score, role, AI focus, English) ──► below threshold → archived
                                                         └──► Claude: letter ──► Telegram card
```

- **Claude** runs through the local `claude -p` CLI, billed to the logged-in subscription — no API key. Calls are isolated: no tools, no user settings/hooks/MCP, no session files, strict JSON schema output.
- **State** lives in SQLite (`data/job-hunter.db`): every vacancy with its status and reason, plus an event log. Each vacancy is assessed once; runs are idempotent and guarded by a lock.
- **Budget**: at most `scoring.maxAssessPerRun` assessments per run, newest first; the rest wait. If Claude hits the subscription limit the run stops and resumes next time.

Statuses: `new → filtered | duplicate | low | ready → notified → applied | skipped` (`error` retries up to 3 times).

## Layout

```
src/core/          pure logic: pipeline, filters, card rendering, ports (interfaces)
src/schemas/       zod schemas: profile, vacancy, assessment, CEFR
src/adapters/      sources (djinni, dou, rss, http), llm (claude-cli), store (sqlite), telegram
prompts/           system prompts for assessment and letters — tune them freely
config/            profile.example.yaml (tracked), profile.yaml (yours, gitignored)
tests/             node:test, fixtures are trimmed real responses
deploy/systemd/    user service
```

## Setup

Requirements: Node 26 (via mise), `claude` CLI logged in, `pdftotext` (poppler).

```sh
npm install
cp config/profile.example.yaml config/profile.yaml   # edit: CV path, filters, feeds
npm test
npm run scan -- --limit 5                             # dry run without Telegram
npm run show                                          # print the best cards
```

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Save the token to `~/.local/share/secrets/job-hunter.token` (`chmod 600`). Never commit it.
3. Start the service, then send `/start` to the bot — the first chat that does it becomes the owner; everyone else is ignored.

```sh
ln -sf "$PWD/deploy/systemd/job-hunter.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now job-hunter
journalctl --user -u job-hunter -f
```

Bot commands: `/scan` (check now), `/stats`, `/help`. Card buttons: ✅ Отправил, ✏️ Переписать (send what to change, or `-` to just regenerate), ⏭ Пропустить, ↩️ Вернуть.

## CLI

| command | what |
|---|---|
| `npm run scan [-- --limit N]` | one pipeline run |
| `npm run bot` | bot + scheduled scans (what the service runs) |
| `npm run stats` | counters |
| `npm run show [-- 10 low]` | top cards by score, any status list (`ready,notified`, `low`, …) |
| `npm run why -- djinni:850653` | everything stored about one vacancy |

## Tuning

- Too much noise → raise `scoring.notifyThreshold`, add `filters.titleStopWords`.
- Too little → lower the threshold (already-rated vacancies are promoted without re-rating), add feeds.
- `filters.englishMax` drops postings that explicitly ask for more; Claude also estimates the real requirement from the text.
- Feed parameters are Djinni/DOU URL query params; build a search on the site and copy them.
