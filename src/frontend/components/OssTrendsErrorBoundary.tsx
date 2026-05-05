import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export class OssTrendsErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('[OssTrends] render error, falling back:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="oss-trends-error">
          Trend indicators unavailable — see data below.
        </div>
      );
    }
    return this.props.children;
  }
}
