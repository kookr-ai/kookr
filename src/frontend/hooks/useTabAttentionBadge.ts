import { useEffect, useMemo, useRef } from 'react';
import type { AgentState, AnomalySeverity } from '../../shared/protocol.js';
import { SEVERITY_ORDER } from '../store/store-types.js';
import { isActiveFinding } from '../store/finding-helpers.js';
import { useKookrStore } from '../store/useStore.js';
import { useDnd } from './useDnd.js';
import { useProjectNotificationMute } from './useProjectNotificationMute.js';

const BADGE_APPLY_DELAY_MS = 1_000;
const DEFAULT_TITLE = 'kookr';

const SEVERITY_DOT_COLORS: Record<AnomalySeverity, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
};

interface TabAttentionBadgeState {
  count: number;
  severity: AnomalySeverity;
}

type ProjectMutePredicate = (projectId: string | undefined) => boolean;

interface IconSnapshot {
  element: HTMLLinkElement;
  href: string | null;
}

interface TabChromeSnapshot {
  title: string;
  icons: IconSnapshot[];
  createdIcon: HTMLLinkElement | null;
}

export function getTabAttentionBadgeState(
  agents: AgentState[],
  dndEnabled: boolean,
  isProjectMuted: ProjectMutePredicate = () => false,
): TabAttentionBadgeState | null {
  if (dndEnabled) return null;

  let count = 0;
  let severity: AnomalySeverity | null = null;
  for (const agent of agents) {
    if (!isActiveFinding(agent) || !agent.anomaly) continue;
    if (isProjectMuted(agent.projectId)) continue;
    count += 1;
    const candidate = agent.effectiveAttentionSeverity ?? agent.anomaly.severity;
    if (severity === null || SEVERITY_ORDER[candidate] < SEVERITY_ORDER[severity]) {
      severity = candidate;
    }
  }

  return severity === null ? null : { count, severity };
}

function titleForBadge(count: number, baseTitle: string): string {
  return `(${count}) ${baseTitle || DEFAULT_TITLE}`;
}

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

function captureTabChrome(): TabChromeSnapshot {
  const icons = iconLinks().map((element) => ({
    element,
    href: element.getAttribute('href'),
  }));
  let createdIcon: HTMLLinkElement | null = null;

  if (icons.length === 0) {
    createdIcon = document.createElement('link');
    createdIcon.rel = 'icon';
    document.head.appendChild(createdIcon);
    icons.push({ element: createdIcon, href: null });
  }

  return {
    title: document.title || DEFAULT_TITLE,
    icons,
    createdIcon,
  };
}

function restoreTabChrome(snapshot: TabChromeSnapshot): void {
  document.title = snapshot.title;

  for (const { element, href } of snapshot.icons) {
    if (element === snapshot.createdIcon) continue;
    if (href === null) element.removeAttribute('href');
    else element.setAttribute('href', href);
  }

  snapshot.createdIcon?.remove();
}

function createBadgedFaviconHref(severity: AnomalySeverity): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.clearRect(0, 0, 64, 64);
  context.fillStyle = '#111827';
  context.beginPath();
  context.arc(32, 32, 30, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#f8fafc';
  context.font = '700 34px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('K', 32, 34);

  context.fillStyle = SEVERITY_DOT_COLORS[severity];
  context.beginPath();
  context.arc(49, 15, 11, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#111827';
  context.lineWidth = 4;
  context.stroke();

  return canvas.toDataURL('image/png');
}

function applyTabBadge(snapshot: TabChromeSnapshot, badge: TabAttentionBadgeState): void {
  document.title = titleForBadge(badge.count, snapshot.title);
  const href = createBadgedFaviconHref(badge.severity);
  if (!href) return;
  for (const { element } of snapshot.icons) {
    element.setAttribute('href', href);
  }
}

export function useTabAttentionBadge(): void {
  const agents = useKookrStore((state) => state.agents);
  const dnd = useDnd();
  const projectMute = useProjectNotificationMute();
  const badge = useMemo(
    () => getTabAttentionBadgeState(agents, dnd.enabled, projectMute.isMuted),
    [agents, dnd.enabled, projectMute],
  );
  const badgeCount = badge?.count ?? 0;
  const badgeSeverity = badge?.severity ?? null;
  const original = useRef<TabChromeSnapshot | null>(null);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    original.current ??= captureTabChrome();

    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
    }

    if (badgeCount === 0 || badgeSeverity === null) {
      restoreTabChrome(original.current);
      return;
    }

    applyTimer.current = setTimeout(() => {
      if (original.current) applyTabBadge(original.current, {
        count: badgeCount,
        severity: badgeSeverity,
      });
      applyTimer.current = null;
    }, BADGE_APPLY_DELAY_MS);

    return () => {
      if (applyTimer.current) {
        clearTimeout(applyTimer.current);
        applyTimer.current = null;
      }
    };
  }, [badgeCount, badgeSeverity]);

  useEffect(() => {
    return () => {
      if (applyTimer.current) {
        clearTimeout(applyTimer.current);
        applyTimer.current = null;
      }
      if (original.current) restoreTabChrome(original.current);
    };
  }, []);
}
