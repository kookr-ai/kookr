import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Keeps a failure in the optional avatar panel from taking the dashboard down.
 *
 * The panel is switched on by a saved preference and mounts at startup, so
 * without this an error while loading or rendering it (a missing chunk after
 * an update, a browser quirk in the 3D code) would reach the top-level error
 * screen on every page load, with the Settings switch that turns the panel off
 * out of reach. Here the panel simply disappears until the next reload.
 *
 * Deliberately tiny and free of imports from the panel itself: it is part of
 * the main bundle, while the panel's code is fetched only when switched on.
 */
export class AvatarErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('[kookr.avatar] the avatar panel failed and was hidden; the dashboard is unaffected', error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
