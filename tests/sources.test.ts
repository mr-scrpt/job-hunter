import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { djinniItemToVacancy, parseDjinniJobPage } from '../src/adapters/sources/djinni.ts';
import { douItemToVacancy, parseDouTitle } from '../src/adapters/sources/dou.ts';
import { buildUrl } from '../src/adapters/sources/http.ts';
import { parseRss } from '../src/adapters/sources/rss.ts';

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

describe('djinni', () => {
  it('maps RSS items to vacancies', () => {
    const items = parseRss(fixture('djinni-rss.xml'));
    assert.equal(items.length, 2);
    const v = djinniItemToVacancy(items[0]!);
    assert.ok(v);
    assert.equal(v.key, 'djinni:850824');
    assert.equal(v.source, 'djinni');
    assert.equal(v.title, 'Front-end Developer (Верстальник)');
    assert.equal(v.company, null);
    assert.match(v.description, /• Досвід роботи від 6 місяців/);
    assert.doesNotMatch(v.description, /<p>|&nbsp;/);
    assert.equal(v.publishedAt.toISOString(), '2026-09-29T15:42:27.000Z');
  });

  it('reads company, salary, English and applicants from the job page', () => {
    const page = parseDjinniJobPage(fixture('djinni-job.html'));
    assert.equal(page.company, 'Office.kh.ua');
    assert.deepEqual(page.meta, {
      salaryMinUsd: 400,
      salaryMaxUsd: 1000,
      experienceYears: 1,
      remote: true,
      english: 'B2',
      applicants: 54,
    });
  });
});

describe('dou', () => {
  it('splits "title в company, salary, city, remote"', () => {
    assert.deepEqual(parseDouTitle('Senior Full-Stack Developer в NDA Recruitment, $3500–5000, Київ'), {
      title: 'Senior Full-Stack Developer',
      company: 'NDA Recruitment',
      meta: { salaryMinUsd: 3500, salaryMaxUsd: 5000, locations: ['Київ'], remote: false },
    });
    assert.deepEqual(parseDouTitle('Software Engineer — AI agents в Wildix, віддалено'), {
      title: 'Software Engineer — AI agents',
      company: 'Wildix',
      meta: { remote: true },
    });
    assert.deepEqual(parseDouTitle('Lead в Acme, до $4000, Львів, за кордоном, віддалено').meta, {
      salaryMaxUsd: 4000,
      remote: true,
      locations: ['Львів', 'за кордоном'],
    });
  });

  it('uses the last " в " so titles containing "в" survive', () => {
    assert.equal(parseDouTitle('Розробник в команду AI в Acme, віддалено').company, 'Acme');
  });

  it('maps RSS items and strips tracking params', () => {
    const vacancies = parseRss(fixture('dou-rss.xml')).map(douItemToVacancy);
    assert.equal(vacancies.length, 2);
    const nda = vacancies.find((v) => v?.company === 'NDA Recruitment');
    assert.ok(nda);
    assert.equal(nda.key, 'dou:368144');
    assert.equal(nda.url, 'https://jobs.dou.ua/companies/nda-recruitment/vacancies/368144/');
    assert.equal(nda.meta.salaryMaxUsd, 5000);
  });
});

describe('buildUrl', () => {
  it('repeats array params and lets feed params override common ones', () => {
    const url = buildUrl('https://djinni.co/jobs/rss/', { primary_keyword: 'X' }, { primary_keyword: 'Node.js', english_level: ['pre', 'intermediate'] });
    assert.equal(url, 'https://djinni.co/jobs/rss/?primary_keyword=Node.js&english_level=pre&english_level=intermediate');
  });
});
