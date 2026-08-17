import { useMemo } from 'react';
import { describeLaunchQuotaWarning } from '../../shared/launch-quota-warning.js';
import type { AgentSelection } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';

/** Live Launch-dialog quota warning from the store's quota sample and threshold. */
export function useLaunchQuotaWarning(selection: AgentSelection, grokAuthUsable?: boolean) {
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const quotaHeadroomThreshold = useKookrStore((s) => s.quotaHeadroomThreshold);
  const availableAgentTypes = useKookrStore((s) => s.availableAgentTypes);
  const roundRobinIndex = useKookrStore((s) => s.roundRobinIndex);

  return useMemo(
    () => describeLaunchQuotaWarning({
      selection,
      available: availableAgentTypes.map((entry) => entry.type),
      roundRobinIndex,
      grokAuthUsable,
      quota: quotaStatus,
      threshold: quotaHeadroomThreshold,
    }),
    [selection, availableAgentTypes, roundRobinIndex, grokAuthUsable, quotaStatus, quotaHeadroomThreshold],
  );
}
