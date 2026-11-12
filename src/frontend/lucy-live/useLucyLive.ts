/**
 * React hook behind the avatar panel's "Talk" button: hands-free spoken conversation with Lucy.
 *
 * Hands-free is off whenever the hook mounts, by design: it opens the microphone, so it must
 * never come back on by itself after a page load. Nothing here is saved to storage.
 *
 * The conversation itself lives in `lucy-live-session.ts`; this file adds what needs React:
 * the on/off switch, asking the server whether the feature is configured, following the
 * "Sound is off" preference, and turning session updates into render state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LUCY_LIVE_STATUS_PATH, type LucyLiveLanguage, type LucyLiveStatus } from '../../shared/contracts/lucy-live.js';
import { useSoundPreference } from '../audio/sound-preference.js';
import { loadSTTLanguage } from '../store/stt-language.js';
import { INITIAL_VIEW, LucyLiveSession, type LucyLiveView } from './lucy-live-session.js';

export type { LucyLiveStatusKind, LucyLiveTimings } from './lucy-live-session.js';

export const SOUND_OFF_REASON = 'Sound is off in Settings';
const DEFAULT_UNAVAILABLE_REASON = 'Lucy live is not available';

export interface UseLucyLiveResult extends Omit<LucyLiveView, 'errorMessage'> {
  /** Whether the operator has switched hands-free on (it may still be connecting or have failed). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Why hands-free is `unavailable`, in words the operator can act on; null otherwise. */
  unavailableReason: string | null;
  /** A problem to show: the reason for `error` or `unavailable`, or a per-turn failure while `ready`. */
  errorMessage: string | null;
  /**
   * What the server said when asked, or null if it could not be asked (no answer, old server).
   * `available: false` with a reason means "show the button disabled and say why"; null means "do not show it".
   */
  serverStatus: LucyLiveStatus | null;
}

const STATUS_POLL_MS = 5000;

/** Ask the server whether Lucy live is configured. Null when the question could not be answered. */
async function fetchStatus(): Promise<LucyLiveStatus | null> {
  try {
    const response = await fetch(LUCY_LIVE_STATUS_PATH, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<LucyLiveStatus> | null;
    if (!body || typeof body.available !== 'boolean') return null;
    return {
      available: body.available,
      ...(body.starting === true ? { starting: true } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      ...(body.bargeInConfirmation === 'silero' || body.bargeInConfirmation === 'off' ? { bargeInConfirmation: body.bargeInConfirmation } : {}),
    };
  } catch {
    return null;
  }
}

/** The dictation language when it is one Lucy understands, otherwise English. */
function conversationLanguage(): LucyLiveLanguage {
  return loadSTTLanguage() === 'fr' ? 'fr' : 'en';
}

export function useLucyLive(): UseLucyLiveResult {
  const sound = useSoundPreference();
  const [enabled, setEnabledState] = useState(false);
  const [view, setView] = useState<LucyLiveView>(INITIAL_VIEW);
  const [serverStatus, setServerStatus] = useState<LucyLiveStatus | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Learn once, when the panel appears, whether the feature exists, so the button can be hidden or explained.
  useEffect(() => {
    let cancelled = false;
    void fetchStatus().then((status) => {
      if (!cancelled) setServerStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // While the server is still bringing up the speech recogniser, ask again so the button
  // enables itself when it is healthy (the first start downloads about 2.4 GB).
  const serverStarting = serverStatus?.starting === true;
  useEffect(() => {
    if (!serverStarting) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchStatus().then((status) => {
        if (!cancelled && status) setServerStatus(status);
      });
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverStarting]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let session: LucyLiveSession | null = null;

    // A failed start leaves the switch off, so the operator can simply press it again.
    const fail = (status: 'unavailable' | 'error', message: string): void => {
      if (cancelled) return;
      setView({ ...INITIAL_VIEW, status, errorMessage: message });
      setEnabledState(false);
    };

    if (!sound.enabled) {
      fail('unavailable', SOUND_OFF_REASON);
      return () => {
        cancelled = true;
      };
    }

    setView({ ...INITIAL_VIEW, status: 'connecting' });
    void (async () => {
      const status = await fetchStatus();
      if (cancelled) return;
      if (status) setServerStatus(status);
      if (!status?.available) {
        fail('unavailable', status?.reason ?? DEFAULT_UNAVAILABLE_REASON);
        return;
      }
      session = new LucyLiveSession({
        language: conversationLanguage(),
        bargeInConfirmation: status.bargeInConfirmation === 'silero',
        onView: (patch) => {
          if (!cancelled) setView((previous) => ({ ...previous, ...patch }));
        },
        onFatal: fail,
      });
      await session.start();
    })();

    return () => {
      cancelled = true;
      session?.stop();
    };
  }, [enabled, sound.enabled]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    if (!next) setView(INITIAL_VIEW);
  }, []);

  return {
    ...view,
    enabled,
    setEnabled,
    unavailableReason: view.status === 'unavailable' ? view.errorMessage : null,
    serverStatus,
  };
}
