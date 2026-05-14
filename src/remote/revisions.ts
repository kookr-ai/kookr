export interface ServerRevisionScope {
  nodeId: string;
  sessionId: string;
}

function revisionKey(scope: ServerRevisionScope): string {
  return `${scope.nodeId}\0${scope.sessionId}`;
}

/**
 * Pure Phase 0a scaffold for the future remote control-plane revision.
 * Local-only runtime does not construct this; the remote node path will own it
 * once snapshots/deltas start flowing to a relay.
 */
export class RemoteSessionRevisionTracker {
  private readonly revisions = new Map<string, number>();

  current(scope: ServerRevisionScope): number {
    return this.revisions.get(revisionKey(scope)) ?? 0;
  }

  next(scope: ServerRevisionScope): number {
    const value = this.current(scope) + 1;
    this.revisions.set(revisionKey(scope), value);
    return value;
  }

  reset(scope: ServerRevisionScope): void {
    this.revisions.delete(revisionKey(scope));
  }
}
