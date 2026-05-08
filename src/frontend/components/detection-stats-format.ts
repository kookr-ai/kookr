const MIN_UPTIME_FOR_RATE_MS = 10 * 60 * 1000;

export function formatDetectionStatsSummary(
  totalFires: number,
  serverStartedAt: string | null | undefined,
  nowMs = Date.now(),
): string {
  const findings = `${totalFires} finding${totalFires !== 1 ? 's' : ''}`;
  if (!serverStartedAt) return findings;

  const uptimeMs = nowMs - new Date(serverStartedAt).getTime();
  if (!Number.isFinite(uptimeMs) || uptimeMs < MIN_UPTIME_FOR_RATE_MS) {
    return findings;
  }

  const uptimeHours = uptimeMs / 3_600_000;
  return `${findings} · ${(totalFires / uptimeHours).toFixed(1)}/hr`;
}
