import type { LucyOperatorService } from './service.js';

/**
 * A slot for the operator service. Lucy live is built before the routes, and the service is built
 * with the routes, so Talk reads it from here when a turn starts (issue #3676).
 */
export function createLucyOperatorHolder(): { set(service: LucyOperatorService | undefined): void; get(): LucyOperatorService | undefined } {
  let current: LucyOperatorService | undefined;
  return {
    set: (service) => { current = service; },
    get: () => current,
  };
}
