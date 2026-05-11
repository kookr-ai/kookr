import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export type ToolkitLinkStatus = 'ok' | 'missing' | 'not-symlink' | 'mismatch' | 'target-missing';

export interface ToolkitLinkCheck {
  name: string;
  status: ToolkitLinkStatus;
}

export interface ToolkitSymlinkStatus {
  checkedCount: number;
  stale: boolean;
  staleCount: number;
  links: ToolkitLinkCheck[];
}

interface ExpectedToolkitLink {
  name: string;
  sourceRel: string;
  destRel: string;
}

export async function getToolkitSymlinkStatus(options: {
  expectedRoot: string;
  homeDir: string;
  installHooksScript: string;
}): Promise<ToolkitSymlinkStatus> {
  const expectedRoot = resolve(options.expectedRoot);
  const homeDir = resolve(options.homeDir);
  const expectedLinks = await readExpectedToolkitLinks(options.installHooksScript, expectedRoot);
  const links = await Promise.all(
    expectedLinks.map((link) => checkLink(link, expectedRoot, homeDir)),
  );
  const staleCount = links.filter((link) => link.status !== 'ok').length;
  return {
    checkedCount: links.length,
    stale: staleCount > 0,
    staleCount,
    links,
  };
}

async function readExpectedToolkitLinks(installHooksScript: string, expectedRoot: string): Promise<ExpectedToolkitLink[]> {
  const { stdout } = await execFileAsync('bash', [installHooksScript, '--print-global-assets'], {
    cwd: expectedRoot,
    timeout: 10_000,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sourceRel, destRel] = line.split('\t');
      if (!name || !sourceRel || !destRel) {
        throw new Error(`Malformed install-hooks asset row: ${line}`);
      }
      return { name, sourceRel, destRel };
    });
}

async function checkLink(link: ExpectedToolkitLink, expectedRoot: string, homeDir: string): Promise<ToolkitLinkCheck> {
  const dest = join(homeDir, link.destRel);
  const expectedTarget = join(expectedRoot, link.sourceRel);
  try {
    const stat = await lstat(dest);
    if (!stat.isSymbolicLink()) {
      return {
        name: link.name,
        status: 'not-symlink',
      };
    }
    const rawTarget = await readlink(dest);
    const currentTarget = resolve(dirname(dest), rawTarget);
    if (currentTarget !== expectedTarget) {
      return {
        name: link.name,
        status: 'mismatch',
      };
    }
    try {
      await access(expectedTarget);
    } catch (err) {
      if (isNotFound(err)) {
        return {
          name: link.name,
          status: 'target-missing',
        };
      }
      throw err;
    }
    return {
      name: link.name,
      status: 'ok',
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        name: link.name,
        status: 'missing',
      };
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
