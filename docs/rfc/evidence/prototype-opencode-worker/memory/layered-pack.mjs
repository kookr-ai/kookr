#!/usr/bin/env node
// layered-pack <project> <role>: print the memory a worker starts with, highest precedence first.
//   1. PROJECT  `<role>@<project>`   cap 4096 B   (wins on conflict)
//   2. DOMAIN   `<role>`             cap 2048 B
//   3. GLOBAL   `fleet-global`       cap 1024 B
// Reads the (read-only) store through `nb show`, fail-open per layer. Lines are kept whole, listing order
// (score-descending) is preserved, an over-cap layer gets a marker naming the omitted count.
import { execFileSync } from 'node:child_process';
const [project, role] = process.argv.slice(2);
if (!project || !role) { console.error('usage: layered-pack <project> <role>'); process.exit(2); }
const CAPS = { project: 4096, domain: 2048, global: 1024 };
const layers = [
  ['PROJECT', `${role}@${project}`, CAPS.project],
  ['DOMAIN', role, CAPS.domain],
  ['GLOBAL', 'fleet-global', CAPS.global],
];
const show = (shelf) => {
  try { return execFileSync('nb', ['show', shelf], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
};
const out = ['# Lessons (if layers disagree, the earlier layer wins: project > domain > global)'];
for (const [name, shelf, cap] of layers) {
  const lines = show(shelf).split('\n').filter((l) => /^[0-9a-f]{4,}\s+\[/.test(l));
  if (!lines.length) continue;
  let used = 0; const kept = [];
  for (const l of lines) { const b = Buffer.byteLength(l) + 1; if (used + b > cap) break; kept.push(l); used += b; }
  out.push(`\n## ${name} (${shelf})`, ...kept);
  if (kept.length < lines.length) out.push(`[... ${lines.length - kept.length} more omitted by the ${cap} B cap: run \`nb show ${shelf}\`]`);
}
console.log(out.join('\n'));
