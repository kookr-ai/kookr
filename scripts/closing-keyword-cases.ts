// Pull request bodies and the issue numbers they close by keyword (issue #3790).
// Shared by the two parsers that must agree: `closingIssueNumbersFromText` in
// scripts/lib/integration-train-core.ts (tested in integration-train.test.ts)
// and `body_closing_numbers` in scripts/kookr-merge.sh (tested in
// kookr-merge.test.ts). Numbers are in order of first appearance.

export const CLOSING_KEYWORD_CASES: Array<{ name: string; body: string; closes: number[] }> = [
  { name: 'a plain keyword', body: 'Closes #1', closes: [1] },
  { name: 'several keywords, any case, optional colon', body: 'fixed #2 and RESOLVES: #3', closes: [2, 3] },
  { name: 'duplicates', body: 'Closes #5, fixes #5\nCloses #5', closes: [5] },
  { name: 'cross-repository references and URLs', body: 'Closes other/repo#9 and Fixes https://github.com/o/r/issues/10', closes: [] },
  { name: 'no keyword', body: 'see #12 for context', closes: [] },
  { name: 'a keyword that ends a longer word', body: 'this prefixes #3 and unfixes #4', closes: [] },
  { name: 'a fenced code block', body: 'Summary\n\n```\nfix: resolve #77 crash\n```\nCloses #8', closes: [8] },
  { name: 'a tilde fence closed only by a matching fence', body: '~~~~\n```\nfixes #77\n~~~~\nfixes #12', closes: [12] },
  { name: 'an unclosed fence runs to the end', body: 'Closes #6\n```\nfixes #77', closes: [6] },
  { name: 'inline code', body: 'the commit `fix: resolve #77 crash` landed; closes #9', closes: [9] },
  { name: 'an HTML comment', body: '<!-- closes #77 -->\ncloses #10', closes: [10] },
  { name: 'an unclosed HTML comment runs to the end', body: 'closes #14\n<!-- fixes #77', closes: [14] },
  { name: 'a comment marker written as inline code', body: 'The marker is `<!--`.\n\nCloses #8', closes: [8] },
  { name: 'a comment marker inside a fence', body: '```\n<!-- kookr-review\n```\nfixes #15', closes: [15] },
  { name: 'a quoted line', body: '> fixes #77\n\ncloses #11', closes: [11] },
  { name: 'CRLF line endings', body: 'Closes #13\r\n```\r\nfixes #77\r\n```\r\n', closes: [13] },
  { name: 'a number longer than 9 digits', body: 'closes #1234567890 and closes #123456789', closes: [123456789] },
  { name: 'an empty body', body: '', closes: [] },
  // issue #3796
  { name: 'a fence inside a nested list item', body: '- step\n  - sub\n\n    ```\n    fix: resolve #77 crash\n    ```\n\nCloses #16', closes: [16] },
  { name: 'an indented code block', body: 'Log:\n\n    fixes #77\n    more\n\nCloses #17', closes: [17] },
  { name: 'an indented list item is prose', body: '- one\n\n    - Closes #18', closes: [18] },
  { name: 'an indented line that continues a paragraph is prose', body: 'Text\n    closes #19', closes: [19] },
  { name: 'inline code that wraps onto the next line', body: 'The commit `fix: resolve\n#77 crash` landed. Closes #20', closes: [20] },
  { name: 'inline code never spans a blank line', body: 'A lone ` here.\n\nCloses #21 and `x`', closes: [21] },
  { name: 'a lazy continuation line of a quote', body: '> the old commit said\nfixes #77 in passing\n\nCloses #22', closes: [22] },
  { name: 'a list item right after a quote is prose', body: '> quoted\n- Closes #23', closes: [23] },
  { name: 'text inside <pre>', body: '<pre>\nfix: resolve #77\n</pre>\nCloses #24', closes: [24] },
  { name: 'an unclosed <pre> runs to the end', body: 'Closes #25\n<PRE class="x">fixes #77', closes: [25] },
];
