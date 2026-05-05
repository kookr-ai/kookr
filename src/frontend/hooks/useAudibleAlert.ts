import { useEffect, useRef } from 'react';
import { useKookrStore } from '../store/useStore.js';

const STORAGE_KEY = 'kookr-sound-enabled';

/** Read mute preference from localStorage (default: enabled). */
export function isSoundEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

/** Persist mute preference. */
export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

/**
 * Play a short two-tone chime via Web Audio API.
 * Gracefully handles browsers that block AudioContext before user interaction.
 */
function playChime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // First tone: A5 (880 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.frequency.value = 880;
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.start(now);
    osc1.stop(now + 0.3);

    // Second tone: C#6 (1109 Hz) — rising interval for urgency
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.frequency.value = 1109;
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0.25, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.5);

    // Clean up after playback
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // AudioContext blocked by browser autoplay policy — silently ignore
  }
}

/**
 * Plays an audible chime when a new critical or warning finding appears
 * and the browser tab is hidden. Respects the mute toggle in localStorage.
 */
export function useAudibleAlert(): void {
  const agents = useKookrStore((s) => s.agents);
  const prevFindingIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentFindings = new Set<string>();
    let hasNewAlertable = false;

    for (const agent of agents) {
      if (agent.anomaly && !agent.snoozedUntil && !agent.suppressed) {
        currentFindings.add(agent.agentId);
        if (
          !prevFindingIds.current.has(agent.agentId) &&
          (agent.anomaly.severity === 'critical' || agent.anomaly.severity === 'warning')
        ) {
          hasNewAlertable = true;
        }
      }
    }

    prevFindingIds.current = currentFindings;

    if (hasNewAlertable && isSoundEnabled()) {
      playChime();
    }
  }, [agents]);
}
