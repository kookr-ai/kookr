export const DEFAULT_PERMISSION_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const MAX_PERMISSION_APPROVAL_TTL_MS = 5 * 60 * 1000;

export interface PermissionRequestBinding {
  requestId: string;
  toolName: string;
  toolInputHash: string;
  detectedAt: string;
  ttlMs: number;
}

export type PermissionApprovalPayload = {
  keystroke?: unknown;
  permissionRequest?: unknown;
};

export type PermissionBindingValidation =
  | { ok: true; binding: PermissionRequestBinding }
  | { ok: false; reason: string };
