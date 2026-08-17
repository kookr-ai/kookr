import { useMemo } from 'react';
import { describeLaunchQuotaWarning } from '../../core/launch-quota-warning.js';
import type { AgentSelection } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';

/** Live Launch-dialog quota warning from the store's quota sample and threshold. */
export function useLaunchQuotaWarning(selection: AgentSelection) {
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const quotaHeadroomThreshold = useKookrStore((s) => s.quotaHeadroomThreshold);
  const availableAgentTypes = useKookrStore((s) => s.availableAgentTypes);
  const roundRobinIndex = useKookrStore((s) => s.roundRobinIndex);

  return useMemo(
    () => describeLaunchQuotaWarning({
      selection,
      available: availableAgentTypes.map((entry) => entry.type),
      roundRobinIndex,
      quota: quotaStatus,
      threshold: quotaHeadroomThreshold,
    }),
    [selection, availableAgentTypes, roundRobinIndex, quotaStatus, quotaHeadroomThreshold],
  );
}
