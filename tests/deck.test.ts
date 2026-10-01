import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchor, announcement, decodeDeckCallback, encodeDeckCallback, orderQueue, plural, renderContact, renderDeck, step } from '../src/core/deck.ts';
import type { StoredVacancy } from '../src/core/ports.ts';

const item = (id: string, score: number, over: Partial<StoredVacancy> = {}): StoredVacancy => ({
  key: `djinni:${id}`,
  source: 'djinni',
  externalId: id,
  url: `https://djinni.co/jobs/${id}/`,
  title: `Vacancy ${id}`,
  company: 'Acme',
  description: '',
  publishedAt: new Date('2026-09-30T10:00:00Z'),
  meta: {},
  status: 'notified',
  reason: null,
  attempts: 0,
  enriched: true,
  score,
  assessment: {
    score,
    verdict: 'apply',
    role: 'fullstack',
    aiFocus: 'core',
    englishRequired: 'B1',
    pros: ['NestJS'],
    cons: ['Python'],
    summary: 'AI-команда на TS.',
  },
  letter: 'Добрий день! <тест> & ще',
  ...over,
});

const actions = (rows: ReturnType<typeof renderDeck>['rows']) => rows.map((r) => r.map((b) => (b.kind === 'action' ? b.action : 'url')));

describe('queue order and cursor', () => {
  const queue = orderQueue([item('1', 60), item('2', 90), item('3', 75)]);

  it('puts the best match first', () => assert.deepEqual(queue.map((v) => v.externalId), ['2', '3', '1']));

  it('stays on the same vacancy when the queue changes around it', () => {
    assert.equal(anchor(queue, 'djinni:1', 0), 2);
  });

  it('keeps the position when the focused vacancy left the queue (shows the next one)', () => {
    const after = queue.filter((v) => v.key !== 'djinni:3'); // "applied" on item 2 of 3
    assert.equal(anchor(after, 'djinni:3', 1), 1);
    assert.equal(after[1]?.externalId, '1');
  });

  it('clamps to the last item and to an empty queue', () => {
    assert.equal(anchor(queue, null, 99), 2);
    assert.equal(anchor([], null, 3), 0);
  });

  it('steps within bounds', () => {
    assert.equal(step({ queue, index: 0 }, -1), 0);
    assert.equal(step({ queue, index: 1 }, 1), 2);
    assert.equal(step({ queue, index: 2 }, 1), 2);
  });
});

describe('renderDeck', () => {
  const queue = orderQueue([item('1', 82, { title: 'Senior <AI> Engineer', meta: { salaryMinUsd: 3000, salaryMaxUsd: 4500, remote: true } }), item('2', 70), item('3', 65)]);

  it('shows position, escaped facts and the letter', () => {
    const view = renderDeck({ queue, index: 0 });
    assert.equal(view.focusKey, 'djinni:1');
    assert.match(view.html, /Вакансия 1 из 3/);
    assert.match(view.html, /Senior &lt;AI&gt; Engineer/);
    assert.match(view.html, /\$3000–4500/);
    assert.match(view.html, /<pre>Добрий день! &lt;тест&gt; &amp; ще<\/pre>/);
    assert.match(view.html, /Напиши в чат/);
  });

  it('offers only the navigation that makes sense', () => {
    assert.deepEqual(actions(renderDeck({ queue, index: 0 }).rows)[0], ['next']);
    assert.deepEqual(actions(renderDeck({ queue, index: 1 }).rows)[0], ['prev', 'next']);
    assert.deepEqual(actions(renderDeck({ queue, index: 2 }).rows)[0], ['prev']);
    assert.deepEqual(actions(renderDeck({ queue: [queue[0]!], index: 0 }).rows), [['applied', 'skip'], ['url', 'regen']]);
  });

  it('shows the busy line instead of the chat hint', () => {
    const { html } = renderDeck({ queue, index: 0 }, { busy: 'Думаю…', note: 'Готово' });
    assert.match(html, /⏳ <i>Думаю…<\/i>/);
    assert.match(html, /ℹ️ Готово/);
    assert.doesNotMatch(html, /Напиши в чат/);
  });

  it('keeps the message under Telegram limits with a huge letter', () => {
    const { html } = renderDeck({ queue: [item('9', 80, { letter: 'дуже довгий текст '.repeat(500) })], index: 0 });
    assert.ok(html.length <= 4096, `length ${html.length}`);
    assert.match(html, /…<\/pre>/);
  });

  it('shows contact fields as separate tap-to-copy blocks, before the letter', () => {
    const contact = { fullName: "Іван Петренко", email: 'me@example.com', phone: '+380 00 123 4567' };
    const { html } = renderDeck({ queue, index: 0 }, { contact });
    assert.match(html, /👤 <code>Іван Петренко<\/code>/);
    assert.match(html, /✉️ <code>me@example\.com<\/code>/);
    assert.match(html, /📱 \+380 <code>00 123 4567<\/code>/); // country code outside the copy
    assert.ok(html.indexOf('Для формы') < html.indexOf('<pre>'));
    assert.match(renderContact({ fullName: 'X', phone: '0930503273' }), /📱 <code>0930503273<\/code>/);
    assert.doesNotMatch(renderDeck({ queue, index: 0 }).html, /Для формы/);
  });

  it('renders the empty state', () => {
    const view = renderDeck({ queue: [], index: 0 });
    assert.equal(view.focusKey, null);
    assert.match(view.html, /Все вакансии разобраны/);
    assert.match(renderDeck({ queue: [], index: 0 }, { scanIntervalMinutes: 10 }).html, /каждые 10 минут\./);
    assert.match(renderDeck({ queue: [], index: 0 }, { scanIntervalMinutes: 1 }).html, /каждые 1 минуту\./);
    assert.deepEqual(actions(view.rows), [['refresh']]);
  });
});

describe('deck helpers', () => {
  it('round-trips callbacks', () => {
    assert.equal(decodeDeckCallback(encodeDeckCallback('next')), 'next');
    assert.equal(decodeDeckCallback('a|djinni:1'), undefined); // old per-card buttons
    assert.equal(decodeDeckCallback('d|nope'), undefined);
  });

  it('pluralizes Russian', () => {
    assert.equal(plural(1, ['вакансия', 'вакансии', 'вакансий']), 'вакансия');
    assert.equal(plural(3, ['вакансия', 'вакансии', 'вакансий']), 'вакансии');
    assert.equal(plural(5, ['вакансия', 'вакансии', 'вакансий']), 'вакансий');
    assert.equal(plural(11, ['вакансия', 'вакансии', 'вакансий']), 'вакансий');
    assert.equal(plural(22, ['вакансия', 'вакансии', 'вакансий']), 'вакансии');
  });

  it('announces batches', () => {
    assert.equal(announcement(3, 3), '🔔 3 новые вакансии на разбор.');
    assert.equal(announcement(1, 5), '🔔 1 новая вакансия. Всего в очереди: 5.');
  });
});
