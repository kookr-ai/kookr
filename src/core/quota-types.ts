/**
 * Quota domain types shared across core, shared (wire protocol), adapters,
 * server, and frontend layers.
 *
 * Lives in `core/` so `shared/` can import these without inverting the layer
 * rule (`shared/` must not depend on `adapters/`).
 */

export interface QuotaWindow {
  utilization: number; // 0–100
  resetsAt: string;    // ISO 8601
}

export interface QuotaStatus {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  updatedAt: number; // Unix ms timestamp
}
