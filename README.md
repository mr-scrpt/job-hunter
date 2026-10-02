# job-hunter

Personal job-search assistant for the Ukrainian IT market.

Every 10 minutes (configurable, quiet at night) it reads the Djinni and DOU vacancy feeds and the Robota.ua API, drops what clearly doesn't fit, asks Claude to rate the rest against the CV and writes a tailored cover letter (in Ukrainian) for the good ones. They land on a **web board** — Fullstack / Backend / Frontend columns, best match first, a day calendar on top — and Telegram sends a short "🔔 3 новые вакансии" with a link. You open a vacancy, tweak the letter by chatting with Claude right there, copy it, apply on the site and press "✅ Откликнулся".

Applying itself stays manual on purpose: DOU forbids automated applications, and a human glance per vacancy keeps the quality up.

## How it works

```
RSS (Djinni, DOU), API (Robota.ua) ──► rules filter ──► page enrichment ──► rules again ──► cross-board dedupe
                       (age, title       (Djinni: company,     (English,
                        stop-words,       salary, English)      salary, remote)
                        company)
        ──► Claude: assess (score, role, AI focus, English) ──► below threshold → archived
                                                         └──► Claude: letter ──► web board + Telegram ping
```

- **Claude** runs through the local `claude -p` CLI, billed to the logged-in subscription — no API key. Calls are isolated: no tools, no user settings/hooks/MCP, no session files, strict JSON schema output.
- **State** lives in SQLite (`data/job-hunter.db`): every vacancy with its status and reason, plus an event log. Each vacancy is assessed once; runs are idempotent and guarded by a lock.
- **Budget**: at most `scoring.maxAssessPerRun` assessments per run, newest first; the rest wait. If Claude hits the subscription limit the run stops and resumes next time.

Statuses: `new → filtered | duplicate | low | ready → notified (on the board) → applied | skipped` (`error` retries up to 3 times). On the board these are "Новые", "Откликнулся", "Не интересно"; any decision can be undone.

## Layout

```
src/core/          pure logic: pipeline, filters, board model, user actions (decide/regenerate/chat), letter guard, ports
src/schemas/       zod schemas: profile, vacancy, assessment, CEFR
src/adapters/      sources (djinni, dou, robota, rss, http), llm (claude-cli), store (sqlite), telegram (notifications), web (Hono API + static)
web/               the board: React + Tailwind, built by Vite into web/dist and served by the same process
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
npm run build                                         # the web board
npm run scan -- --limit 5                             # one run
npm run serve                                         # board + notifications + scheduled scans
npm run link                                          # the board URL with its access key
```

Frontend work: `npm run serve` in one terminal, `npm run dev:web` in another (Vite with hot reload, `/api` proxied to :8790).

### Web board

One process serves the API and the built page on `web.port` (8790), on all interfaces of the LAN.

- **Access**: a random key is created on first run in `~/.local/share/secrets/job-hunter-web.key`. Open the board once via the link with `?k=<key>` (the bot's `/open` sends it); the browser then keeps a year-long cookie. Without the key every page and API call answers 401.
- **Layout**: on a wide screen three columns (Fullstack, Backend, Frontend; "Другое" below when Claude can't place a role). On a phone one column at a time with tabs. In each column: vacancies within your English first, then a divider "Английский выше A2" and the rest. Inside each group, by score.
- **Calendar**: the strip on top shows the last days with how many vacancies were published each day and a blue badge for the ones still undecided. Opens on today when there is something new today, otherwise on all days.
- **Filters**: Новые / Откликнулся / Не интересно / Все.
- **A vacancy**: the side panel (full screen on a phone) has Claude's take (summary, pluses, minuses), the contact fields for the application form (tap to copy; the phone is copied without +380), the letter with copy and "Другой вариант", and a chat: "короче", "добавь про NestJS" rewrite the letter; "что за компания?" gets an answer. Actions stay pinned to the bottom. After "Откликнулся" or "Не интересно" the panel moves to the next undecided vacancy, and the toast offers "Отменить".
- **Add by link**: a Djinni / DOU / Robota.ua URL is fetched, assessed and given a letter regardless of filters.
- **Проверить**: runs a scan now. The board refreshes every minute and when the tab comes back to the foreground.

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Save the token to `~/.local/share/secrets/job-hunter.token` (`chmod 600`). Never commit it.
3. Start the service, then send `/start` to the bot — the first chat that does it becomes the owner; everyone else is ignored.

The bot only notifies: one message per batch of new vacancies with the count per section, the top three and the board link. Commands: `/open` (the link), `/scan`, `/stats`. Without a token the board works on its own.

```sh
ln -sf "$PWD/deploy/systemd/job-hunter.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now job-hunter
journalctl --user -u job-hunter -f
```

### Always-on host

Production runs on the Proxmox VM `claude-station` (ssh alias `station`, user `arch`), so scans continue while the workstation is off.

- First time: copy the personal files that are not in git — `config/profile.yaml`, the CV (path from the profile), `~/.local/share/secrets/job-hunter.token` — and enable lingering (`loginctl enable-linger`) so the user service runs without a login.
- Claude on the box: an interactive `claude` → `/login` is enough while the box keeps running (the CLI refreshes its own token). If it stays idle long enough for the refresh token to lapse, scans stop and the bot sends "⚠️ Claude недоступен" (every 6 h) — log in again. More robust alternative: `claude setup-token` (1-year token) stored as `CLAUDE_CODE_OAUTH_TOKEN=...` in `~/.local/share/secrets/claude-oauth.env` (mode 600); the unit loads it.
- Updates: commit, then `deploy/deploy.sh` (pushes HEAD to the `station` remote, `npm ci`, builds the board, tests, restarts the unit).
- Board: `http://192.168.1.63:8790` (set `web.publicUrl` in the profile so Telegram links use it).
- Only one bot may poll Telegram per token: stop the service on the workstation before starting it elsewhere.

## CLI

| command | what |
|---|---|
| `npm run scan [-- --limit N]` | one pipeline run |
| `npm run serve` | board + bot + scheduled scans (what the service runs) |
| `npm run link` | the board URL with its access key |
| `npm run stats` | counters |
| `npm run show [-- 10 low]` | top vacancies by score, any status list (`ready,notified`, `low`, …) |
| `npm run why -- djinni:850653` | everything stored about one vacancy |
| `node src/cli.ts relint` | regenerate open letters that mention `candidate.neverMention` terms |

## Tuning

- `candidate.neverMention`: employers, clients and industries that must never appear in a letter. The model gets the list, every letter is checked, and a slip is sent back for a targeted fix (letter is rejected after 2 failed fixes).

- Too much noise → raise `scoring.notifyThreshold`, add `filters.titleStopWords`.
- Too little → lower the threshold (already-rated vacancies are promoted without re-rating), add feeds.
- English has two levels. `candidate.englishLevel` is what you actually have; `filters.englishMax` is the hard ceiling. Vacancies needing more than the ceiling are dropped; those between the two stay on the board with "⚠️ EN B2", below the divider in their column. The requirement is the stricter of what the page states and what Claude reads from the text (calls, English-speaking team → at least B1).
- Relaxing `englishMax` brings back vacancies rejected only for English (if still fresh) and re-assesses them.
- Filter changes apply to the board too: on the next scan, undecided vacancies that no longer pass are removed and the bot says which and why. Links you pasted yourself are never removed.
- Feed parameters are Djinni/DOU URL query params (build a search on the site and copy them) and Robota.ua `/vacancy/search` params (`keyWords`, `scheduleId: 3` = remote).
- Work.ua is not supported: it sits behind a Cloudflare bot challenge and has no feed or API.
