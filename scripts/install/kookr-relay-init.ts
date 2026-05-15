import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface RelayInitArgs {
  relay: string;
  adminToken?: string;
  displayName?: string;
  ownerId?: string;
  kookrDir: string;
}

function parseArgs(argv: string[]): RelayInitArgs {
  const args: RelayInitArgs = {
    relay: '',
    kookrDir: process.env.KOOKR_DIR ?? join(homedir(), '.kookr'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--relay' && next) {
      args.relay = next;
      i += 1;
    } else if (arg === '--admin-token' && next) {
      args.adminToken = next;
      i += 1;
    } else if (arg === '--display-name' && next) {
      args.displayName = next;
      i += 1;
    } else if (arg === '--owner-id' && next) {
      args.ownerId = next;
      i += 1;
    } else if (arg === '--kookr-dir' && next) {
      args.kookrDir = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.relay) {
    args.relay = process.env.KOOKR_RELAY_URL ?? '';
  }
  if (!args.adminToken) {
    args.adminToken = process.env.KOOKR_RELAY_ADMIN_TOKEN;
  }
  if (!args.relay) {
    throw new Error('missing --relay');
  }
  return args;
}

function usage(code: number): never {
  console.log(`Usage: node --import tsx scripts/install/kookr-relay-init.ts --relay <url> [--admin-token <token>] [--display-name <name>] [--kookr-dir <dir>]

Registers this Kookr node with a relay and prints the node token once.`);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = new URL('/relay/admin/nodes', args.relay);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(args.adminToken ? { authorization: `Bearer ${args.adminToken}` } : {}),
    },
    body: JSON.stringify({
      displayName: args.displayName,
      ownerId: args.ownerId,
    }),
  });
  if (!res.ok) {
    throw new Error(`relay registration failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { nodeId: string; nodeToken: string };
  await mkdir(args.kookrDir, { recursive: true });
  await writeFile(join(args.kookrDir, 'node-id'), `${body.nodeId}\n`, { flag: 'wx' });
  console.log('Authenticating... done.');
  console.log(`Registered node: ${body.nodeId}`);
  console.log(`Node token: ${body.nodeToken}`);
  console.log(`Wrote node id: ${join(args.kookrDir, 'node-id')}`);
  console.log('');
  console.log('Add to your node environment:');
  console.log(`  KOOKR_RELAY_URL=${args.relay}`);
  console.log(`  KOOKR_RELAY_TOKEN=${body.nodeToken}`);
  console.log('  KOOKR_RELAY_TRUSTED=true');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
