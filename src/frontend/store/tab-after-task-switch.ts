import type { NarrowTab } from './store-types.js';

/**
 * #3561 4a: the tab to show after moving to another task. An operator watching
 * terminals keeps the Terminal tab; the GitHub tab belongs to one task, so it
 * falls back to the conversation.
 *
 * Every path that changes the selected task uses this rule (#3618): sidebar and
 * keyboard selection, the server's dashboard selection, the auto-advance off a
 * dismissed task, and the first-snapshot restore.
 */
export function tabAfterTaskSwitch(current: NarrowTab): { leftPane: 'activity'; narrowTab: NarrowTab } {
  return { leftPane: 'activity', narrowTab: current === 'terminal' ? 'terminal' : 'activity' };
}
