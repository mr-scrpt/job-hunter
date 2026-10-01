import { createApp, formatReport, formatStats } from './app.ts';
import { createBot } from './adapters/telegram/bot.ts';
import { orderQueue, renderDeck } from './core/deck.ts';
import { findForbiddenTerms, writeCheckedLetter } from './core/letter.ts';
import { addFromUrl, deliverReady, runScan } from './core/pipeline.ts';
import { decodeEntities } from './core/text.ts';
import type { Status } from './core/ports.ts';

const USAGE = `job-hunter <command>

  scan [--limit N]   fetch feeds, filter, assess with Claude, deliver cards
  bot                Telegram bot + scheduled scans (long-running)
  stats              counters
  show [N] [status]  print the N best cards to the terminal (default: 5, ready+notified)
  why <key>          show stored data for one vacancy, e.g. why djinni:850653
  relint             rewrite open letters that mention candidate.neverMention terms`;

const htmlToTerminal = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, ''));

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
      const report = await runScan(app.pipeline({ profile: scoped }));
      console.log(formatReport(report));
      if (!app.telegram) console.log('\nTelegram не настроен — вакансии лежат в базе, смотри `npm run show`.');
      break;
    }

    case 'stats':
      console.log(formatStats(store));
      break;

    case 'show': {
      const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
      const statuses = (args.find((a) => !/^\d+$/.test(a))?.split(',') ?? ['ready', 'notified']) as Status[];
      const items = orderQueue(store.listByStatus(statuses)).slice(0, count);
      items.forEach((v, index) =>
        console.log(`${'─'.repeat(70)}\n${v.key}\n${htmlToTerminal(renderDeck({ queue: items, index }).html)}\n`),
      );
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
      // Open cards whose letters mention a term from candidate.neverMention get a fresh letter, edited in place.
      const terms = profile.candidate.neverMention;
      const open = store.listByStatus(['ready', 'notified']).filter((v) => v.letter && v.assessment);
      const dirty = open.filter((v) => findForbiddenTerms(v.letter!, terms).length > 0);
      console.log(`Открытых карточек: ${open.length}, с запрещёнными словами: ${dirty.length}`);
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
      if (dirty.length && app.telegram) await app.telegram.deck.show();
      break;
    }

    case 'bot': {
      if (!app.telegram) throw new Error('No bot token: put it into ~/.local/share/secrets/job-hunter.token (or JOB_HUNTER_TG_TOKEN).');
      const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
      const scan = async (): Promise<string> => formatReport(await runScan(app.pipeline({ log })));

      const bot = createBot({
        bot: app.telegram.bot,
        deck: app.telegram.deck,
        store,
        llm: app.llm,
        candidateName: profile.candidate.name,
        neverMention: profile.candidate.neverMention,
        resume: app.resume,
        scan,
        stats: () => formatStats(store),
        addFromUrl: (url) => addFromUrl(app.pipeline({ log }), url),
        onBound: () => deliverReady(store, app.notifier, log),
        log,
      });
      await bot.api.setMyCommands([
        { command: 'list', description: 'Вакансии на разбор' },
        { command: 'scan', description: 'Проверить вакансии сейчас' },
        { command: 'stats', description: 'Статистика' },
        { command: 'help', description: 'Что я умею' },
      ]);

      const intervalMs = profile.bot.scanIntervalMinutes * 60_000;
      let timer: NodeJS.Timeout | undefined;
      const tick = async (): Promise<void> => {
        try {
          if (inQuietHours(profile.bot.quietHours)) {
            // Still flush cards produced earlier (e.g. by a manual /scan) — nothing new is fetched.
            await deliverReady(store, app.notifier, log);
          } else {
            log(`scheduled scan\n${await scan()}`);
          }
        } catch (error) {
          log(`scheduled scan failed: ${String(error)}`);
        } finally {
          timer = setTimeout(tick, intervalMs);
        }
      };
      if (intervalMs > 0) timer = setTimeout(tick, 10_000);

      const stop = async (): Promise<void> => {
        clearTimeout(timer);
        await bot.stop();
        store.close();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      log(`bot started; scans every ${profile.bot.scanIntervalMinutes} min, quiet hours ${profile.bot.quietHours || 'none'}`);
      await bot.start({ drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] });
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
