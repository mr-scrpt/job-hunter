import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, formatReport, formatStats, ROOT } from './app.ts';
import { createBot } from './adapters/telegram/bot.ts';
import { createWebApp } from './adapters/web/server.ts';
import { buildBoardItems } from './core/board.ts';
import { findForbiddenTerms, writeCheckedLetter } from './core/letter.ts';
import { addFromUrl, deliverReady, runScan } from './core/pipeline.ts';
import type { Status } from './core/ports.ts';

const USAGE = `job-hunter <command>

  serve              web board + Telegram notifications + scheduled scans (long-running; "bot" is an alias)
  scan [--limit N]   fetch feeds, filter, assess with Claude, publish to the board
  stats              counters
  show [N] [status]  print the N best vacancies (default: 5, open ones)
  why <key>          show stored data for one vacancy, e.g. why djinni:850653
  relint             rewrite open letters that mention candidate.neverMention terms
  link               print the board link (with the access key)`;

function inQuietHours(spec: string, now = new Date()): boolean {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(spec);
  if (!match) return false;
  const from = Number(match[1]);
  const to = Number(match[2]);
  const hour = Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Kyiv' }));
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') return void console.log(USAGE);

  const app = createApp();
  const { store, profile } = app;

  switch (command) {
    case 'scan': {
      const limitArg = args.indexOf('--limit');
      const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
      const scoped = limit ? { ...profile, scoring: { ...profile.scoring, maxAssessPerRun: limit } } : profile;
      console.log(formatReport(await runScan(app.pipeline({ profile: scoped }))));
      break;
    }

    case 'stats':
      console.log(formatStats(store));
      break;

    case 'link':
      console.log(app.boardUrl);
      break;

    case 'show': {
      const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
      const statuses = (args.find((a) => !/^\d+$/.test(a))?.split(',') ?? ['ready', 'notified']) as Status[];
      const items = buildBoardItems(store.listByStatus(statuses), profile.candidate.englishLevel).slice(0, count);
      for (const i of items) {
        const english = i.english ? ` · EN ${i.english}${i.stretch ? ' ⚠️' : ''}` : '';
        console.log(`${'─'.repeat(70)}\n${i.key} · ${i.section} · ${i.score}${english}\n${i.title} — ${i.company ?? '?'}\n${i.url}\n\n${i.letter ?? ''}\n`);
      }
      if (!items.length) console.log('Пусто.');
      break;
    }

    case 'why': {
      const v = args[0] ? store.get(args[0]) : undefined;
      if (!v) throw new Error('usage: why <key>');
      const { description, ...rest } = v;
      console.log(JSON.stringify({ ...rest, description: `${description.slice(0, 600)}…` }, null, 2));
      break;
    }

    case 'relint': {
      // Open vacancies whose letters mention a term from candidate.neverMention get a fresh letter.
      const terms = profile.candidate.neverMention;
      const open = store.listByStatus(['ready', 'notified']).filter((v) => v.letter && v.assessment);
      const dirty = open.filter((v) => findForbiddenTerms(v.letter!, terms).length > 0);
      console.log(`Открытых: ${open.length}, с запрещёнными словами: ${dirty.length}`);
      for (const v of dirty) {
        const letter = await writeCheckedLetter(
          app.llm,
          { vacancy: v, resume: app.resume, candidateName: profile.candidate.name, assessment: v.assessment! },
          terms,
        );
        store.update(v.key, { letter });
        store.log('relinted', v.key);
        console.log(`${'─'.repeat(70)}\n${v.key}\n${letter}\n`);
      }
      break;
    }

    case 'serve':
    case 'bot': {
      const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);

      // One scan at a time in this process, whoever asks (timer, /scan, the web button).
      let scanning: Promise<string> | undefined;
      const scan = (): Promise<string> => {
        scanning ??= runScan(app.pipeline({ log }))
          .then(formatReport)
          .finally(() => (scanning = undefined));
        return scanning;
      };

      const web = createWebApp({
        store,
        llm: app.llm,
        resume: app.resume,
        candidateName: profile.candidate.name,
        neverMention: profile.candidate.neverMention,
        englishLevel: profile.candidate.englishLevel,
        contact: profile.candidate.contact ?? null,
        scanIntervalMinutes: profile.bot.scanIntervalMinutes,
        accessKey: app.accessKey,
        staticDir: join(ROOT, 'web/dist'),
        historyDays: profile.web.historyDays,
        scan,
        isScanning: () => scanning !== undefined,
        addFromUrl: (url) => addFromUrl(app.pipeline({ log }), url),
        log,
      });
      const server = serve({ fetch: web.fetch, hostname: profile.web.host, port: profile.web.port }, (info) =>
        log(`web board on ${info.address}:${info.port} → ${app.boardUrl.replace(/k=.*/, 'k=…')}`),
      );

      const bot = app.bot ? createBot({ bot: app.bot, store, boardUrl: app.boardUrl, scan, stats: () => formatStats(store), log }) : undefined;
      if (bot) {
        await bot.api.setMyCommands([
          { command: 'open', description: 'Открыть вакансии' },
          { command: 'scan', description: 'Проверить вакансии сейчас' },
          { command: 'stats', description: 'Статистика' },
        ]);
      } else {
        log('no Telegram token: notifications are off, the board still works');
      }

      const intervalMs = profile.bot.scanIntervalMinutes * 60_000;
      let timer: NodeJS.Timeout | undefined;
      const tick = async (): Promise<void> => {
        try {
          // Quiet hours: nothing is fetched, but vacancies produced earlier still get published.
          if (inQuietHours(profile.bot.quietHours)) await deliverReady(store, app.notifier, log);
          else log(`scheduled scan\n${await scan()}`);
        } catch (error) {
          log(`scheduled scan failed: ${String(error)}`);
        } finally {
          timer = setTimeout(tick, intervalMs);
        }
      };
      if (intervalMs > 0) timer = setTimeout(tick, 10_000);

      const stop = async (): Promise<void> => {
        clearTimeout(timer);
        await bot?.stop();
        server.close();
        store.close();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      log(`started; scans every ${profile.bot.scanIntervalMinutes} min, quiet hours ${profile.bot.quietHours || 'none'}`);
      if (bot) await bot.start({ drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] });
      break;
    }

    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
