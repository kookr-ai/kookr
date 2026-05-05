import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BuildInfo {
  commitHash: string;
  commitShort: string;
  branch: string;
  buildTimestamp: string;
  version: string;
}

const DEV_BUILD_INFO: BuildInfo = {
  commitHash: 'dev',
  commitShort: 'dev',
  branch: 'dev',
  buildTimestamp: '',
  version: 'dev',
};

/**
 * Load build info from dist/build-info.json.
 * Returns a dev fallback if the file is missing (e.g. during `pnpm dev`).
 */
export async function loadBuildInfo(distDir: string): Promise<BuildInfo> {
  try {
    const raw = await readFile(join(distDir, '..', 'build-info.json'), 'utf-8');
    return JSON.parse(raw) as BuildInfo;
  } catch {
    return DEV_BUILD_INFO;
  }
}
