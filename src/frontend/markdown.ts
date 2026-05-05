import React from 'react';

/**
 * Minimal, XSS-safe markdown renderer for agent / user messages in the
 * activity panel. See docs/rfc/rfc-activity-panel-ux.md §2.
 *
 * Supported: **bold**, *italic* (asterisk only), `inline code`, ```fenced```
 * code blocks, `- ` / `* ` bullet lists, `#`/`##`/`###` headings.
 *
 * Not supported in V1: links, tables, blockquotes, HTML, underscore-italic
 * (would collide with snake_case), images, task lists, strikethrough.
 *
 * Safety invariants:
 *   1. Linear-time parse.
 *   2. No `dangerouslySetInnerHTML` anywhere in this file.
 *   3. Every emitted element type is in ALLOWED_ELEMENTS.
 *   4. All attacker-controlled strings become text children, never element
 *      types, prop names, or HTML-bearing prop values.
 */

/** The complete allowlist of HTML element types this module can produce. */
export const ALLOWED_ELEMENTS = [
  'p', 'strong', 'em', 'code', 'pre', 'ul', 'li', 'h4', 'h5', 'h6', 'br',
] as const;

/** 32 KiB input cap. Longer input is truncated at a UTF-8 character boundary
 *  and a visible marker paragraph is appended. */
const MAX_INPUT_BYTES = 32 * 1024;

export function renderMarkdown(input: string): React.ReactNode {
  if (typeof input !== 'string') return null;

  // Normalize line endings before any size accounting so that CRLF input
  // is treated identically to LF.
  const normalized = input.replace(/\r\n?/g, '\n');

  const { text, truncated } = truncateUtf8(normalized, MAX_INPUT_BYTES);
  if (truncated) {
    try { console.warn(`[markdown] input truncated at ${MAX_INPUT_BYTES} bytes`); } catch {}
  }

  const blocks = parseBlocks(text);
  const nodes = blocks.map(renderBlock);

  if (truncated) {
    nodes.push(
      React.createElement(
        'p',
        { key: 'md-trunc', className: 'md-truncated' },
        '(message truncated at 32 KiB)',
      ),
    );
  }

  // Wrap in a fragment-equivalent so the caller can embed us in an existing
  // container div (`act-msg-text`) without forcing a wrapper element.
  return React.createElement(React.Fragment, null, ...nodes);
}

// ───────────────────────── Truncation ─────────────────────────

function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return { text: s, truncated: false };
  // Walk back from maxBytes to the nearest character boundary so we never
  // split a multi-byte codepoint. UTF-8 continuation bytes match 10xxxxxx.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

// ───────────────────────── Block parser ─────────────────────────

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'fence'; code: string }
  | { type: 'list'; items: string[] }
  | { type: 'paragraph'; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: opening ``` (optionally with language tag)
    const fenceOpen = /^```[^\n]*$/.exec(line);
    if (fenceOpen) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: 'fence', code: buf.join('\n') });
      continue;
    }

    // Heading
    const h = /^(#{1,3}) +(.+?)\s*$/.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }

    // Bullet list: consecutive lines starting with "- " or "* "
    if (/^[-*] +.+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] +.+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*] +/, ''));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // Blank line → no block
    if (line === '') { i++; continue; }

    // Paragraph: collect until blank line or next block start
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next === '') break;
      if (/^```/.test(next)) break;
      if (/^#{1,3} +/.test(next)) break;
      if (/^[-*] +/.test(next)) break;
      para.push(next);
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

// ───────────────────────── Block renderer ─────────────────────────

function renderBlock(block: Block, idx: number): React.ReactNode {
  switch (block.type) {
    case 'heading': {
      // Shift H1..H3 to H4..H6 so rendered weight doesn't explode layout.
      const tag = block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6';
      return React.createElement(tag, { key: idx, className: 'md-h' }, block.text);
    }
    case 'fence': {
      return React.createElement(
        'pre',
        { key: idx, className: 'md-pre' },
        React.createElement('code', { className: 'md-code-block' }, block.code),
      );
    }
    case 'list': {
      return React.createElement(
        'ul',
        { key: idx, className: 'md-ul' },
        ...block.items.map((item, j) =>
          React.createElement('li', { key: j }, ...renderInline(item)),
        ),
      );
    }
    case 'paragraph': {
      return React.createElement(
        'p',
        { key: idx, className: 'md-p' },
        ...renderInlineWithBreaks(block.text),
      );
    }
  }
}

// ───────────────────────── Inline parser (linear-time) ─────────────────────────

/**
 * Parse inline formatting. Single-pass left-to-right scan with small bounded
 * lookahead. No regex backtracking on attacker-controlled input.
 *
 * Delimiters recognized:
 *   **...**  →  <strong>
 *   *...*    →  <em>            (not immediately adjacent to another *)
 *   `...`    →  <code>          (same-line only)
 */
function renderInline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = '';
  let i = 0;
  let key = 0;

  function flushText() {
    if (buf.length > 0) {
      out.push(buf);
      buf = '';
    }
  }

  while (i < s.length) {
    const c = s[i];

    // Inline code: `...` (same-line, non-empty)
    if (c === '`') {
      const close = s.indexOf('`', i + 1);
      // Code spans stop at newlines per CommonMark; reject if newline found first.
      const nl = s.indexOf('\n', i + 1);
      if (close > i + 1 && (nl === -1 || close < nl)) {
        flushText();
        out.push(React.createElement('code', { key: key++, className: 'md-code' }, s.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }

    // Bold: **...**
    if (c === '*' && s[i + 1] === '*') {
      const close = s.indexOf('**', i + 2);
      if (close > i + 1) {
        const inner = s.slice(i + 2, close);
        if (inner.length > 0) {
          flushText();
          out.push(React.createElement('strong', { key: key++ }, ...renderInline(inner)));
          i = close + 2;
          continue;
        }
      }
    }

    // Italic: *...*  (asterisk only; requires the opening * is not adjacent
    // to another * on either side, to avoid the stray */*/* case)
    if (c === '*' && s[i + 1] !== '*' && s[i - 1] !== '*') {
      // Find a closing * that is also not adjacent to another *
      let j = i + 1;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\n') { j = -1; break; }
        if (ch === '*' && s[j + 1] !== '*' && s[j - 1] !== '*') break;
        j++;
      }
      if (j > i + 1 && j < s.length) {
        const inner = s.slice(i + 1, j);
        if (inner.length > 0 && !inner.includes('\n')) {
          flushText();
          out.push(React.createElement('em', { key: key++ }, ...renderInline(inner)));
          i = j + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flushText();
  return out;
}

/** Renders a paragraph's inline content, converting embedded newlines to
 *  `<br/>` elements so multi-line paragraphs display with line breaks
 *  preserved. */
function renderInlineWithBreaks(s: string): React.ReactNode[] {
  const lines = s.split('\n');
  const out: React.ReactNode[] = [];
  let key = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push(React.createElement('br', { key: `br-${key++}` }));
    out.push(...renderInline(lines[i]));
  }
  return out;
}
