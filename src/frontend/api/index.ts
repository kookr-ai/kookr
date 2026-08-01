/**
 * Frontend data-access layer (issue #1826). Import typed endpoint functions
 * from here instead of calling `fetch` directly:
 *
 *   import { getCostComparison, getDeployStatus } from '../api/index.js';
 *
 * The only module that touches the global `fetch` is `./client`.
 */
export {
  ApiError,
  apiFetch,
  fetchJson,
  fetchResult,
  getJson,
  type ApiResult,
} from './client.js';

export * from './deploy.js';
export * from './settings.js';
export * from './sharing.js';
export * from './relay.js';
export * from './coordinator.js';
export * from './tasks.js';
export * from './playbooks.js';
export * from './panels.js';
export * from './files.js';
export * from './sessions.js';
