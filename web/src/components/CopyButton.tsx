import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/** Copies `text` on click and confirms for a moment; `children` is what's shown (defaults to the text). */
export function CopyButton({ text, label, children, className = '' }: { text: string; label?: string; children?: ReactNode; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Plain http on a LAN IP is not a "secure context": clipboard API is missing, fall back to execCommand.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={label ?? 'Скопировать'}
      className={`inline-flex items-center gap-1.5 rounded-lg transition active:scale-95 ${className}`}
    >
      {done ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4 opacity-60" />}
      {children ?? text}
      {done && <span className="text-xs text-emerald-600">скопировано</span>}
    </button>
  );
}
