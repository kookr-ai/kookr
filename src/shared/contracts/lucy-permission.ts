/**
 * Wire contract for Lucy speaking up when a task has waited on a permission prompt (issue #3932).
 *
 * The server decides everything: which prompts get a card, when she speaks, and the exact
 * sentence. The browser shows the cards it is sent and, when a message carries `announce`,
 * fetches the clip for that notice id. It never sends text to be spoken; the sentence comes along
 * only so it can be written in her thread when it could not be spoken.
 */
import type { PermissionRequestBinding } from './permission-request-binding.js';

/**
 * `POST` `{ noticeId }`: Lucy's voice for one spoken notice, as a `SpeakAudioResponse` (the shape
 * `POST /api/asks/:id/speak` returns). 409 once every prompt the notice is about has been answered.
 */
export const LUCY_PERMISSION_NOTICE_SPEAK_PATH = '/api/lucy/permission-notice/speak';

/** How long a prompt waits before Lucy shows its card and speaks (setting `lucyPermissionNoticeAfterSeconds`). */
export const DEFAULT_LUCY_PERMISSION_NOTICE_AFTER_SECONDS = 60;
/** Largest accepted value of that setting: one hour. `0` turns the notices off. */
export const MAX_LUCY_PERMISSION_NOTICE_AFTER_SECONDS = 3600;
/** At most one spoken notice in this window; notices that arrive meanwhile are said together after it. */
export const LUCY_PERMISSION_NOTICE_GAP_MS = 2 * 60_000;

/** One permission prompt on Lucy's panel. */
export interface LucyPermissionCardView {
  /**
   * Prompt identity: the binding's `requestId` when the prompt has a hook event, otherwise
   * `pane:<taskId>:<since>` (a block seen only on the pane, which no button can be bound to).
   */
  promptId: string;
  taskId: string;
  /** The task's agent session, which the buttons' `permissionChoice` message names. */
  agentId: string;
  taskName?: string;
  /** Tool the agent asked to use, e.g. `Bash`. */
  toolName: string;
  /** The whole command, file path or URL, secrets hidden; empty when unknown. */
  command: string;
  /** When the prompt was first seen (ms since epoch). */
  since: number;
  /**
   * The binding the finding card's permission buttons carry. Absent when no button can be
   * bound to this prompt; the card then says to answer it in the task.
   */
  permissionRequest?: PermissionRequestBinding;
  /** Menu key of the one-time "Yes" option, read from the pane. Absent: no Approve once button. */
  approveKey?: string;
  /** Menu key of the "No" option, read from the pane. Absent: no Deny button. */
  denyKey?: string;
}

/** A sentence Lucy says about some of the cards; the browser fetches its clip by `noticeId`. */
export interface LucyPermissionAnnouncement {
  noticeId: string;
  /** The prompts the sentence is about. Once none of them is on the list, she stops. */
  promptIds: string[];
  /**
   * The sentence itself, so the panel can write it into her thread when no clip could be fetched
   * (no speech service, or it failed). The clip is still made from the server's own copy: the
   * browser never sends text to be spoken. Absent from a server older than this field.
   */
  text?: string;
}
