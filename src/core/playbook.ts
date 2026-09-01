/**
 * Playbook type definitions are owned by the shared contract layer; this module
 * re-exports them so existing core/server imports keep working.
 *
 * New code should import directly from `src/shared/contracts/playbook.js`.
 */

export type {
  Playbook,
  PlaybookParameter,
  PlaybookParameterOption,
  PlaybookLoopConfig,
  PlaybookProbe,
  EffectivePlaybookLoop,
  PlaybookScope,
  PlaybookSourceIdentity,
  LaunchDependency,
} from '../shared/contracts/playbook.js';

export { LAUNCH_DEPENDENCIES } from '../shared/contracts/playbook.js';
