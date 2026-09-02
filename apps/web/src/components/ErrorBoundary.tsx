import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-lg rounded-xl border border-rose-200 bg-white p-6 shadow">
          <h1 className="text-lg font-bold text-rose-700">Algo salió mal</h1>
          <p className="mt-2 text-sm text-slate-600">La pantalla encontró un error inesperado. Puedes recargar la aplicación; ninguna operación confirmada se pierde.</p>
          <pre className="mt-3 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-600">{this.state.error.message}</pre>
          <button type="button" className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white" onClick={() => window.location.reload()}>
            Recargar
          </button>
        </div>
      </div>
    );
  }
}
