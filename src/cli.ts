import { createApp, formatReport, formatStats } from './app.ts';
import { createBot } from './adapters/telegram/bot.ts';
import { renderCard } from './core/card.ts';
import { deliverReady, runScan } from './core/pipeline.ts';
import { decodeEntities } from './core/text.ts';
import type { Status } from './core/ports.ts';

const USAGE = `job-hunter <command>

  scan [--limit N]   fetch feeds, filter, assess with Claude, deliver cards
  bot                Telegram bot + scheduled scans (long-running)
  stats              counters
  show [N] [status]  print the N best cards to the terminal (default: 5, ready+notified)
  why <key>          show stored data for one vacancy, e.g. why djinni:850653`;

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
      if (!app.token) console.log('\nTelegram не настроен — карточки лежат в базе, смотри `npm run show`.');
      break;
    }

    case 'stats':
      console.log(formatStats(store));
      break;

    case 'show': {
      const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
      const statuses = (args.find((a) => !/^\d+$/.test(a))?.split(',') ?? ['ready', 'notified']) as Status[];
      const items = store
        .listByStatus(statuses)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, count);
      for (const v of items) console.log(`${'─'.repeat(70)}\n${v.key}\n${htmlToTerminal(renderCard(v).html)}\n`);
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

    case 'bot': {
      if (!app.token) throw new Error('No bot token: put it into ~/.local/share/secrets/job-hunter.token (or JOB_HUNTER_TG_TOKEN).');
      const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
      const scan = async (): Promise<string> => formatReport(await runScan(app.pipeline({ log })));

      const bot = createBot({
        token: app.token,
        store,
        llm: app.llm,
        candidateName: profile.candidate.name,
        resume: app.resume,
        scan,
        stats: () => formatStats(store),
        onBound: () => deliverReady(store, app.notifier, log),
        log,
      });
      await bot.api.setMyCommands([
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
