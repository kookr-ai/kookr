export function splitHookRecords(content: string): { records: string[]; consumedChars: number } {
  const records: string[] = [];
  let consumedChars = 0;
  let i = 0;

  while (i < content.length) {
    while (i < content.length && /\s/.test(content[i])) i += 1;
    consumedChars = i;
    if (i >= content.length) break;

    const start = i;
    if (content[i] !== '{') {
      const lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) break;
      records.push(content.slice(start, lineEnd));
      i = lineEnd + 1;
      consumedChars = i;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let complete = false;

    for (; i < content.length; i += 1) {
      const ch = content[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          records.push(content.slice(start, i));
          consumedChars = i;
          complete = true;
          break;
        }
      }
    }

    if (!complete) break;
  }

  return { records, consumedChars };
}

export function splitHookRequestBody(content: string): string[] {
  const records: string[] = [];
  let rest = content;

  while (rest.trim()) {
    const leadingWhitespaceLength = rest.length - rest.trimStart().length;
    if (leadingWhitespaceLength > 0) rest = rest.slice(leadingWhitespaceLength);

    const { records: framedRecords, consumedChars } = splitHookRecords(rest);
    if (framedRecords.length > 0) {
      records.push(...framedRecords);
      rest = rest.slice(consumedChars);
      continue;
    }

    const lineEnd = rest.indexOf('\n');
    if (lineEnd === -1) {
      records.push(rest);
      break;
    }
    records.push(rest.slice(0, lineEnd));
    rest = rest.slice(lineEnd + 1);
  }

  return records;
}
