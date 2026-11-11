import type { TaskStatus } from '../../../shared/contracts/task-status.js';

/**
 * Reading-pane header actions (issue #3561 slice 4b): one main action per
 * status, everything else in a "More actions" menu. Destructive actions never
 * sit on screen at rest, so Cancel always lives in the menu, even for a pending
 * task where it is the only action.
 */
export type DetailHeaderActionId =
  | 'complete'
  | 'markDone'
  | 'relaunch'
  | 'reopen'
  | 'reflect'
  | 'migrate'
  | 'cancel';

export interface DetailHeaderActions {
  primary: DetailHeaderActionId | null;
  menu: DetailHeaderActionId[];
}

export interface DetailHeaderActionsInput {
  taskId?: string;
  taskStatus?: TaskStatus;
  /** At least one other agent type can continue this task (Migrate to…). */
  canMigrate: boolean;
}

const NONE: DetailHeaderActions = { primary: null, menu: [] };

export function deriveDetailHeaderActions({ taskId, taskStatus, canMigrate }: DetailHeaderActionsInput): DetailHeaderActions {
  if (!taskId) return NONE;
  // Migrate is offered only for a dead process: a live session cannot migrate.
  const migrate: DetailHeaderActionId[] = canMigrate ? ['migrate'] : [];
  switch (taskStatus) {
    case 'pending':
      return { primary: null, menu: ['cancel'] };
    case 'terminated':
      // The session died before the operator marked it done.
      return { primary: 'markDone', menu: ['relaunch', 'reopen', 'reflect', ...migrate] };
    case 'cancelled':
      return { primary: 'relaunch', menu: ['reopen', 'reflect', ...migrate] };
    case 'completed':
      return { primary: 'relaunch', menu: ['reopen', 'reflect'] };
    default:
      // inProgress, open, or a status the client does not know yet.
      return { primary: 'complete', menu: ['reflect', 'cancel'] };
  }
}
