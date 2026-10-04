import type { Board, BoardItem, Decision, Section } from '../../src/core/board.ts';
import type { LetterNote } from '../../src/core/letter-notes.ts';
import type { ChatTurn } from '../../src/core/ports.ts';

export type { Board, BoardItem, ChatTurn, Decision, LetterNote, Section };

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(path, {
    ...init,
    method: init?.json !== undefined ? 'POST' : (init?.method ?? 'GET'),
    headers: init?.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    credentials: 'same-origin',
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? `Ошибка ${response.status}`, response.status);
  return body;
}

const key = (k: string) => encodeURIComponent(k);

export const api = {
  board: () => call<Board>('/api/board'),
  decide: (k: string, decision: Decision) => call<BoardItem>(`/api/vacancies/${key(k)}/decision`, { json: { decision } }),
  note: (k: string, note: LetterNote, on: boolean) => call<{ letter: string }>(`/api/vacancies/${key(k)}/note`, { json: { note, on } }),
  regenerate: (k: string) => call<{ letter: string }>(`/api/vacancies/${key(k)}/regenerate`, { json: {} }),
  chatHistory: (k: string) => call<{ history: ChatTurn[] }>(`/api/vacancies/${key(k)}/chat`),
  chat: (k: string, message: string) =>
    call<{ reply: string; letter: string | null; history: ChatTurn[] }>(`/api/vacancies/${key(k)}/chat`, { json: { message } }),
  add: (url: string) => call<BoardItem>('/api/vacancies', { json: { url } }),
  scan: () => call<{ started: boolean }>('/api/scan', { json: {} }),
};
