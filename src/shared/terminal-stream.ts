/** Positions in the backend's live byte stream, not socket or ring indices. */
export interface TerminalSourceRange {
  epoch: string;
  start: number;
  end: number;
  geometryRevision: number;
  cols: number;
  rows: number;
}

/** An atomic retained window. The exclusive end also names the live boundary. */
export interface TerminalStreamSnapshot extends TerminalSourceRange {
  bytes: Uint8Array;
}
