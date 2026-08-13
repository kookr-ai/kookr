import { useEffect, useState } from 'react';
import { getCompactTasks } from '../api/index.js';

/**
 * Launch-directory map from the compact task list (taskId → cwd).
 *
 * Dashboard snapshot rows follow the live session cwd, which often moves into
 * a worktree. Duplicate-prompt matching needs the directory the operator
 * actually launched in — the compact list keeps that field.
 *
 * Fetch fails open: an empty map leaves snapshot cwd in place.
 */
export function useLaunchTaskCwds(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void getCompactTasks<Array<{ id?: string; taskId?: string; cwd?: string }>>()
      .then((tasks) => {
        if (!active || !Array.isArray(tasks)) return;
        const next: Record<string, string> = {};
        for (const task of tasks) {
          const id = task.taskId ?? task.id;
          if (id && typeof task.cwd === 'string' && task.cwd.length > 0) {
            next[id] = task.cwd;
          }
        }
        setMap(next);
      })
      .catch(() => { /* keep empty map */ });
    return () => { active = false; };
  }, []);

  return map;
}
