import { useEffect, useRef, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { isDndEnabled } from './useDnd.js';
import type { AgentState } from '../../shared/protocol.js';

/**
 * Browser Notification API integration for Kookr findings.
 * Shows OS-level desktop notifications when:
 * - A new finding appears (agent enters anomaly state)
 * - The browser tab is not visible (user is focused elsewhere)
 *
 * Clicking a notification focuses the tab and selects the agent.
 */
export function useNotifications() {
  const agents = useKookrStore((s) => s.agents);
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const prevFindingIds = useRef<Set<string>>(new Set());
  const permissionRequested = useRef(false);

  // Request notification permission on first finding
  const requestPermission = useCallback(() => {
    if (permissionRequested.current) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      permissionRequested.current = true;
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!('Notification' in window)) return;

    const currentFindings = new Set<string>();
    const newFindings: AgentState[] = [];

    for (const agent of agents) {
      if (agent.anomaly && !agent.snoozedUntil && !agent.suppressed) {
        currentFindings.add(agent.agentId);
        if (!prevFindingIds.current.has(agent.agentId)) {
          newFindings.push(agent);
        }
      }
    }

    prevFindingIds.current = currentFindings;

    // Only notify when tab is hidden and we have new findings.
    // DND silences desktop notifications globally so the user can step away
    // (meeting, lunch, screenshare) without dismissing each per-agent alert.
    if (newFindings.length === 0 || !document.hidden || isDndEnabled()) return;

    // Request permission if not yet granted
    if (Notification.permission === 'default') {
      requestPermission();
      return;
    }
    if (Notification.permission !== 'granted') return;

    for (const agent of newFindings) {
      const title = agent.anomaly!.type === 'needs_input'
        ? 'Agent needs input'
        : `Agent: ${agent.anomaly!.type.replace('_', ' ')}`;
      const body = agent.taskName ?? agent.agentId;

      const notification = new Notification(title, {
        body,
        tag: `kookr-${agent.agentId}`, // Replaces existing notification for same agent
        icon: '/favicon.ico',
      });

      notification.onclick = () => {
        window.focus();
        selectAgent(agent.agentId);
        notification.close();
      };

      // Auto-close after 10 seconds
      setTimeout(() => notification.close(), 10_000);
    }
  }, [agents, selectAgent, requestPermission]);
}
