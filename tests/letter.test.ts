import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkedChat, findForbiddenTerms, ForbiddenTermsError, writeCheckedLetter } from '../src/core/letter.ts';
import type { ChatInput, ChatReply, LetterInput, Llm } from '../src/core/ports.ts';

const TERMS = ['Initech', 'Umbrella', 'GLOBEX', 'proptech', 'ломбард', 'факторинг', 'ACME CORP'];

describe('findForbiddenTerms', () => {
  it('catches names and inflected Ukrainian forms, case-insensitively', () => {
    assert.deepEqual(findForbiddenTerms('Працював у INITECH над платформою', TERMS), ['Initech']);
    assert.deepEqual(findForbiddenTerms('досвід в proptech-домені', TERMS), ['proptech']);
    assert.deepEqual(findForbiddenTerms('платформи онлайн-ломбарду та факторингу', TERMS), ['ломбард', 'факторинг']);
    assert.deepEqual(findForbiddenTerms('лендінги для Acme Corp', TERMS), ['ACME CORP']);
  });

  it('ignores the term inside other words, but matches as a prefix (by design: covers inflection)', () => {
    assert.deepEqual(findForbiddenTerms('Version 2, Passion, NestJS-мікросервіси', TERMS), []);
    assert.deepEqual(findForbiddenTerms('Initechix', TERMS), ['Initech']); // false positive only costs a rewrite
  });
});

function fakeLlm(outputs: string[], chatReply?: ChatReply) {
  const calls: LetterInput[] = [];
  const chats: ChatInput[] = [];
  const llm: Llm = {
    chat: async (input) => {
      chats.push(input);
      return chatReply ?? { reply: 'ok', letter: '' };
    },
    assess: async () => {
      throw new Error('not used');
    },
    writeLetter: async (input) => {
      calls.push(input);
      return outputs[calls.length - 1] ?? outputs.at(-1)!;
    },
  };
  return { llm, calls, chats };
}

const input = { candidateName: 'Іван', resume: 'cv' } as unknown as LetterInput;

describe('writeCheckedLetter', () => {
  it('passes the list to the model and returns a clean letter as is', async () => {
    const { llm, calls } = fakeLlm(['Вітаю! NestJS, Next.js. Іван']);
    assert.equal(await writeCheckedLetter(llm, input, TERMS), 'Вітаю! NestJS, Next.js. Іван');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.forbiddenTerms, TERMS);
  });

  it('sends a leaking letter back with a targeted fix request', async () => {
    const { llm, calls } = fakeLlm(['Працював у Initech, proptech', 'Працював на платформі з платежами']);
    assert.equal(await writeCheckedLetter(llm, input, TERMS), 'Працював на платформі з платежами');
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.previousLetter, 'Працював у Initech, proptech');
    assert.match(calls[1]?.feedback ?? '', /Initech, proptech/);
  });

  it('refuses to return a letter that keeps leaking', async () => {
    const { llm, calls } = fakeLlm(['GLOBEX']);
    await assert.rejects(writeCheckedLetter(llm, input, TERMS), ForbiddenTermsError);
    assert.equal(calls.length, 3);
  });
});

describe('checkedChat', () => {
  it('passes answers through untouched and gives the model the forbidden list', async () => {
    const { llm, calls, chats } = fakeLlm([], { reply: 'Компания продуктовая.', letter: '' });
    const result = await checkedChat(llm, { ...input, message: 'что за компания?' } as ChatInput, TERMS);
    assert.deepEqual(result, { reply: 'Компания продуктовая.', letter: '' });
    assert.deepEqual(chats[0]?.forbiddenTerms, TERMS);
    assert.equal(calls.length, 0);
  });

  it('cleans a letter produced in chat', async () => {
    const { llm, calls } = fakeLlm(['Чистий лист'], { reply: 'Сократил.', letter: 'Досвід у GLOBEX' });
    const result = await checkedChat(llm, { ...input, message: 'короче' } as ChatInput, TERMS);
    assert.deepEqual(result, { reply: 'Сократил.', letter: 'Чистий лист' });
    assert.equal(calls[0]?.previousLetter, 'Досвід у GLOBEX');
  });
});
