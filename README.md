# job-hunter

Personal job-search assistant for the Ukrainian IT market.

Every 10 minutes (configurable, quiet at night) it reads the Djinni and DOU vacancy feeds, drops what clearly doesn't fit, asks Claude to rate the rest against the CV, writes a tailored cover letter (in Ukrainian) for the good ones and queues them in a single Telegram message you browse with ◀️ ▶️. You read the vacancy, tweak the letter by just writing in the chat, copy it, apply on the site and press "✅ Отправил".

Applying itself stays manual on purpose: DOU forbids automated applications, and a human glance per vacancy keeps the quality up.

## How it works

```
RSS (Djinni, DOU) ──► rules filter ──► page enrichment ──► rules again ──► cross-board dedupe
                       (age, title       (Djinni: company,     (English,
                        stop-words,       salary, English)      salary, remote)
                        company)
        ──► Claude: assess (score, role, AI focus, English) ──► below threshold → archived
                                                         └──► Claude: letter ──► Telegram deck
```

- **Claude** runs through the local `claude -p` CLI, billed to the logged-in subscription — no API key. Calls are isolated: no tools, no user settings/hooks/MCP, no session files, strict JSON schema output.
- **State** lives in SQLite (`data/job-hunter.db`): every vacancy with its status and reason, plus an event log. Each vacancy is assessed once; runs are idempotent and guarded by a lock.
- **Budget**: at most `scoring.maxAssessPerRun` assessments per run, newest first; the rest wait. If Claude hits the subscription limit the run stops and resumes next time.

Statuses: `new → filtered | duplicate | low | ready → notified (in the deck) → applied | skipped` (`error` retries up to 3 times).

## Layout

```
src/core/          pure logic: pipeline, filters, deck (queue/cursor/render), letter guard, ports
src/schemas/       zod schemas: profile, vacancy, assessment, CEFR
src/adapters/      sources (djinni, dou, rss, http), llm (claude-cli), store (sqlite), telegram
prompts/           system prompts: assess, letter, chat — tune them freely
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
npm run show                                          # print the best vacancies with letters
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

### Using the bot

All vacancies waiting for a decision live in **one message** (the deck): `Вакансия 2 из 5`, best match first.

- ◀️ ▶️ — browse; ✅ Отправил / ⏭ Пропустить — take the current one off the queue (the next one shows up);
- 🎲 Другой вариант — a fresh take on the letter; 🔗 Открыть — the vacancy page;
- **any text** in the chat goes to Claude about the vacancy on screen: "короче", "добавь про NestJS" rewrites the letter (the deck updates in place); "что за компания?" gets an answer as a separate message. The last 10 turns per vacancy are remembered;
- **a Djinni/DOU link** — fetched, assessed and given a letter regardless of filters, then opened in the deck;
- new vacancies from scans arrive as one batch: the deck is re-posted at the bottom with "🔔 3 новые вакансии".

Commands: `/list` (re-post the deck at the bottom), `/scan`, `/stats`, `/help`.

### Always-on host

Production runs on the Proxmox VM `claude-station` (ssh alias `station`, user `arch`), so scans continue while the workstation is off.

- First time: copy the personal files that are not in git — `config/profile.yaml`, the CV (path from the profile), `~/.local/share/secrets/job-hunter.token` — and enable lingering (`loginctl enable-linger`) so the user service runs without a login.
- Claude on the box: an interactive `claude` → `/login` is enough while the box keeps running (the CLI refreshes its own token). If it stays idle long enough for the refresh token to lapse, scans stop and the deck shows "⚠️ Claude недоступен" (every 6 h) — log in again. More robust alternative: `claude setup-token` (1-year token) stored as `CLAUDE_CODE_OAUTH_TOKEN=...` in `~/.local/share/secrets/claude-oauth.env` (mode 600); the unit loads it.
- Updates: commit, then `deploy/deploy.sh` (pushes HEAD to the `station` remote, `npm ci`, tests, restarts the unit).
- Only one bot may poll Telegram per token: stop the service on the workstation before starting it elsewhere.

## CLI

| command | what |
|---|---|
| `npm run scan [-- --limit N]` | one pipeline run |
| `npm run bot` | bot + scheduled scans (what the service runs) |
| `npm run stats` | counters |
| `npm run show [-- 10 low]` | top vacancies by score, any status list (`ready,notified`, `low`, …) |
| `npm run why -- djinni:850653` | everything stored about one vacancy |
| `node src/cli.ts relint` | regenerate open letters that mention `candidate.neverMention` terms, refresh the deck |

## Tuning

- `candidate.neverMention`: employers, clients and industries that must never appear in a letter. The model gets the list, every letter is checked, and a slip is sent back for a targeted fix (letter is rejected after 2 failed fixes).

- Too much noise → raise `scoring.notifyThreshold`, add `filters.titleStopWords`.
- Too little → lower the threshold (already-rated vacancies are promoted without re-rating), add feeds.
- `filters.englishMax` drops postings that explicitly ask for more; Claude also estimates the real requirement from the text (calls, English-speaking team → at least B1).
- Filter changes apply to the queue too: on the next scan, queued vacancies that no longer pass are removed and the deck says which and why. Links you pasted yourself are never removed.
- Feed parameters are Djinni/DOU URL query params; build a search on the site and copy them.
