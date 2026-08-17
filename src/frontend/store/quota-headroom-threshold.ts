import { useKookrStore } from './useStore.js';

/**
 * Mirror `settings.quotaHeadroomThreshold` into the dashboard store so the
 * Launch dialog can reuse the same gate the server already uses. Non-finite
 * or missing values keep the current store value (default 90).
 */
export function applyQuotaHeadroomThreshold(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const next = Math.max(0, Math.min(100, Math.round(value)));
  useKookrStore.setState({ quotaHeadroomThreshold: next });
}
