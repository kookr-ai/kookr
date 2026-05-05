// @vitest-environment jsdom

import React from 'react';
import { describe, expect, test, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderMarkdown, ALLOWED_ELEMENTS } from './markdown.js';

let root: Root;
let container: HTMLDivElement;

function mount(input: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement('div', null, renderMarkdown(input)));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('renderMarkdown — allowlist', () => {
  test('ALLOWED_ELEMENTS does not contain known-dangerous or link tags', () => {
    // Inverted assertion: a tautological "lists only safe tags" check would
    // pass trivially if both the allowlist and the assertion list grew
    // together. Instead, assert that tags with XSS or attribute-injection
    // exposure stay OUT. If a future PR adds one of these to the allowlist,
    // this test fails and forces a review.
    const dangerous = ['a', 'img', 'iframe', 'script', 'form', 'input', 'textarea', 'object', 'embed', 'svg', 'math', 'style', 'link', 'meta', 'button'];
    for (const tag of dangerous) {
      expect(ALLOWED_ELEMENTS as readonly string[]).not.toContain(tag);
    }
  });

  test('rendered DOM contains only allowed tags', () => {
    const el = mount(
      '# Title\n\nSome **bold** and `code` and *italic*.\n\n- one\n- two\n\n```\nfence\n```',
    );
    const walk = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase();
        if (tag !== 'div') {
          expect(ALLOWED_ELEMENTS).toContain(tag as typeof ALLOWED_ELEMENTS[number]);
        }
      }
      node.childNodes.forEach(walk);
    };
    el.childNodes.forEach(walk);
  });
});

describe('renderMarkdown — supported constructs', () => {
  test('bold', () => {
    const el = mount('hello **world** foo');
    const strong = el.querySelector('strong');
    expect(strong?.textContent).toBe('world');
    expect(el.textContent).toBe('hello world foo');
    expect(el.textContent).not.toContain('*');
  });

  test('italic (asterisk)', () => {
    const el = mount('hello *world* foo');
    const em = el.querySelector('em');
    expect(em?.textContent).toBe('world');
    expect(el.textContent).toBe('hello world foo');
  });

  test('italic NOT triggered by underscore (snake_case safe)', () => {
    const el = mount('see config_file_path below');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('see config_file_path below');
  });

  test('inline code', () => {
    const el = mount('run `npm test` now');
    const code = el.querySelector('code');
    expect(code?.textContent).toBe('npm test');
    expect(el.textContent).toBe('run npm test now');
  });

  test('fenced code block', () => {
    const el = mount('before\n\n```\nline1\nline2\n```\n\nafter');
    const pre = el.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('line1\nline2');
  });

  test('fenced code block does NOT apply inline transforms inside', () => {
    const el = mount('```\n**not bold** and `not code`\n```');
    expect(el.querySelector('pre strong')).toBeNull();
    expect(el.querySelector('pre > code')?.textContent).toBe('**not bold** and `not code`');
  });

  test('bullet list', () => {
    const el = mount('- one\n- two\n- three');
    const lis = el.querySelectorAll('ul li');
    expect(lis.length).toBe(3);
    expect(lis[0].textContent).toBe('one');
    expect(lis[2].textContent).toBe('three');
  });

  test('bullet list supports inline formatting in items', () => {
    const el = mount('- **bold** item\n- plain item');
    expect(el.querySelector('ul li strong')?.textContent).toBe('bold');
  });

  test('headings h1-h3 shift to h4-h6', () => {
    const el = mount('# One\n## Two\n### Three');
    expect(el.querySelector('h4')?.textContent).toBe('One');
    expect(el.querySelector('h5')?.textContent).toBe('Two');
    expect(el.querySelector('h6')?.textContent).toBe('Three');
  });

  test('paragraph line breaks render as <br>', () => {
    const el = mount('line one\nline two');
    const p = el.querySelector('p');
    expect(p?.querySelectorAll('br').length).toBe(1);
  });

  test('nested bold around inline code', () => {
    const el = mount('**bold with `code` inside**');
    const strong = el.querySelector('strong');
    expect(strong?.querySelector('code')?.textContent).toBe('code');
    expect(strong?.textContent).toBe('bold with code inside');
  });
});

describe('renderMarkdown — XSS defense', () => {
  test('<script> tags render as literal text', () => {
    const el = mount('<script>alert(1)</script>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
  });

  test('<img onerror> renders as literal text', () => {
    const el = mount('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('markdown link with javascript: scheme renders as literal (no link support in V1)', () => {
    const el = mount('[click](javascript:alert(1))');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('[click](javascript:alert(1))');
  });

  test('HTML inside bold delimiters stays as text, wrapped in <strong>', () => {
    const el = mount('**<b onmouseover=alert(1)>hover</b>**');
    const strong = el.querySelector('strong');
    expect(strong).not.toBeNull();
    // No <b> element is created from the text
    expect(strong?.querySelector('b')).toBeNull();
    expect(strong?.textContent).toBe('<b onmouseover=alert(1)>hover</b>');
  });
});

describe('renderMarkdown — edge cases', () => {
  test('unmatched ** passes through as literal', () => {
    const el = mount('hello **world');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.textContent).toBe('hello **world');
  });

  test('unterminated fenced code renders up to EOF', () => {
    const el = mount('```\nopen fence never closes');
    const code = el.querySelector('pre > code');
    expect(code?.textContent).toBe('open fence never closes');
  });

  test('CRLF normalized to LF', () => {
    const el = mount('line one\r\nline two');
    const p = el.querySelector('p');
    expect(p?.textContent).toBe('line onelinetwo'.replace('linetwo', 'line two')); // sanity
    // No literal \r in output
    expect(el.textContent).not.toContain('\r');
  });

  test('truncates input over 32 KiB with visible marker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = 'x'.repeat(64 * 1024);
    const el = mount(huge);
    expect(el.querySelector('.md-truncated')).not.toBeNull();
    expect(el.querySelector('.md-truncated')?.textContent).toMatch(/truncated/i);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('perf: 10000 "*" characters parses under a loose ceiling (not ReDoS)', () => {
    // This guards against catastrophic-backtracking regressions. The threshold
    // is intentionally loose (500 ms) so CI jitter won't flake the test — a
    // real ReDoS bug in the tokenizer would take seconds, not milliseconds.
    const s = '*'.repeat(10_000);
    const start = performance.now();
    mount(s);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test('empty input produces no children', () => {
    const el = mount('');
    expect(el.children[0]?.children.length).toBe(0);
  });

  test('plain text with no markdown passes through', () => {
    const el = mount('just plain text here.');
    expect(el.textContent).toBe('just plain text here.');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('em')).toBeNull();
    expect(el.querySelector('code')).toBeNull();
  });
});
