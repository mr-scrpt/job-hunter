import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { ActionError, chatAboutVacancy, decide, KeyedLock, regenerateLetter, setLetterNote, type Workbench } from '../../core/actions.ts';
import { LETTER_NOTES } from '../../core/letter-notes.ts';
import { BOARD_STATUSES, buildBoardItems, kyivDay, toBoardItem, type Board } from '../../core/board.ts';
import type { Cefr } from '../../schemas/cefr.ts';
import type { StoredVacancy } from '../../core/ports.ts';

export interface WebDeps extends Workbench {
  englishLevel: Cefr;
  contact: Board['contact'];
  scanIntervalMinutes: number;
  /** Shared secret from the board link (?k=...); stored in a cookie after the first visit. */
  accessKey: string;
  /** Built client (vite outDir); the API still works without it. */
  staticDir: string;
  /** Starts a scan unless one is running; resolves when it's done. */
  scan: () => Promise<string>;
  isScanning: () => boolean;
  addFromUrl: (url: string) => Promise<StoredVacancy>;
  /** Board items older than this are left out (applied/skipped history keeps the DB small to read). */
  historyDays?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

const COOKIE = 'jh_key';
/** Wrong keys per client per window before it is locked out until the window ends. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
const DecisionBody = z.object({ decision: z.enum(['open', 'applied', 'skipped']) });
const ChatBody = z.object({ message: z.string().trim().min(1).max(2000) });
const AddBody = z.object({ url: z.url() });
const NoteBody = z.object({ note: z.enum(LETTER_NOTES), on: z.boolean() });

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createWebApp(deps: WebDeps): Hono {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const lock = new KeyedLock();
  const historyMs = (deps.historyDays ?? 30) * 86_400_000;
  const app = new Hono();

  // Wrong-key attempts per client (Cloudflare passes the real IP; on the LAN it's absent and everyone shares one bucket).
  const failures = new Map<string, { count: number; since: number }>();
  const clientId = (c: Context): string => c.req.header('cf-connecting-ip') ?? 'lan';
  const lockedOut = (id: string, at: number): boolean => {
    const f = failures.get(id);
    if (f && at - f.since > FAILURE_WINDOW_MS) failures.delete(id);
    return (failures.get(id)?.count ?? 0) >= MAX_FAILURES;
  };
  const recordFailure = (id: string, at: number): void => {
    const f = failures.get(id) ?? { count: 0, since: at };
    f.count++;
    failures.set(id, f);
    if (f.count === MAX_FAILURES) log(`web: too many wrong keys from ${id}, locked for ${FAILURE_WINDOW_MS / 60_000} min`);
  };

  // Access: ?k=<key> once (sets a year-long cookie), then the cookie. The board is reachable from the internet through the tunnel.
  app.use('*', async (c, next) => {
    const id = clientId(c);
    const at = now().getTime();
    if (lockedOut(id, at)) return c.text('Слишком много попыток, попробуй позже', 429);
    const fromQuery = c.req.query('k');
    if (fromQuery && !sameSecret(fromQuery, deps.accessKey)) recordFailure(id, at);
    if (fromQuery && sameSecret(fromQuery, deps.accessKey)) {
      // Secure only over https (the tunnel); plain http on the LAN would drop a Secure cookie.
      const secure = c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
      setCookie(c, COOKIE, deps.accessKey, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 365 * 86_400 });
      const url = new URL(c.req.url);
      url.searchParams.delete('k');
      return c.redirect(url.pathname + url.search);
    }
    const cookie = getCookie(c, COOKIE);
    if (cookie && sameSecret(cookie, deps.accessKey)) return next();
    if (cookie) recordFailure(id, at);
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Нет доступа: открой ссылку из Telegram-бота' }, 401);
    return c.html(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Вакансии</title>' +
        '<body style="font:16px system-ui;padding:2rem;max-width:30rem;margin:auto;color:#334155">' +
        '<h1 style="font-size:1.25rem">Нужна ссылка с ключом</h1><p>Открой её из Telegram-бота: команда /open.</p>',
      401,
    );
  });

  const fail = (c: Context, error: unknown) => {
    if (error instanceof ActionError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: 'Неверный запрос' }, 400);
    log(`web error: ${String(error)}`);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  };

  const item = (v: StoredVacancy) => toBoardItem(v, deps.englishLevel);

  app.get('/api/board', (c) => {
    const at = now();
    const since = at.getTime() - historyMs;
    const vacancies = store.listByStatus(BOARD_STATUSES).filter((v) => v.publishedAt.getTime() >= since || v.status === 'notified');
    const last = store.getKv('last_scan');
    const board: Board = {
      items: buildBoardItems(vacancies, deps.englishLevel),
      today: kyivDay(at),
      englishLevel: deps.englishLevel,
      contact: deps.contact,
      lastScanAt: last ? (JSON.parse(last) as { at: string }).at : null,
      scanIntervalMinutes: deps.scanIntervalMinutes,
      scanning: deps.isScanning(),
    };
    return c.json(board);
  });

  app.post('/api/vacancies/:key/decision', async (c) => {
    try {
      const { decision } = DecisionBody.parse(await c.req.json());
      return c.json(item(decide(store, c.req.param('key'), decision)));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/vacancies/:key/regenerate', async (c) => {
    const key = c.req.param('key');
    try {
      const letter = await lock.run(key, () => regenerateLetter(deps, key));
      return c.json({ letter });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/vacancies/:key/note', async (c) => {
    try {
      const { note, on } = NoteBody.parse(await c.req.json());
      return c.json({ letter: setLetterNote(store, c.req.param('key'), note, on) });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get('/api/vacancies/:key/chat', (c) => c.json({ history: store.recentChat(c.req.param('key'), 50) }));

  app.post('/api/vacancies/:key/chat', async (c) => {
    const key = c.req.param('key');
    try {
      const { message } = ChatBody.parse(await c.req.json());
      return c.json(await lock.run(key, () => chatAboutVacancy(deps, key, message)));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/vacancies', async (c) => {
    try {
      const { url } = AddBody.parse(await c.req.json());
      const added = await lock.run(`add:${url}`, () => deps.addFromUrl(url));
      return c.json(item(added));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/scan', (c) => {
    if (deps.isScanning()) return c.json({ started: false });
    void deps.scan().catch((error: unknown) => log(`web scan failed: ${String(error)}`));
    return c.json({ started: true });
  });

  // The built SPA. index.html is not cached so a deploy shows up on reload; hashed assets are.
  if (existsSync(join(deps.staticDir, 'index.html'))) {
    app.use(
      '/assets/*',
      async (c, next) => {
        await next();
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
      serveStatic({ root: deps.staticDir }),
    );
    app.use('*', serveStatic({ root: deps.staticDir }));
    app.get('*', serveStatic({ root: deps.staticDir, path: 'index.html', onFound: (_p, c) => void c.header('Cache-Control', 'no-cache') }));
  }

  return app;
}
