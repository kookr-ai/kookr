export interface QuotaWindow {
  utilization: number;
  resetsAt: string;
}

export interface QuotaStatus {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  updatedAt: number;
}
