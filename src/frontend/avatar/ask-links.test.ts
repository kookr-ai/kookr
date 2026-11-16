import { describe, expect, it, vi } from 'vitest';
import { isOpenableUrl, openAskLink, splitLinks } from './ask-links.js';

describe('splitLinks', () => {
  it('cuts text into plain parts and http(s) URLs, leaving sentence punctuation outside', () => {
    expect(splitLinks('See https://claude.ai/artifact/abc. Then http://x.example/a, done')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'url', url: 'https://claude.ai/artifact/abc' },
      { kind: 'text', text: '. Then ' },
      { kind: 'url', url: 'http://x.example/a' },
      { kind: 'text', text: ', done' },
    ]);
  });

  it('keeps a closing parenthesis that belongs to the URL, drops one that closes the sentence', () => {
    expect(splitLinks('(https://en.wikipedia.org/wiki/Foo_(bar))').filter((s) => s.kind === 'url'))
      .toEqual([{ kind: 'url', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' }]);
    expect(splitLinks('(see https://a.example/x)').filter((s) => s.kind === 'url'))
      .toEqual([{ kind: 'url', url: 'https://a.example/x' }]);
  });

  it('never turns other schemes into links', () => {
    expect(splitLinks('javascript:alert(1) ftp://x.example file:///etc/passwd')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) ftp://x.example file:///etc/passwd' },
    ]);
    expect(splitLinks('')).toEqual([]);
  });
});

describe('isOpenableUrl', () => {
  it.each([['https://a.example', true], ['http://a.example/x', true], ['javascript:alert(1)', false], ['https://', false], ['nope', false]])(
    '%s -> %s',
    (url, ok) => expect(isOpenableUrl(url)).toBe(ok),
  );
});

describe('openAskLink', () => {
  it('opens a new tab without noopener (so a blocked tab can be told apart) and cuts the opener', () => {
    const tab = { opener: {} as unknown };
    const open = vi.fn(() => tab as unknown as Window);
    expect(openAskLink('https://a.example', open)).toBe('opened');
    expect(open).toHaveBeenCalledWith('https://a.example', '_blank');
    expect(tab.opener).toBeNull();
  });

  it('reports a blocked tab, a throwing window.open, and refuses a non-http URL without calling it', () => {
    expect(openAskLink('https://a.example', vi.fn(() => null))).toBe('blocked');
    expect(openAskLink('https://a.example', vi.fn(() => { throw new Error('blocked'); }))).toBe('blocked');
    const open = vi.fn();
    expect(openAskLink('javascript:alert(1)', open)).toBe('blocked');
    expect(open).not.toHaveBeenCalled();
  });
});
