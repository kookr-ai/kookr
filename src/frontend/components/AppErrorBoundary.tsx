import React from 'react';

interface Props {
  children: React.ReactNode;
  reloadDashboard?: () => void;
}

interface State {
  errorMessage: string | null;
  componentStack: string | null;
}

type ReloadDashboard = () => void;

const defaultReloadDashboard: ReloadDashboard = () => {
  window.location.reload();
};

let reloadDashboard = defaultReloadDashboard;

export function __setAppErrorBoundaryReloadDashboardForTests(next?: ReloadDashboard): void {
  reloadDashboard = next ?? defaultReloadDashboard;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'An unexpected render error interrupted the dashboard.';
}

function firstStackFrame(componentStack: string | null): string | null {
  if (!componentStack) return null;
  return componentStack
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ')) ?? null;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = {
    errorMessage: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: unknown): State {
    return {
      errorMessage: formatErrorMessage(error),
      componentStack: null,
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[App] render error, showing dashboard fallback:', error, info.componentStack);
  }

  private retryRender = (): void => {
    this.setState({ errorMessage: null, componentStack: null });
  };

  private reloadDashboard = (): void => {
    if (this.props.reloadDashboard) {
      this.props.reloadDashboard();
      return;
    }
    reloadDashboard();
  };

  render() {
    if (!this.state.errorMessage) {
      return this.props.children;
    }

    const source = firstStackFrame(this.state.componentStack);

    return (
      <main className="app-error-shell">
        <section className="app-error-panel" role="alert" aria-live="assertive" aria-labelledby="app-error-title">
          <p className="app-error-kicker">Dashboard render interrupted</p>
          <h1 id="app-error-title">Kookr hit a panel error</h1>
          <p className="app-error-copy">
            One dashboard component crashed during render. The supervisor process is still running; this fallback keeps the browser from going blank.
          </p>
          <dl className="app-error-details">
            <div>
              <dt>Error</dt>
              <dd>{this.state.errorMessage}</dd>
            </div>
            {source ? (
              <div>
                <dt>Likely source</dt>
                <dd><code>{source}</code></dd>
              </div>
            ) : null}
          </dl>
          <div className="app-error-actions">
            <button type="button" className="btn-primary" onClick={this.retryRender}>
              Try again
            </button>
            <button type="button" className="btn-secondary" onClick={this.reloadDashboard}>
              Reload dashboard
            </button>
          </div>
        </section>
      </main>
    );
  }
}
