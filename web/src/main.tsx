import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

/** A render error shows a way out instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="max-w-sm space-y-3">
          <p className="font-medium text-slate-800">Что-то сломалось в интерфейсе</p>
          <p className="text-sm break-words text-slate-500">{this.state.error.message}</p>
          <button type="button" onClick={() => location.reload()} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white">
            Перезагрузить
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
