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
  { name: 'a quoted line', body: '> fixes #77\ncloses #11', closes: [11] },
  { name: 'CRLF line endings', body: 'Closes #13\r\n```\r\nfixes #77\r\n```\r\n', closes: [13] },
  { name: 'a number longer than 9 digits', body: 'closes #1234567890 and closes #123456789', closes: [123456789] },
  { name: 'an empty body', body: '', closes: [] },
];
