import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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

function createFixture(
  hostBuildExit: number,
  releaseDownloadSucceeds = false,
  cliBuildExit = 0,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kookr-codex-pair-'));
  const sourceDir = join(root, 'codex');
  const codexRsDir = join(sourceDir, 'codex-rs');
  const targetDir = join(root, 'target');
  const releaseDir = join(targetDir, 'release');
  const installDir = join(root, 'install');
  const stubBin = join(root, 'bin');
  const cargoLog = join(root, 'cargo.log');
  const curlLog = join(root, 'curl.log');
  const releaseArchive = join(root, 'release-host.tgz');

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
  if (releaseDownloadSucceeds) {
    execFileSync('git', ['tag', 'rust-v0.145.0-alpha.4'], { cwd: sourceDir });
    const releaseHostDir = join(root, 'release-host');
    mkdirSync(releaseHostDir);
    writeExecutable(join(releaseHostDir, 'codex-code-mode-host'), 'printf \'release-host\\n\'');
    execFileSync('tar', ['-czf', releaseArchive, '-C', releaseHostDir, 'codex-code-mode-host']);
  }

  writeExecutable(
    join(stubBin, 'cargo'),
    `printf '%s\\n' "$*" >> ${JSON.stringify(cargoLog)}
case " $* " in
  *" metadata "*) printf '%s\\n' ${JSON.stringify(JSON.stringify({
    target_directory: targetDir,
    packages: [{ name: 'codex-cli', version: '0.145.0-alpha.4' }],
  }))} ;;
  *" -p codex-cli "*) exit ${cliBuildExit} ;;
  *" -p codex-code-mode-host "*) exit ${hostBuildExit} ;;
  *) exit 0 ;;
esac`,
  );
  writeExecutable(
    join(stubBin, 'curl'),
    releaseDownloadSucceeds
      ? `printf '%s\\n' "$*" > ${JSON.stringify(curlLog)}
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift
done
test -n "$output"
cp ${JSON.stringify(releaseArchive)} "$output"`
      : `printf '%s\\n' "$*" > ${JSON.stringify(curlLog)}
exit 22`,
  );
  writeExecutable(
    join(stubBin, 'uname'),
    `case "$1" in
  -s) printf '%s\\n' "$TEST_UNAME_S" ;;
  -m) printf '%s\\n' "$TEST_UNAME_M" ;;
  *) exit 2 ;;
esac`,
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
      TEST_UNAME_S: 'Linux',
      TEST_UNAME_M: 'x86_64',
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
      expect(result.stderr).toContain('release tag rust-v0.145.0-alpha.4 is not available');
      expect(existsSync(fixture.curlLog)).toBe(false);
      expect(execFileSync(join(fixture.installDir, 'codex'), { encoding: 'utf8' })).toBe('old-cli\n');
      expect(execFileSync(join(fixture.installDir, 'codex-code-mode-host'), { encoding: 'utf8' }))
        .toBe('old-host\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('leaves the active pair unchanged when the CLI build fails', () => {
    const fixture = createFixture(0, false, 1);
    try {
      const result = runRebuild(fixture);

      expect(result.status).not.toBe(0);
      expect(readFileSync(fixture.cargoLog, 'utf8')).toContain('-p codex-cli');
      expect(execFileSync(join(fixture.installDir, 'codex'), { encoding: 'utf8' })).toBe('old-cli\n');
      expect(execFileSync(join(fixture.installDir, 'codex-code-mode-host'), { encoding: 'utf8' }))
        .toBe('old-host\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('activates a release host only when its tag matches the checkout', () => {
    const fixture = createFixture(1, true);
    try {
      const result = runRebuild(fixture);

      expect(result.status, result.stderr).toBe(0);
      const hostPath = join(fixture.installDir, 'codex-code-mode-host');
      expect(execFileSync(hostPath, { encoding: 'utf8' })).toBe('release-host\n');
      expect(readFileSync(fixture.curlLog, 'utf8')).toContain(
        '/rust-v0.145.0-alpha.4/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
      );
      const manifest = JSON.parse(
        readFileSync(join(dirname(realpathSync(hostPath)), 'codex-pair.json'), 'utf8'),
      );
      expect(manifest.source).toBe('release:rust-v0.145.0-alpha.4');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a release tag whose code-mode sources differ from the checkout', () => {
    const fixture = createFixture(1, true);
    const runtimeDir = join(fixture.sourceDir, 'codex-rs', 'code-mode-runtime');
    mkdirSync(runtimeDir);
    writeFileSync(join(runtimeDir, 'protocol.txt'), 'changed after release\n');
    execFileSync('git', ['add', 'codex-rs/code-mode-runtime/protocol.txt'], { cwd: fixture.sourceDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'change protocol'], { cwd: fixture.sourceDir });
    try {
      const result = runRebuild(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('does not match the checkout code-mode protocol');
      expect(existsSync(fixture.curlLog)).toBe(false);
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
      const currentPath = join(fixture.installDir, '.codex-current');
      expect(lstatSync(cliPath).isSymbolicLink()).toBe(true);
      expect(lstatSync(hostPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(cliPath)).toBe('.codex-current/codex');
      expect(readlinkSync(hostPath)).toBe('.codex-current/codex-code-mode-host');
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
      const cargoInvocations = readFileSync(fixture.cargoLog, 'utf8');
      expect(cargoInvocations).toContain('-p codex-cli');
      expect(cargoInvocations).toContain('-p codex-code-mode-host');
      expect(execFileSync(join(fixture.installDir, '.codex-legacy-pair', 'codex'), {
        encoding: 'utf8',
      })).toBe('old-cli\n');
      expect(execFileSync(join(fixture.installDir, '.codex-legacy-pair', 'codex-code-mode-host'), {
        encoding: 'utf8',
      })).toBe('old-host\n');

      const firstCurrentTarget = readlinkSync(currentPath);
      expect(firstCurrentTarget).toBe(`.codex-releases/${basename(dirname(realpathSync(cliPath)))}`);
      writeExecutable(join(fixture.root, 'target', 'release', 'codex'), 'printf \'newer-cli\\n\'');
      writeExecutable(
        join(fixture.root, 'target', 'release', 'codex-code-mode-host'),
        'printf \'newer-host\\n\'',
      );

      const secondResult = runRebuild(fixture);
      expect(secondResult.status, secondResult.stderr).toBe(0);
      expect(readlinkSync(cliPath)).toBe('.codex-current/codex');
      expect(readlinkSync(hostPath)).toBe('.codex-current/codex-code-mode-host');
      expect(readlinkSync(currentPath)).not.toBe(firstCurrentTarget);
      expect(execFileSync(cliPath, { encoding: 'utf8' })).toBe('newer-cli\n');
      expect(execFileSync(hostPath, { encoding: 'utf8' })).toBe('newer-host\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('selects a release host for the current operating system and architecture', () => {
    const fixture = createFixture(1, true);
    fixture.env.TEST_UNAME_S = 'Darwin';
    fixture.env.TEST_UNAME_M = 'arm64';
    try {
      const result = runRebuild(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(fixture.curlLog, 'utf8')).toContain(
        'codex-code-mode-host-aarch64-apple-darwin.tar.gz',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('leaves the active pair unchanged on an unsupported release platform', () => {
    const fixture = createFixture(1, true);
    fixture.env.TEST_UNAME_S = 'Plan9';
    fixture.env.TEST_UNAME_M = 'mips';
    try {
      const result = runRebuild(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('no code-mode host release target for Plan9 mips');
      expect(execFileSync(join(fixture.installDir, 'codex'), { encoding: 'utf8' })).toBe('old-cli\n');
      expect(execFileSync(join(fixture.installDir, 'codex-code-mode-host'), { encoding: 'utf8' }))
        .toBe('old-host\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('cleans temporary directories safely when TMPDIR contains spaces', () => {
    const fixture = createFixture(1, true);
    const tempPrefix = join(fixture.root, 'temp');
    const tempWithSpaces = join(fixture.root, 'temp with spaces');
    mkdirSync(tempPrefix);
    mkdirSync(tempWithSpaces);
    writeFileSync(join(tempPrefix, 'sentinel'), 'keep me\n');
    fixture.env.TMPDIR = tempWithSpaces;
    try {
      const result = runRebuild(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(tempPrefix, 'sentinel'), 'utf8')).toBe('keep me\n');
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
    const oldPairNames: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const pairName = `${String(index).repeat(12)}-${String(index + 1).repeat(12)}-${String(index + 2).repeat(12)}`;
      oldPairNames.push(pairName);
      const pair = join(releasesDir, pairName);
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
    const malformedPair = 'aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc';
    mkdirSync(join(releasesDir, malformedPair));
    writeFileSync(join(releasesDir, malformedPair, 'codex-pair.json'), '{"schemaVersion":1}\n');
    const foreignDirectory = 'foreign-runtime';
    mkdirSync(join(releasesDir, foreignDirectory));
    writeFileSync(join(releasesDir, foreignDirectory, 'sentinel'), 'keep me\n');

    try {
      const result = runRebuild(fixture);

      expect(result.status, result.stderr).toBe(0);
      const entries = readdirSync(releasesDir);
      const activePair = basename(dirname(realpathSync(join(fixture.installDir, 'codex'))));
      expect(entries).toEqual(expect.arrayContaining([
        activePair,
        oldPairNames[2],
        oldPairNames[3],
        malformedPair,
        foreignDirectory,
      ]));
      expect(entries).not.toContain(oldPairNames[0]);
      expect(entries).not.toContain(oldPairNames[1]);
      expect([activePair, ...oldPairNames].filter((entry) => entries.includes(entry))).toHaveLength(3);
      expect(readFileSync(join(releasesDir, foreignDirectory, 'sentinel'), 'utf8')).toBe('keep me\n');
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
