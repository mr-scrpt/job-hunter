import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnglishRequirement } from '../src/core/english.ts';
import { containsWord, matchKey, rejectReason } from '../src/core/filter.ts';
import { decodeEntities, htmlToText } from '../src/core/text.ts';
import { parseCefr } from '../src/schemas/cefr.ts';
import { ProfileSchema } from '../src/schemas/profile.ts';
import type { Vacancy } from '../src/schemas/vacancy.ts';

const NOW = new Date('2026-10-01T10:00:00Z');

const vacancy = (over: Partial<Vacancy> = {}): Vacancy => ({
  key: 'djinni:1',
  source: 'djinni',
  externalId: '1',
  url: 'https://djinni.co/jobs/1-x/',
  title: 'Senior Node.js Developer',
  company: 'Acme',
  description: 'Node.js, TypeScript',
  publishedAt: new Date('2026-09-30T10:00:00Z'),
  meta: {},
  ...over,
});

const filters = ProfileSchema.shape.filters.parse({
  englishMax: 'B1',
  minSalaryUsd: 2000,
  titleStopWords: ['PHP', 'QA', '.NET', 'Junior'],
  excludeCompanies: ['EPAM'],
});

describe('rejectReason', () => {
  it('passes a matching vacancy', () => assert.equal(rejectReason(vacancy(), filters, NOW), null));
  it('drops old postings', () => assert.equal(rejectReason(vacancy({ publishedAt: new Date('2026-09-20T00:00:00Z') }), filters, NOW), 'old:11d'));
  it('matches stop words as whole words only', () => {
    assert.equal(rejectReason(vacancy({ title: 'PHP Developer' }), filters, NOW), 'title:PHP');
    assert.equal(rejectReason(vacancy({ title: 'Senior .NET Engineer' }), filters, NOW), 'title:.NET');
    assert.equal(rejectReason(vacancy({ title: 'Junior/Middle React' }), filters, NOW), 'title:Junior');
    assert.equal(rejectReason(vacancy({ title: 'Squad Lead (Node.js)' }), filters, NOW), null); // "QA" inside "Squad"
  });
  it('drops excluded companies', () => assert.equal(rejectReason(vacancy({ company: 'EPAM Systems' }), filters, NOW), 'company:EPAM'));
  it('drops English above the max but keeps unknown', () => {
    assert.equal(rejectReason(vacancy({ meta: { english: 'B2' } }), filters, NOW), 'english:B2');
    assert.equal(rejectReason(vacancy({ meta: { english: 'B1' } }), filters, NOW), null);
  });
  it('drops low published salary, keeps unknown', () => {
    assert.equal(rejectReason(vacancy({ meta: { salaryMaxUsd: 1000 } }), filters, NOW), 'salary:1000');
    assert.equal(rejectReason(vacancy({ meta: { salaryMinUsd: 3000 } }), filters, NOW), null);
  });
  it('drops office-only when remote is required', () =>
    assert.equal(rejectReason(vacancy({ meta: { remote: false } }), filters, NOW), 'not-remote'));
});

describe('containsWord', () => {
  it('handles Cyrillic boundaries', () => {
    assert.equal(containsWord('Дизайнер інтерфейсів', 'Дизайнер'), true);
    assert.equal(containsWord('Дизайнери', 'Дизайнер'), false);
  });
});

describe('matchKey', () => {
  it('normalizes company and title', () =>
    assert.equal(matchKey(vacancy({ company: 'Acme, Inc.', title: 'Senior  Node.js Developer!' })), 'acme inc|senior node js developer'));
  it('is null without a company', () => assert.equal(matchKey(vacancy({ company: null })), null));
});

describe('English parsing', () => {
  it('reads CEFR codes, including Cyrillic look-alikes', () => {
    assert.equal(parseCefr('Англійська В2'), 'B2');
    assert.equal(parseCefr('B2B product'), undefined);
  });
  it('reads requirements near the word English only', () => {
    assert.equal(parseEnglishRequirement('• English: Upper-Intermediate+'), 'B2');
    assert.equal(parseEnglishRequirement('Англійська на рівні Intermediate'), 'B1');
    assert.equal(parseEnglishRequirement('Advanced React skills. Good English (B2).'), 'B2');
    assert.equal(parseEnglishRequirement('Advanced React skills, B2B SaaS'), undefined);
    assert.equal(parseEnglishRequirement('English B1, ideally C1 for client calls with English speakers'), 'C1');
  });
});

describe('text', () => {
  it('decodes double-escaped entities', () => assert.equal(decodeEntities('Webflow &amp;amp; React &#8212; ok'), 'Webflow & React — ok'));
  it('turns HTML into readable text', () =>
    assert.equal(htmlToText('<p>Вимоги:</p><ul><li>React</li><li>Node&nbsp;20</li></ul><p>&nbsp;</p><p>Ok</p>'), 'Вимоги:\n\n• React\n• Node 20\n\nOk'));
});
