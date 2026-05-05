/**
 * Combined shadow strategy — union of pane_semantics + process_liveness.
 *
 * Takes the union of both sub-strategies: if either detects an anomaly,
 * the combined strategy reports it. When both fire, the more specific
 * verdict wins (pane_semantics can distinguish needs_input/permission_blocked,
 * while process_liveness only detects stale_agent).
 *
 * This strategy owns its own sub-strategy instances so their state is
 * independent from the individually-registered strategies. The extra
 * overhead (one additional /proc read per tick) is negligible for shadow mode.
 */

import type { Anomaly } from './types.js';
import type { ShadowStrategy, ShadowInputs } from './shadow-detector.js';
import { PaneSemanticsStrategy } from './pane-patterns.js';
import { ProcessLivenessStrategy } from './process-liveness.js';

export class CombinedShadowStrategy implements ShadowStrategy {
  readonly source = 'combined' as const;
  private pane: PaneSemanticsStrategy;
  private process: ProcessLivenessStrategy;

  constructor(pane?: PaneSemanticsStrategy, process?: ProcessLivenessStrategy) {
    this.pane = pane ?? new PaneSemanticsStrategy();
    this.process = process ?? new ProcessLivenessStrategy();
  }

  evaluate(agentId: string, inputs: ShadowInputs): Anomaly | null {
    const paneVerdict = this.pane.evaluate(agentId, inputs);
    const processVerdict = this.process.evaluate(agentId, inputs);

    if (paneVerdict && processVerdict) {
      // Prefer pane_semantics — it produces more specific types
      // (needs_input, permission_blocked) vs process_liveness (only stale_agent)
      return paneVerdict;
    }

    return paneVerdict ?? processVerdict;
  }
}
