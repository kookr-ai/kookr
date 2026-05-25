const SELECTED_PROJECT_STORAGE_KEY = 'kookr-selected-project';

export function loadSelectedProject(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedProject(project: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (project) {
      localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, project);
    } else {
      localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
    }
  } catch {
    // Persistence is best-effort; project/task selection should still update.
  }
}
