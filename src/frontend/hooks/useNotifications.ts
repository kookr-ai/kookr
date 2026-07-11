import { useEffect, useRef, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { isAudibleAlertEnabled, useSoundPreference } from '../audio/sound.js';
import { isDndEnabled } from './useDnd.js';
import { isProjectNotificationMuted } from './useProjectNotificationMute.js';
import { projectLabel } from '../presentation.js';
import type { AgentState } from '../../shared/protocol.js';

/**
 * Browser Notification API integration for Kookr findings.
 * Shows OS-level desktop notifications when:
 * - A new finding appears (agent enters anomaly state)
 * - The browser tab is not visible (user is focused elsewhere)
 * - Sound alerts are muted, making desktop notifications the fallback channel
 *
 * Clicking a notification focuses the tab and selects the agent.
 */
export function useNotifications() {
  const agents = useKookrStore((s) => s.agents);
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const sound = useSoundPreference();
  const audibleAlertsEnabled = isAudibleAlertEnabled(sound);
  const prevFindingIds = useRef<Set<string>>(new Set());
  const activeNotifications = useRef<Set<Notification>>(new Set());
  const permissionRequested = useRef(false);

  const closeActiveNotifications = useCallback(() => {
    for (const notification of activeNotifications.current) {
      notification.close();
    }
    activeNotifications.current.clear();
  }, []);

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
    if (!('Notification' in window)) {
      activeNotifications.current.clear();
      return;
    }

    const currentFindings = new Set<string>();
    const newFindings: AgentState[] = [];

    for (const agent of agents) {
      if (agent.anomaly && !agent.snoozedUntil && !agent.suppressed) {
        currentFindings.add(agent.agentId);
        if (!prevFindingIds.current.has(agent.agentId) && !isProjectNotificationMuted(agent.projectId)) {
          newFindings.push(agent);
        }
      }
    }

    prevFindingIds.current = currentFindings;

    // Sound is the primary alert channel. When it is enabled, avoid building
    // a wake-from-sleep backlog of one OS notification per task; the sound
    // already tells the user to look at the dashboard.
    if (audibleAlertsEnabled) {
      closeActiveNotifications();
      return;
    }

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
      const fallbackTitle = agent.anomaly!.type === 'needs_input'
        ? 'Agent needs input'
        : `Agent: ${agent.anomaly!.type.replace('_', ' ')}`;
      const findingLabel = agent.anomaly!.type.replace('_', ' ');
      const title = agent.taskName
        ? `${agent.taskName} · ${findingLabel}`
        : fallbackTitle;
      const project = agent.projectDisplayLabel ?? projectLabel(agent.cwd);
      const body = project
        ? `${project} · ${agent.anomaly!.explanation}`
        : agent.anomaly!.explanation;

      const notification = new Notification(title, {
        body,
        tag: `kookr-${agent.agentId}`, // Replaces existing notification for same agent
        icon: '/favicon.ico',
      });
      activeNotifications.current.add(notification);

      notification.onclick = () => {
        window.focus();
        selectAgent(agent.agentId);
        notification.close();
        activeNotifications.current.delete(notification);
      };

      // Auto-close after 10 seconds
      setTimeout(() => {
        notification.close();
        activeNotifications.current.delete(notification);
      }, 10_000);
    }
  }, [agents, selectAgent, requestPermission, audibleAlertsEnabled, closeActiveNotifications]);
}
