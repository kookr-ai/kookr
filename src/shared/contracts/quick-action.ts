import type { PermissionRequestBinding } from './permission-request-binding.js';

export interface QuickAction {
  label: string;
  value: string;
  shortcut?: string;
  /** Permission-menu byte to send to the managed terminal, without Enter. */
  keystroke?: string;
  /** Exact PermissionRequest binding required by remote permission approvals. */
  permissionRequest?: PermissionRequestBinding;
}
