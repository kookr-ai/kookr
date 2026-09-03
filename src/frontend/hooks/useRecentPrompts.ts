import { useEffect, useRef, useState } from 'react';
import { getRecentPrompts } from '../api/tasks.js';
import type { RecentPromptEntry } from '../../shared/contracts/recent-prompts.js';

interface UseRecentPromptsArgs {
  /** Fetch only once this is true (the manual tab is shown, not a relaunch). */
  enabled: boolean;
  /** Working directory to bias ranking toward; captured at fetch time only. */
  cwd: string;
}

/**
 * Fetch the recent manual-launch prompts for the Launch dialog's recall picker
 * (RFC: rfc-launch-prompt-recall).
 *
 * Fetches **once** when `enabled` turns true (the manual tab is shown), capturing
 * the working directory *at that moment* via a ref so that editing the cwd field
 * afterwards does NOT refetch — the effect depends only on `enabled`. This is the
 * fetch-on-mount shape of `useLaunchTaskCwds`, deliberately not a per-keystroke
 * refetch (which would issue one archive-reading request per character typed).
 * The request aborts on unmount / when `enabled` flips, and the API fails closed
 * to `[]`. The picker owns its own filter state.
 */
export function useRecentPrompts({ enabled, cwd }: UseRecentPromptsArgs): RecentPromptEntry[] {
  const [entries, setEntries] = useState<RecentPromptEntry[]>([]);
  // Latest cwd, read at fetch time without making cwd an effect dependency.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void getRecentPrompts(cwdRef.current, controller.signal).then((result) => {
      if (!controller.signal.aborted) setEntries(result);
    });
    return () => controller.abort();
  }, [enabled]);

  return entries;
}
