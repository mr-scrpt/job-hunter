/**
 * Fixed paragraphs about English that the candidate adds to a letter by hand (buttons on the board).
 * The letter is generated without them; the candidate decides per vacancy.
 * They are kept verbatim so their presence can be detected and toggled, and so a rewrite can't soften them.
 */

export const LETTER_NOTES = ['level', 'clarify'] as const;
export type LetterNote = (typeof LETTER_NOTES)[number];

export const NOTE_TEXT: Record<LetterNote, string> = {
  level:
    'Щодо англійської: мій рівень дозволяє читати технічну документацію та вести письмове листування, але досвіду живого спілкування англійською в мене немає.',
  clarify:
    'Підкажіть, будь ласка, який рівень англійської потрібен на цій позиції: чи передбачені дзвінки англійською, чи достатньо читати документацію та листуватися?',
};

const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/** Notes present in the letter, in canonical order. */
export const notesIn = (letter: string): LetterNote[] => LETTER_NOTES.filter((n) => letter.includes(NOTE_TEXT[n]));

/** The letter without any note text; untouched when there is none. */
export function stripNotes(letter: string): string {
  if (notesIn(letter).length === 0) return letter;
  let out = letter;
  for (const note of LETTER_NOTES) out = out.split(NOTE_TEXT[note]).join('');
  return out
    .split(PARAGRAPH_BREAK)
    .map((p) => p.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** A bare signature line ("Дмитро"): the notes go above the closing line, not between it and the name. */
const isSignatureOnly = (p: string): boolean => !p.includes('\n') && p.length <= 40 && !/[.!?…]/.test(p);

/** The letter with exactly `notes`, as one paragraph before the closing one ("Буду радий поспілкуватися…"). */
export function withNotes(letter: string, notes: Iterable<LetterNote>): string {
  const wanted = new Set(notes);
  const base = stripNotes(letter);
  const text = LETTER_NOTES.filter((n) => wanted.has(n))
    .map((n) => NOTE_TEXT[n])
    .join(' ');
  if (!text) return base;

  const paragraphs = base.split(PARAGRAPH_BREAK).filter((p) => p.trim());
  if (paragraphs.length < 2) return [base.trim(), text].filter(Boolean).join('\n\n');
  let at = paragraphs.length - 1;
  if (at > 1 && isSignatureOnly(paragraphs[at]!)) at -= 1;
  paragraphs.splice(at, 0, text);
  return paragraphs.join('\n\n');
}

export const toggleNote = (letter: string, note: LetterNote, on: boolean): string => {
  const current = new Set(notesIn(letter));
  if (on) current.add(note);
  else current.delete(note);
  return withNotes(letter, current);
};
