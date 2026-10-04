import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqliteStore } from '../src/adapters/store/sqlite.ts';
import { chatAboutVacancy, regenerateLetter, setLetterNote } from '../src/core/actions.ts';
import { toBoardItem } from '../src/core/board.ts';
import { detectLanguage } from '../src/core/language.ts';
import { NOTE_TEXT, notesIn, stripNotes, toggleNote, withNotes } from '../src/core/letter-notes.ts';
import type { Llm } from '../src/core/ports.ts';
import type { Assessment } from '../src/schemas/assessment.ts';
import type { Vacancy } from '../src/schemas/vacancy.ts';

const LETTER = ['Добрий день!', 'Я Fullstack TypeScript-розробник, 8+ років.', 'На останньому проєкті будував NestJS-мікросервіси.', 'Буду радий поспілкуватися.\nІван'].join('\n\n');

describe('detectLanguage', () => {
  it('tells Ukrainian, Russian and English apart despite Latin tech words', () => {
    assert.deepEqual(detectLanguage('Шукаємо Senior Node.js розробника. Стек: TypeScript, NestJS, PostgreSQL, Redis. Що пропонуємо: віддалена робота.'), {
      main: 'uk',
      mixed: false,
    });
    assert.deepEqual(detectLanguage('Ищем Senior Node.js разработчика. Стек: TypeScript, NestJS, PostgreSQL. Что предлагаем: удалённая работа, объём задач.'), {
      main: 'ru',
      mixed: false,
    });
    assert.deepEqual(detectLanguage('We are looking for a Senior Node.js Developer to join our team. Remote, Kyiv or Lviv.'), { main: 'en', mixed: false });
  });

  it('flags bilingual postings', () => {
    const uk = 'Ми українська продуктова компанія, що розробляє три цифрові продукти для бізнесу та медицини.';
    const en = 'Requirements: 3+ years with TypeScript and React, experience with REST APIs, good communication skills, ownership mindset, startup background is a plus. We offer remote work, paid vacation, official employment.';
    const info = detectLanguage(`${uk} ${en}`);
    assert.equal(info.mixed, true);
    assert.equal(detectLanguage(uk).mixed, false);
    assert.equal(detectLanguage(en).mixed, false);
  });
});

describe('letter notes', () => {
  it('inserts notes as one paragraph before the closing line, in a fixed order', () => {
    const out = withNotes(LETTER, ['clarify', 'level']);
    const paragraphs = out.split('\n\n');
    assert.equal(paragraphs.length, 5);
    assert.equal(paragraphs[3], `${NOTE_TEXT.level} ${NOTE_TEXT.clarify}`);
    assert.equal(paragraphs[4], 'Буду радий поспілкуватися.\nІван');
    assert.deepEqual(notesIn(out), ['level', 'clarify']);
  });

  it('keeps a standalone signature after the closing line', () => {
    const letter = 'Вітаю!\n\nДосвід з NestJS.\n\nБуду радий поговорити.\n\nДмитро';
    const out = withNotes(letter, ['level']).split('\n\n');
    assert.deepEqual(out.slice(-3), [NOTE_TEXT.level, 'Буду радий поговорити.', 'Дмитро']);
  });

  it('toggles on and off back to the exact original', () => {
    const on = toggleNote(LETTER, 'level', true);
    assert.notEqual(on, LETTER);
    assert.equal(toggleNote(on, 'level', true), on, 'adding twice is a no-op');
    const both = toggleNote(on, 'clarify', true);
    assert.equal(toggleNote(toggleNote(both, 'level', false), 'clarify', false), LETTER);
    assert.equal(stripNotes(LETTER), LETTER, 'a letter without notes is untouched');
  });
});

const assessment: Assessment = {
  score: 70,
  verdict: 'apply',
  role: 'backend',
  aiFocus: 'none',
  englishRequired: 'unknown',
  pros: [],
  cons: [],
  summary: '',
};

function seeded(description: string, meta: Vacancy['meta'] = {}) {
  const store = new SqliteStore(':memory:');
  const v: Vacancy = {
    key: 'djinni:1',
    source: 'djinni',
    externalId: '1',
    url: 'https://djinni.co/jobs/1/',
    title: 'Node.js Developer',
    company: 'Initech',
    description,
    publishedAt: new Date('2026-10-03T10:00:00Z'),
    meta,
  };
  store.insertIfAbsent(v);
  store.update(v.key, { status: 'notified', score: 70, assessment, letter: LETTER });
  return store;
}

describe('notes through actions', () => {
  it('setLetterNote stores the letter and logs it', () => {
    const store = seeded('Шукаємо розробника');
    const letter = setLetterNote(store, 'djinni:1', 'level', true);
    assert.equal(store.get('djinni:1')?.letter, letter);
    assert.deepEqual(notesIn(letter), ['level']);
    assert.equal(store.countEventsSince('note_added', new Date(0)), 1);
  });

  it('regenerate and chat edit the clean letter and keep the chosen notes', async () => {
    const store = seeded('Шукаємо розробника');
    setLetterNote(store, 'djinni:1', 'clarify', true);
    const seen: string[] = [];
    const llm = {
      writeLetter: async (input: { previousLetter?: string }) => {
        seen.push(input.previousLetter ?? '');
        return 'Вітаю!\n\nНовий текст.\n\nДо зв’язку.\nІван';
      },
      chat: async (input: { letter: string }) => {
        seen.push(input.letter);
        return { reply: 'Сократил.', letter: 'Вітаю!\n\nКоротко.\n\nДо зв’язку.\nІван' };
      },
    } as unknown as Llm;
    const wb = { store, llm, resume: '', candidateName: 'Іван', neverMention: [] };

    const regenerated = await regenerateLetter(wb, 'djinni:1');
    assert.deepEqual(notesIn(regenerated), ['clarify']);
    const chatted = await chatAboutVacancy(wb, 'djinni:1', 'короче');
    assert.deepEqual(notesIn(chatted.letter!), ['clarify']);
    assert.ok(seen.every((text) => !text.includes(NOTE_TEXT.clarify)), 'the model never sees the note');
  });
});

describe('board item language fields', () => {
  it('marks English postings without a stated level as unclear', () => {
    const store = seeded('We are looking for a Node.js developer to build our payments platform. Remote.');
    const item = toBoardItem(store.get('djinni:1')!, 'A2')!;
    assert.equal(item.language, 'en');
    assert.equal(item.englishUnclear, true);
  });

  it('a stated level or a Ukrainian text is not unclear', () => {
    const withLevel = toBoardItem(seeded('We are looking for a Node.js developer. Remote.', { english: 'B2' }).get('djinni:1')!, 'A2')!;
    assert.equal(withLevel.englishUnclear, false);
    assert.equal(withLevel.stretch, true);
    const ukrainian = toBoardItem(seeded('Шукаємо Node.js розробника в продуктову команду, віддалено.').get('djinni:1')!, 'A2')!;
    assert.equal(ukrainian.language, 'uk');
    assert.equal(ukrainian.englishUnclear, false);
  });
});
