import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface DocumentedCommand {
  file: string;
  line: number;
  text: string;
  source: 'fenced' | 'inline';
}

export interface VerifiedCommand extends DocumentedCommand {
  normalized: string;
}

export interface SkippedCommand extends DocumentedCommand {
  reason: string;
}

export interface DocumentedCommandIssue extends DocumentedCommand {
  message: string;
}

export interface DocumentedCommandVerificationResult {
  checked: VerifiedCommand[];
  skipped: SkippedCommand[];
  issues: DocumentedCommandIssue[];
}

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface RepoCommandContext {
  repoRoot: string;
  packageJson: PackageManifest;
  scripts: Set<string>;
  bins: Map<string, string>;
}

const DEFAULT_DOCUMENTATION_ROOTS = [
  'README.md',
  'docs',
  '.github/ISSUE_TEMPLATE',
  '.github/pull_request_template.md',
];

const EXCLUDED_DOC_DIRS = new Set([
  'cleanup',
  'poc',
  'reports',
  'rfc',
  'social',
  'spikes',
  'system-models',
]);

const SHELL_FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);
const KNOWN_COMMAND_PREFIXES = [
  'pnpm',
  'npm',
  'npx',
  'node',
  'bash',
  'sh',
  'scripts/',
  './scripts/',
  'kookr',
  'kookr-spawn',
  'kookr-status',
  'kookr-ralph',
];

const SAFE_PNPM_SUBCOMMANDS = new Set([
  '--version',
  '-v',
  'add',
  'audit',
  'config',
  'dedupe',
  'exec',
  'install',
  'link',
  'list',
  'outdated',
  'remove',
  'update',
  'why',
]);

const UNSUPPORTED_OR_MANUAL_COMMANDS = new Set([
  'apt',
  'apt-get',
  'brew',
  'cat',
  'cd',
  'chmod',
  'chown',
  'cp',
  'curl',
  'date',
  'docker',
  'find',
  'gh',
  'git',
  'journalctl',
  'mkdir',
  'open',
  'rm',
  'sqlite3',
  'ssh',
  'sudo',
  'systemctl',
  'tail',
  'tee',
  'xdg-open',
]);

export function verifyDocumentedCommands(repoRoot: string): DocumentedCommandVerificationResult {
  const context = buildContext(repoRoot);
  const result: DocumentedCommandVerificationResult = { checked: [], skipped: [], issues: [] };

  for (const file of collectDocumentationFiles(repoRoot)) {
    const content = readFileSync(join(repoRoot, file), 'utf8');
    for (const command of extractDocumentedCommands(file, content)) {
      verifyCommand(command, context, result);
    }
  }

  return result;
}

export function extractDocumentedCommands(file: string, content: string): DocumentedCommand[] {
  const commands: DocumentedCommand[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let shellFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```([A-Za-z0-9_-]*)/);
    if (fence) {
      inFence = !inFence;
      shellFence = inFence && SHELL_FENCE_LANGS.has((fence[1] ?? '').toLowerCase());
      continue;
    }

    if (inFence) {
      if (!shellFence) continue;
      const normalized = normalizeCandidateCommand(line);
      if (isCommandCandidate(normalized)) {
        commands.push({ file, line: index + 1, text: normalized, source: 'fenced' });
      }
      continue;
    }

    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const normalized = normalizeCandidateCommand(match[1]);
      if (isCommandCandidate(normalized)) {
        commands.push({ file, line: index + 1, text: normalized, source: 'inline' });
      }
    }
  }

  return commands;
}

export function collectDocumentationFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const root of DEFAULT_DOCUMENTATION_ROOTS) {
    const absoluteRoot = join(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    const stat = statSync(absoluteRoot);
    if (stat.isFile()) {
      if (isDocumentationFile(root)) files.push(root);
      continue;
    }
    collectDocumentationFilesInDir(repoRoot, root, files);
  }
  return files.sort();
}

function collectDocumentationFilesInDir(repoRoot: string, dir: string, files: string[]): void {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (dir === 'docs' && EXCLUDED_DOC_DIRS.has(entry.name)) continue;
      collectDocumentationFilesInDir(repoRoot, join(dir, entry.name), files);
    } else if (entry.isFile()) {
      const file = join(dir, entry.name);
      if (isDocumentationFile(file)) files.push(file);
    }
  }
}

function isDocumentationFile(file: string): boolean {
  return file.endsWith('.md') || file.endsWith('.yml') || file.endsWith('.yaml');
}

function buildContext(repoRoot: string): RepoCommandContext {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageManifest;
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const bins = new Map<string, string>();
  if (typeof packageJson.bin === 'string') {
    bins.set(packageJson.name ?? 'kookr', packageJson.bin);
  } else {
    for (const [name, path] of Object.entries(packageJson.bin ?? {})) {
      bins.set(name, path);
    }
  }
  return { repoRoot, packageJson, scripts, bins };
}

function verifyCommand(
  command: DocumentedCommand,
  context: RepoCommandContext,
  result: DocumentedCommandVerificationResult,
): void {
  const parts = splitShellChain(command.text);
  if (!parts) {
    result.skipped.push({ ...command, reason: 'compound shell syntax is manual or environment-dependent' });
    return;
  }

  let checkedAny = false;
  for (const part of parts) {
    const check = verifyCommandPart(part, context);
    if (check.kind === 'skip') {
      result.skipped.push({ ...command, text: part, reason: check.reason });
    } else if (check.kind === 'issue') {
      checkedAny = true;
      result.issues.push({ ...command, text: part, message: check.message });
    } else {
      checkedAny = true;
      result.checked.push({ ...command, text: part, normalized: check.normalized });
    }
  }

  if (!checkedAny && parts.length > 1) {
    result.skipped.push({ ...command, reason: 'no checkable command segments found' });
  }
}

function verifyCommandPart(
  command: string,
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  const placeholderReason = getPlaceholderReason(command);
  if (placeholderReason) return { kind: 'skip', reason: placeholderReason };

  const stripped = stripEnvAssignments(command);
  const tokens = tokenize(stripped);
  if (tokens.length === 0) return { kind: 'skip', reason: 'empty command' };

  const executable = tokens[0];
  if (UNSUPPORTED_OR_MANUAL_COMMANDS.has(executable)) {
    return { kind: 'skip', reason: `manual or environment-dependent command: ${executable}` };
  }

  if (executable === 'pnpm') return verifyPnpm(tokens, context);
  if (executable === 'npm') return verifyNpm(tokens, context);
  if (executable === 'npx') return { kind: 'skip', reason: 'npx fetches or resolves external binaries' };
  if (executable === 'node') return verifyNode(tokens, context);
  if (executable === 'bash' || executable === 'sh') return verifyShellScript(tokens, context);
  if (executable === './scripts' || executable.startsWith('scripts/') || executable.startsWith('./scripts/')) {
    return verifyRepoPath(executable, context, 'documented script path');
  }
  if (context.bins.has(executable)) return verifyPackageBin(executable, context);

  return { kind: 'skip', reason: `unsupported command family: ${executable}` };
}

function verifyPnpm(
  tokens: string[],
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  const subcommand = tokens[1];
  if (!subcommand) return { kind: 'skip', reason: 'bare pnpm command' };
  if (subcommand === 'run') {
    const script = tokens[2];
    if (!script) return { kind: 'issue', message: '`pnpm run` is missing a script name' };
    return verifyPackageScript(script, context);
  }
  if (subcommand === 'exec') {
    const binary = tokens.find((token, index) => index > 1 && !token.startsWith('-'));
    if (!binary) return { kind: 'issue', message: '`pnpm exec` is missing a binary name' };
    return verifyNodeBinary(binary, context);
  }
  if (SAFE_PNPM_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'ok', normalized: `pnpm ${subcommand}` };
  }
  return verifyPackageScript(subcommand, context);
}

function verifyNpm(
  tokens: string[],
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  const subcommand = tokens[1];
  if (subcommand === '--version' || subcommand === '-v') return { kind: 'ok', normalized: `npm ${subcommand}` };
  if (subcommand === 'install') return { kind: 'ok', normalized: 'npm install' };
  if (subcommand === 'run') {
    const script = tokens[2];
    if (!script) return { kind: 'issue', message: '`npm run` is missing a script name' };
    return verifyPackageScript(script, context);
  }
  return { kind: 'skip', reason: `unsupported npm subcommand: ${subcommand ?? '<none>'}` };
}

function verifyPackageScript(
  script: string,
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'issue'; message: string } {
  if (context.scripts.has(script)) return { kind: 'ok', normalized: `package script ${script}` };
  return { kind: 'issue', message: `package.json has no script named "${script}"` };
}

function verifyNodeBinary(
  binary: string,
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'issue'; message: string } {
  if (existsSync(join(context.repoRoot, 'node_modules', '.bin', binary))) {
    return { kind: 'ok', normalized: `node_modules/.bin/${binary}` };
  }
  if (context.bins.has(binary)) return verifyPackageBin(binary, context);
  return { kind: 'issue', message: `cannot find executable "${binary}" in node_modules/.bin or package.json#bin` };
}

function verifyPackageBin(
  binary: string,
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'issue'; message: string } {
  const path = context.bins.get(binary);
  if (!path) return { kind: 'issue', message: `package.json has no bin named "${binary}"` };
  if (!existsSync(join(context.repoRoot, path))) {
    return { kind: 'issue', message: `package.json bin "${binary}" points to missing file ${path}` };
  }
  return { kind: 'ok', normalized: `package bin ${binary}` };
}

function verifyNode(
  tokens: string[],
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--import') {
      const importTarget = tokens[index + 1];
      if (importTarget && !isPackageAvailable(importTarget, context)) {
        return { kind: 'issue', message: `node --import target "${importTarget}" is not a dependency` };
      }
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return verifyNodeEntrypoint(token, context);
  }
  return { kind: 'skip', reason: 'node command has no repo-local entrypoint' };
}

function verifyNodeEntrypoint(
  path: string,
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  const result = verifyRepoPath(path, context, 'node entrypoint');
  if (result.kind !== 'issue') return result;
  const normalizedPath = path.startsWith('./') ? path.slice(2) : path;
  const sourcePath = generatedNodeEntrypointSource(normalizedPath, context);
  if (!sourcePath) return result;
  return { kind: 'ok', normalized: `node entrypoint ${normalizedPath} (built from ${sourcePath})` };
}

function verifyShellScript(
  tokens: string[],
  context: RepoCommandContext,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  const script = tokens.find((token, index) => index > 0 && !token.startsWith('-'));
  if (!script) return { kind: 'skip', reason: 'shell command has no script argument' };
  return verifyRepoPath(script, context, 'shell script');
}

function verifyRepoPath(
  path: string,
  context: RepoCommandContext,
  label: string,
): { kind: 'ok'; normalized: string } | { kind: 'skip'; reason: string } | { kind: 'issue'; message: string } {
  if (path.startsWith('/') || path.includes('$') || path.includes('*')) {
    return { kind: 'skip', reason: `${label} is not a literal repo-local path` };
  }
  const normalizedPath = path.startsWith('./') ? path.slice(2) : path;
  if (!existsSync(join(context.repoRoot, normalizedPath))) {
    return { kind: 'issue', message: `${label} does not exist: ${normalizedPath}` };
  }
  return { kind: 'ok', normalized: `${label} ${normalizedPath}` };
}

function generatedNodeEntrypointSource(normalizedPath: string, context: RepoCommandContext): string | undefined {
  if (!normalizedPath.startsWith('dist/') || !normalizedPath.endsWith('.js')) return undefined;
  const sourcePath = `src/${normalizedPath.slice('dist/'.length, -'.js'.length)}.ts`;
  return existsSync(join(context.repoRoot, sourcePath)) ? sourcePath : undefined;
}

function isPackageAvailable(packageName: string, context: RepoCommandContext): boolean {
  return Boolean(context.packageJson.dependencies?.[packageName] ?? context.packageJson.devDependencies?.[packageName]);
}

function splitShellChain(command: string): string[] | undefined {
  if (/[|<>]/.test(command) || command.includes('||') || command.includes('$(') || command.includes('`')) {
    return undefined;
  }
  return command
    .split(/\s+&&\s+|\s+;\s+/)
    .map((part) => stripInlineComment(part.trim()))
    .filter((part) => part.length > 0);
}

function normalizeCandidateCommand(raw: string): string {
  return stripInlineComment(raw.trim().replace(/^\$\s+/, '').replace(/^>\s+/, ''));
}

function stripInlineComment(command: string): string {
  return command.replace(/\s+#.*$/, '').trim();
}

function isCommandCandidate(command: string): boolean {
  if (command.length === 0) return false;
  if (command.startsWith('#')) return false;
  if (command === 'EOF') return false;
  const stripped = stripEnvAssignments(command);
  const executable = tokenize(stripped)[0];
  if (executable && UNSUPPORTED_OR_MANUAL_COMMANDS.has(executable)) return true;
  return KNOWN_COMMAND_PREFIXES.some((prefix) => stripped === prefix || stripped.startsWith(`${prefix} `));
}

function stripEnvAssignments(command: string): string {
  let remaining = command.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining)) {
    const [, rest = ''] = remaining.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*(.*)$/) ?? [];
    remaining = rest.trim();
  }
  return remaining;
}

function tokenize(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ''));
}

function getPlaceholderReason(command: string): string | undefined {
  if (command.includes('...')) return 'contains ellipsis placeholder';
  if (command.includes('<') || command.includes('>')) return 'contains placeholder or redirection-like syntax';
  if (command.includes('{') || command.includes('}')) return 'contains brace placeholder syntax';
  if (command.includes('sk-ant-')) return 'contains secret placeholder';
  if (command.includes('example.com') || command.includes('example.invalid')) return 'contains example host placeholder';
  return undefined;
}

export function formatDocumentedCommandIssues(
  repoRoot: string,
  result: DocumentedCommandVerificationResult,
): string {
  const lines = ['Documented command verification failed:'];
  for (const issue of result.issues) {
    lines.push(`  ${relative(repoRoot, join(repoRoot, issue.file))}:${issue.line} \`${issue.text}\` - ${issue.message}`);
  }
  lines.push(`Checked ${result.checked.length} command segment(s); skipped ${result.skipped.length}.`);
  return lines.join('\n');
}
