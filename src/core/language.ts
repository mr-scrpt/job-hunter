/** Language of a vacancy text, for a tag on the board. Deterministic, no model call. */

export type TextLanguage = 'uk' | 'ru' | 'en';

export interface LanguageInfo {
  /** Dominant language. */
  main: TextLanguage;
  /** A sizeable part in the other language (e.g. a Ukrainian posting with an English requirements block). */
  mixed: boolean;
}

const WORD = /\p{L}{2,}/gu;
const CYRILLIC = /\p{Script=Cyrillic}/u;
/** Letters that exist only in one of the two alphabets. */
const UKRAINIAN_ONLY = /[іїєґ]/giu;
const RUSSIAN_ONLY = /[ыэъё]/giu;

/**
 * English is measured by function words, not by Latin script: Ukrainian postings are full of Latin tech terms
 * (TypeScript, Node.js, an English job title) that are not English prose. In English prose roughly 40% of words
 * are function words, so their count × 2.5 estimates the English part.
 */
const ENGLISH_FUNCTION_WORDS = new Set(
  (
    'the a an and or but of to in on at for with from by as is are was were be been will would can could should ' +
    'we you our your they their it its this that these those who which what how if not no have has do does ' +
    'about into over within across per than more most also all any each other such only us he she him her them'
  ).split(' '),
);
const PROSE_PER_FUNCTION_WORD = 2.5;
/** Each side needs at least this share of the text to call it bilingual. */
const MIXED_MIN_SHARE = 0.2;

export function detectLanguage(text: string): LanguageInfo {
  const words = text.match(WORD) ?? [];
  const cyrillic = words.filter((w) => CYRILLIC.test(w)).length;
  const english = words.filter((w) => ENGLISH_FUNCTION_WORDS.has(w.toLowerCase())).length * PROSE_PER_FUNCTION_WORD;
  const total = cyrillic + english;
  if (total === 0) return { main: 'en', mixed: false };

  const cyrillicShare = cyrillic / total;
  const mixed = Math.min(cyrillicShare, 1 - cyrillicShare) >= MIXED_MIN_SHARE;
  if (cyrillicShare < 0.5) return { main: 'en', mixed };
  const uk = text.match(UKRAINIAN_ONLY)?.length ?? 0;
  const ru = text.match(RUSSIAN_ONLY)?.length ?? 0;
  return { main: ru > uk ? 'ru' : 'uk', mixed };
}
