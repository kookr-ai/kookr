import type { RelayDoctorReport } from './relay-lifecycle-contracts.js';

export function formatRelayDoctorReport(report: RelayDoctorReport): string {
  const safe = {
    checkedAt: report.checkedAt,
    relayUrl: report.process.relayUrl,
    process: report.process,
    env: report.env,
    node: report.node,
    storage: report.storage,
    policy: report.policy,
    paths: {
      pid: report.paths.pidPath,
      log: report.paths.logPath,
      state: report.paths.statePath,
      sqlite: report.paths.dbPath,
    },
    recentLogs: report.recentLogs,
    nextActions: report.nextActions,
  };
  return `${JSON.stringify(safe, null, 2)}\n`;
}
