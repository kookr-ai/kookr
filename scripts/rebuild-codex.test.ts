import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REBUILD_SCRIPT = resolve('scripts/rebuild-codex.sh');
const SYNC_PLAYBOOK = resolve('.kookr/playbooks/codex-rebase.md');

interface Fixture {
  root: string;
  sourceDir: string;
  installDir: string;
  cargoLog: string;
  curlLog: string;
  env: NodeJS.ProcessEnv;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function createFixture(hostBuildExit: number): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kookr-codex-pair-'));
  const sourceDir = join(root, 'codex');
  const codexRsDir = join(sourceDir, 'codex-rs');
  const targetDir = join(root, 'target');
  const releaseDir = join(targetDir, 'release');
  const installDir = join(root, 'install');
  const stubBin = join(root, 'bin');
  const cargoLog = join(root, 'cargo.log');
  const curlLog = join(root, 'curl.log');

  mkdirSync(codexRsDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(codexRsDir, 'Cargo.toml'), '[workspace]\nmembers = []\n');
  writeExecutable(join(releaseDir, 'codex'), 'printf \'new-cli\\n\'');
  writeExecutable(join(releaseDir, 'codex-code-mode-host'), 'printf \'new-host\\n\'');
  writeExecutable(join(installDir, 'codex'), 'printf \'old-cli\\n\'');
  writeExecutable(join(installDir, 'codex-code-mode-host'), 'printf \'old-host\\n\'');

  execFileSync('git', ['init', '--quiet'], { cwd: sourceDir });
  execFileSync('git', ['config', 'user.name', 'Kookr Test'], { cwd: sourceDir });
  execFileSync('git', ['config', 'user.email', 'kookr-test@example.invalid'], { cwd: sourceDir });
  execFileSync('git', ['add', 'codex-rs/Cargo.toml'], { cwd: sourceDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: sourceDir });

  writeExecutable(
    join(stubBin, 'cargo'),
    `printf '%s\\n' "$*" >> ${JSON.stringify(cargoLog)}
case " $* " in
  *" metadata "*) printf '%s\\n' ${JSON.stringify(JSON.stringify({
    target_directory: targetDir,
    packages: [{ name: 'codex-cli', version: '0.145.0-alpha.4' }],
  }))} ;;
  *" -p codex-code-mode-host "*) exit ${hostBuildExit} ;;
  *) exit 0 ;;
esac`,
  );
  writeExecutable(
    join(stubBin, 'curl'),
    `printf '%s\\n' "$*" > ${JSON.stringify(curlLog)}
exit 22`,
  );

  return {
    root,
    sourceDir,
    installDir,
    cargoLog,
    curlLog,
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      CODEX_SRC: sourceDir,
      CODEX_INSTALL_DIR: installDir,
      CODEX_BUILD_PROFILE: 'release',
    },
  };
}

function runRebuild(fixture: Fixture) {
  return spawnSync('bash', [REBUILD_SCRIPT], {
    cwd: resolve('.'),
    env: fixture.env,
    encoding: 'utf8',
  });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('R4b.14: matched Codex runtime pair', () => {
  it('leaves the active pair unchanged when no compatible host can be prepared', () => {
    const fixture = createFixture(1);
    try {
      const result = runRebuild(fixture);

      expect(result.status).not.toBe(0);
      expect(execFileSync(join(fixture.installDir, 'codex'), { encoding: 'utf8' })).toBe('old-cli\n');
      expect(execFileSync(join(fixture.installDir, 'codex-code-mode-host'), { encoding: 'utf8' }))
        .toBe('old-host\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('activates source-built executables through one versioned runtime directory', () => {
    const fixture = createFixture(0);
    try {
      const result = runRebuild(fixture);

      expect(result.status, result.stderr).toBe(0);
      const cliPath = join(fixture.installDir, 'codex');
      const hostPath = join(fixture.installDir, 'codex-code-mode-host');
      expect(lstatSync(cliPath).isSymbolicLink()).toBe(true);
      expect(lstatSync(hostPath).isSymbolicLink()).toBe(true);
      expect(dirname(realpathSync(cliPath))).toBe(dirname(realpathSync(hostPath)));
      expect(execFileSync(cliPath, { encoding: 'utf8' })).toBe('new-cli\n');
      expect(execFileSync(hostPath, { encoding: 'utf8' })).toBe('new-host\n');

      const manifest = JSON.parse(
        readFileSync(join(dirname(realpathSync(cliPath)), 'codex-pair.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        source: 'source-build',
      });
      expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('leaves a legacy installation unchanged when the matching pair directory is corrupt', () => {
    const fixture = createFixture(0);
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.sourceDir,
      encoding: 'utf8',
    }).trim();
    const releaseDir = join(fixture.root, 'target', 'release');
    const cliHash = sha256(join(releaseDir, 'codex'));
    const hostHash = sha256(join(releaseDir, 'codex-code-mode-host'));
    const pairId = `${sourceCommit.slice(0, 12)}-${cliHash.slice(0, 12)}-${hostHash.slice(0, 12)}`;
    const pairDir = join(fixture.installDir, '.codex-releases', pairId);
    mkdirSync(pairDir, { recursive: true });
    writeExecutable(join(pairDir, 'codex'), 'printf \'corrupt-cli\\n\'');
    writeExecutable(join(pairDir, 'codex-code-mode-host'), 'printf \'corrupt-host\\n\'');
    writeFileSync(join(pairDir, 'codex-pair.json'), '{"schemaVersion":1}\n');

    try {
      const result = runRebuild(fixture);

      expect(result.status).not.toBe(0);
      expect(execFileSync(join(fixture.installDir, 'codex'), { encoding: 'utf8' })).toBe('old-cli\n');
      expect(execFileSync(join(fixture.installDir, 'codex-code-mode-host'), { encoding: 'utf8' }))
        .toBe('old-host\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('retains only three valid managed runtime pairs by default', () => {
    const fixture = createFixture(0);
    const releasesDir = join(fixture.installDir, '.codex-releases');
    mkdirSync(releasesDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const pair = join(
        releasesDir,
        `${String(index).repeat(12)}-${String(index + 1).repeat(12)}-${String(index + 2).repeat(12)}`,
      );
      mkdirSync(pair);
      writeFileSync(join(pair, 'codex-pair.json'), JSON.stringify({
        schemaVersion: 1,
        sourceCommit: String(index).repeat(40),
        source: 'source-build',
        cliSha256: String(index + 1).repeat(64),
        hostSha256: String(index + 2).repeat(64),
      }));
      const timestamp = new Date(1_700_000_000_000 + index * 1_000);
      utimesSync(pair, timestamp, timestamp);
    }

    try {
      const result = runRebuild(fixture);

      expect(result.status, result.stderr).toBe(0);
      const managedPairs = readdirSync(releasesDir).filter((entry) => !entry.startsWith('.'));
      expect(managedPairs).toHaveLength(3);
      expect(managedPairs).toContain(
        basename(dirname(realpathSync(join(fixture.installDir, 'codex')))),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('makes the daily sync use the paired installer instead of replacing only codex', () => {
    const playbook = readFileSync(SYNC_PLAYBOOK, 'utf8');

    expect(playbook).toContain('scripts/rebuild-codex.sh');
    expect(playbook).toContain('codex-code-mode-host');
    expect(playbook).not.toContain('install -m 755 "$BIN" "$KOOKR_CODEX_BIN"');
  });
});
