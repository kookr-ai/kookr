// Prefilter for reflect-memory-frontmatter-gate.sh. Extracted from an inline
// `node <<'NODE'` heredoc: bash 3.2 (macOS) cannot parse a heredoc nested in a
// $(...) command substitution when the body contains a backtick — the path
// template below has one — so the inline form froze every Write/Edit on macOS.
// Invoked by path with the hook payload in REFLECT_MEMORY_GATE_PAYLOAD; prints
// "memory" (caller continues to the parser) or "skip" (caller allows the edit).
const home = process.env.HOME || '';
let event;
try {
  event = JSON.parse(process.env.REFLECT_MEMORY_GATE_PAYLOAD || '{}');
} catch {
  console.log('memory');
  process.exit(0);
}
const toolName = event.tool_name || '';
if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
  console.log('skip');
  process.exit(0);
}
const input = event.tool_input || {};
const filePath = typeof input.file_path === 'string' ? input.file_path : '';
if (home && filePath.startsWith(`${home}/.claude/projects/`) && filePath.includes('/memory/')) {
  console.log('memory');
} else {
  console.log('skip');
}
