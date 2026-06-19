// Path extractor for plugin/hooks/placement-gate.sh.
//
// Reads the hook event JSON from the PLACEMENT_GATE_PAYLOAD env var and prints
// the write-target paths (one per line) that the gate should inspect.
//
// This logic used to live in a `node <<'NODE'` heredoc inside a `$(...)`
// command substitution in placement-gate.sh. macOS ships bash 3.2, whose
// parser cannot handle a heredoc nested inside command substitution when the
// body contains shell-significant characters (e.g. a backtick) — it misreads
// the body as shell and aborts with "unexpected EOF while looking for matching
// `". That parse failure made the hook exit non-zero, which PreToolUse treats
// as a block, freezing every Bash/Edit/Write call. Shipping the program as a
// standalone file keeps the shell side bash-3.2-safe.

let event = {};
try {
  event = JSON.parse(process.env.PLACEMENT_GATE_PAYLOAD || '{}');
} catch {
  process.exit(0);
}
const toolName = event.tool_name || event.toolName || '';
const input = event.tool_input || event.toolInput || {};

function cleanPath(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || /[$`]/.test(trimmed)) return '';
  return trimmed;
}

function emit(paths) {
  for (const path of paths.map(cleanPath).filter(Boolean)) {
    console.log(path);
  }
}

function parseBashWriteTargets(command) {
  if (typeof command !== 'string') return [];
  const tokens = shellTokens(command);
  const targets = [];
  let words = [];

  function finishCommand() {
    if (words.length === 0) return;
    const commandName = words[0];
    if (commandName === 'tee') {
      for (const word of words.slice(1)) {
        if (!word.startsWith('-')) targets.push(word);
      }
    } else if (commandName === 'cp' || commandName === 'mv') {
      const operands = words.slice(1).filter((word) => !word.startsWith('-'));
      if (operands.length >= 2) targets.push(operands[operands.length - 1]);
    }
    words = [];
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === ';' || token === '&&' || token === '||' || token === '|') {
      finishCommand();
    } else if (token === '>' || token === '>>') {
      if (['cat', 'printf', 'echo'].includes(words[0]) && tokens[index + 1]) {
        targets.push(tokens[index + 1]);
      }
      index += 1;
    } else if (token === '<' || token === '<<') {
      index += 1;
    } else {
      words.push(token);
    }
  }
  finishCommand();
  return targets;
}

function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = '';

  function pushCurrent() {
    if (current) {
      tokens.push(current);
      current = '';
    }
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] || '';
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      pushCurrent();
    } else if (char === '>' || char === '<') {
      pushCurrent();
      if (next === char) {
        tokens.push(char + next);
        index += 1;
      } else {
        tokens.push(char);
      }
    } else if (char === ';' || char === '|') {
      pushCurrent();
      if (char === '|' && next === '|') {
        tokens.push('||');
        index += 1;
      } else {
        tokens.push(char);
      }
    } else if (char === '&' && next === '&') {
      pushCurrent();
      tokens.push('&&');
      index += 1;
    } else {
      current += char;
    }
  }
  pushCurrent();
  return tokens;
}

if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
  emit([input.file_path, input.path]);
} else if (toolName === 'Bash') {
  emit(parseBashWriteTargets(input.command || input.cmd || ''));
}
