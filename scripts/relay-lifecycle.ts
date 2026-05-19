import {
  buildRelayDoctorReport,
  diagnoseRelayProcess,
  restartRelay,
  startRelay,
  stopRelay,
} from '../src/server/relay-lifecycle.js';
import { formatRelayDoctorReport } from '../src/server/relay-lifecycle-cli-format.js';
import { relayLifecyclePaths } from '../src/server/relay-lifecycle-paths.js';
import { readRecentRelayLogs } from '../src/server/relay-log-reader.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  switch (command) {
    case 'start':
      console.log(await startRelay());
      return;
    case 'status': {
      const status = await diagnoseRelayProcess();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case 'logs': {
      const lines = await readRecentRelayLogs(relayLifecyclePaths(process.env.KOOKR_DIR).logPath, 120);
      console.log(lines.join('\n'));
      return;
    }
    case 'restart':
      console.log(await restartRelay());
      return;
    case 'stop':
      console.log(await stopRelay());
      return;
    case 'doctor':
      console.log(formatRelayDoctorReport(await buildRelayDoctorReport()));
      return;
    default:
      console.error(`Unknown relay lifecycle command: ${command}`);
      console.error('Usage: pnpm relay:start|relay:status|relay:logs|relay:restart|relay:stop|relay:doctor');
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
