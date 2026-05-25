/**
 * Terminal pane pattern detection for managed agent UI states.
 *
 * The pure browser-safe classifier lives in `src/shared/pane-semantics.ts` so
 * frontend terminal controls and backend watchdog fallback share one set of
 * Claude/Codex prompt heuristics. This module adds the core-only shadow
 * strategy mapping from pane semantics to anomalies.
 */

import type { Anomaly } from './types.js';
import type { ShadowStrategy, ShadowInputs } from './shadow-detector.js';
import {
  analyzePaneSemantics,
  normalizePaneForActivity,
  type PaneSemantics,
  type PaneState,
} from '../shared/pane-semantics.js';

export {
  analyzePaneSemantics,
  normalizePaneForActivity,
  type PaneSemantics,
  type PaneState,
};

function paneStateToAnomaly(agentId: string, semantics: PaneSemantics): Anomaly | null {
  if (semantics.confidence === 'low') return null;

  switch (semantics.state) {
    case 'input_prompt':
      return {
        agentId,
        type: 'needs_input',
        severity: 'info',
        explanation: `Pane shows input prompt: "${semantics.matchedText ?? '❯'}"`,
        detectedAt: new Date(),
        confidence: semantics.confidence,
      };
    case 'permission_dialog':
      return {
        agentId,
        type: 'permission_blocked',
        severity: 'warning',
        explanation: `Pane shows permission dialog: "${semantics.matchedText ?? 'Allow/Deny'}"`,
        detectedAt: new Date(),
        confidence: semantics.confidence,
      };
    case 'shell_prompt':
      return {
        agentId,
        type: 'stale_agent',
        severity: 'warning',
        explanation: `Pane shows shell prompt — Claude Code may have exited: "${semantics.matchedText ?? '$'}"`,
        detectedAt: new Date(),
        confidence: semantics.confidence,
      };
    default:
      return null;
  }
}

export class PaneSemanticsStrategy implements ShadowStrategy {
  readonly source = 'pane_semantics' as const;

  evaluate(agentId: string, inputs: ShadowInputs): Anomaly | null {
    const semantics = analyzePaneSemantics(inputs.paneText);
    return paneStateToAnomaly(agentId, semantics);
  }
}
