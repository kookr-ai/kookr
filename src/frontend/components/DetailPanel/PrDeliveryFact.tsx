import React from 'react';
import type { GitHubPRState } from '../../../shared/protocol.js';
import { formatCompactDateTime } from '../../presentation.js';
import {
  deliveryGlyph,
  deliverySentence,
  deliveryShortLabel,
  deliveryTimeline,
  deliveryTone,
  selectFindingPrChip,
} from '../FindingsPanel/finding-pr-chip.js';

const STEP_GLYPH = { done: '●', pending: '○', bad: '↺', warn: '!' } as const;

/**
 * The "Delivery" fact of the detail pane (issue #3915): where the task's
 * change is, with the time each step was reached and, after a revert, the
 * failing tests and the fix task. It describes the same PR as the card's
 * badge. Renders nothing when that PR has no delivery state.
 */
export function PrDeliveryFact({ prs }: { prs: readonly GitHubPRState[] }): React.ReactElement | null {
  const model = selectFindingPrChip(prs);
  const delivery = model?.delivery;
  if (!model || !delivery) return null;
  const tone = deliveryTone(delivery);
  const revert = delivery.revert;

  return (
    <div className="detail-fact" data-testid="detail-fact-delivery">
      <dt>Delivery</dt>
      <dd className="detail-delivery">
        <span
          className={`finding-pr-chip detail-delivery-badge finding-pr-chip--delivery-${tone}`}
          data-delivery-stage={delivery.stage}
          title={deliverySentence(delivery)}
        >
          <span className="finding-pr-chip-glyph" aria-hidden="true">{deliveryGlyph(delivery)}</span>
          {deliveryShortLabel(delivery, model.status)}
        </span>
        <span className="sr-only">{deliverySentence(delivery)}</span>
        <ol className="detail-delivery-timeline" aria-label={`Delivery of pull request #${model.number}`}>
          {deliveryTimeline(delivery).map((step) => (
            <li key={step.label} className={`detail-delivery-step detail-delivery-step--${step.state}`}>
              <span aria-hidden="true">{STEP_GLYPH[step.state]}</span>
              <span>{step.label}</span>
              {step.at ? <time dateTime={step.at}>{formatCompactDateTime(step.at)}</time> : <span />}
            </li>
          ))}
        </ol>
        {delivery.stage === 'reverted' && revert && (
          <div className="detail-delivery-revert" data-testid="detail-delivery-revert">
            {revert.failingTests.length > 0 ? (
              <>
                <span>Failing tests</span>
                <ul>
                  {revert.failingTests.map((test) => <li key={test}><code>{test}</code></li>)}
                </ul>
              </>
            ) : (
              <span>The failing tests are in the train's verify log.</span>
            )}
            <span>
              {revert.needsHuman
                ? revert.fixTaskKey
                  ? `Fix task ${revert.fixTaskKey} could not start: needs a human.`
                  : 'No automatic fix left: needs a human.'
                : revert.fixTaskKey
                  ? `Fix task ${revert.fixTaskKey} (attempt ${revert.attempt ?? '?'} of ${revert.maxAttempts ?? 3}).`
                  : 'A fix task was not recorded.'}
            </span>
            <span>Revert commit <code>{revert.revertCommit.slice(0, 10)}</code></span>
          </div>
        )}
      </dd>
    </div>
  );
}
