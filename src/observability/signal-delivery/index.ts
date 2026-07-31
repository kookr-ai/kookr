/**
 * Operator-signal delivery subsystem (issue #1716).
 *
 * Detection existed everywhere in kookr; delivery existed nowhere. This
 * subsystem is the delivery side: emitters spool operator signals into a
 * durable outbox, and a background service pushes them to Discord / Telegram.
 */

export * from './operator-signal.js';
export * from './channels.js';
export * from './config.js';
export * from './service.js';
export * from './emit-transition.js';
export * from './liveness.js';
export * from './emit-runner.js';
export * from './operational-alert-bridge.js';
