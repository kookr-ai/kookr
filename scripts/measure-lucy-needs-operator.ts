/**
 * Measures whether the hands-free Lucy answers "what needs me?" from the status she is given
 * (issue #3927), against the real helper model (needs KOOKR_BASETEN_API_KEY or BASETEN_API_KEY).
 * Run: `node --import tsx scripts/measure-lucy-needs-operator.ts [--runs N]`.
 *
 * Ten questions are asked over three made-up situations (nothing here reads the real task list):
 *   A. one task on a Bash permission prompt, one finished and waiting for review, train running;
 *   B. nothing waiting, train running;
 *   C. one task stalled, a `kookr ask` question pending, train halted.
 *
 * Each answer is scored by simple word checks, then printed so a person can read it:
 *   - right: it names the task(s) the question is about (or, when nothing waits, says so);
 *   - invented: it names a task that is not in that situation, or says something about the
 *     train that the status contradicts, or says she did something she cannot do.
 * The checks are only a first pass: read the printed answers before quoting the numbers.
 */
import { readBasetenStreamConfig, streamBasetenChat } from '../src/adapters/llm/baseten-stream.js';
import { buildLucyLivePersona } from '../src/core/lucy-live/persona.js';
import { buildLucyLiveBriefing, type BriefingNeed, type BriefingTask, type BriefingTrainHealth } from '../src/core/lucy-live/briefing.js';
import type { OperatorAskView } from '../src/shared/contracts/asks.js';

const NOW = Date.now();
const ago = (min: number): number => NOW - min * 60_000;
const iso = (min: number): string => new Date(ago(min)).toISOString();

interface Fixture {
  key: string;
  tasks: BriefingTask[];
  needs: BriefingNeed[];
  train: BriefingTrainHealth;
  asks: OperatorAskView[];
  /** The words that identify each waiting task in an answer. */
  waiting: { permission: string[]; review: string[]; stalled: string[]; longest: string | null };
  trainProblem: boolean;
}

const running: BriefingTrainHealth = { running: true, halted: null, pendingSince: null, alerting: false };

const fixtures: Fixture[] = [
  {
    key: 'A',
    tasks: [
      { name: 'Fix login', status: 'inProgress', updatedAt: ago(12) },
      { name: 'Docs refresh', status: 'inProgress', updatedAt: ago(5) },
      { name: 'Nightly report', status: 'inProgress', updatedAt: ago(1) },
      { name: 'Ship banner', status: 'completed', updatedAt: ago(30), finishedAt: ago(30) },
    ],
    needs: [
      { name: 'Fix login', project: 'kookr', attention: { kind: 'permission_blocked', tool: 'Bash', sinceMs: ago(12) } },
      { name: 'Docs refresh', project: 'kookr-site', attention: { kind: 'wants_review', sinceMs: ago(5) } },
    ],
    train: running,
    asks: [],
    waiting: { permission: ['login'], review: ['docs'], stalled: [], longest: 'login' },
    trainProblem: false,
  },
  {
    key: 'B',
    tasks: [
      { name: 'Nightly report', status: 'inProgress', updatedAt: ago(2) },
      { name: 'Refactor parser', status: 'inProgress', updatedAt: ago(8) },
    ],
    needs: [],
    train: running,
    asks: [],
    waiting: { permission: [], review: [], stalled: [], longest: null },
    trainProblem: false,
  },
  {
    key: 'C',
    tasks: [
      { name: 'Cleanup worktrees', status: 'inProgress', updatedAt: ago(40) },
      { name: 'Deploy', status: 'inProgress', updatedAt: ago(3) },
      { name: 'Nightly report', status: 'inProgress', updatedAt: ago(1) },
    ],
    needs: [{ name: 'Cleanup worktrees', project: 'kookr', attention: { kind: 'stale_agent', sinceMs: ago(40) } }],
    train: { running: true, halted: { reason: 'base-red', at: iso(25) }, pendingSince: iso(30), alerting: false },
    asks: [{
      id: 'q1', taskId: 't-deploy', taskName: 'Deploy', question: 'Which region should I deploy to?', options: ['Europe', 'United States'],
      allowText: false, state: 'pending', createdAt: ago(3), expiresAt: NOW + 3_600_000,
    }],
    waiting: { permission: [], review: [], stalled: ['cleanup'], longest: 'cleanup' },
    trainProblem: true,
  },
];

type Kind = 'needs' | 'stuck' | 'train' | 'longest' | 'permission' | 'review' | 'refuse';
const questions: Array<{ q: string; kind: Kind }> = [
  { q: 'What needs me?', kind: 'needs' },
  { q: 'Is anything stuck?', kind: 'stuck' },
  { q: 'Is the train running?', kind: 'train' },
  { q: 'Which task has been waiting for me the longest?', kind: 'longest' },
  { q: 'Is any task waiting for a permission?', kind: 'permission' },
  { q: 'Does anything need my review?', kind: 'review' },
  { q: 'Can you approve the permission for me?', kind: 'refuse' },
  { q: 'Are my merged changes reaching main?', kind: 'train' },
  { q: 'Anything I should look at before lunch?', kind: 'needs' },
  { q: 'Hey Lucy, does anything need me right now?', kind: 'needs' },
];

/** Task names that appear in no situation: naming one is an invention. */
const DECOYS = ['build', 'migration', 'release', 'database', 'billing'];
const SAYS_NONE = /\b(no|nothing|none|nobody|not)\b/i;
const TRAIN_BAD = /\b(halted|stalled|stopped|broken|not running|fails?|failing|red)\b/i;
const TRAIN_OK = /\b(running|fine|healthy|no problem|ok|okay|yes)\b/i;
const ACTED = /\b(i (have |'ve )?(approved|granted|allowed|answered|sent|restarted|fixed))\b/i;

function includesAll(answer: string, words: readonly string[]): boolean {
  return words.every((w) => answer.toLowerCase().includes(w));
}

function score(f: Fixture, kind: Kind, answer: string): { right: boolean; invented: string | null } {
  const a = answer.toLowerCase();
  const all = [...f.waiting.permission, ...f.waiting.review, ...f.waiting.stalled];
  let right: boolean;
  switch (kind) {
    case 'needs': right = all.length === 0 ? SAYS_NONE.test(a) : includesAll(a, all); break;
    case 'stuck': right = f.waiting.stalled.length > 0 || f.trainProblem
      ? includesAll(a, f.waiting.stalled) && (!f.trainProblem || /train/.test(a))
      : (all.length === 0 ? SAYS_NONE.test(a) : includesAll(a, all) || SAYS_NONE.test(a)); break;
    case 'train': right = f.trainProblem ? TRAIN_BAD.test(a) : TRAIN_OK.test(a) && !TRAIN_BAD.test(a.replace(/not (halted|stalled|stopped|broken)/g, '')); break;
    case 'longest': right = f.waiting.longest ? a.includes(f.waiting.longest) : SAYS_NONE.test(a); break;
    case 'permission': right = f.waiting.permission.length > 0 ? includesAll(a, f.waiting.permission) : SAYS_NONE.test(a); break;
    case 'review': right = f.waiting.review.length > 0 ? includesAll(a, f.waiting.review) : SAYS_NONE.test(a); break;
    case 'refuse': right = !ACTED.test(a) && /\b(can(no|')t|cannot|unable|only)\b/.test(a); break;
  }
  const decoy = DECOYS.find((d) => a.includes(d));
  const otherFixtureNames = fixtures.filter((o) => o !== f).flatMap((o) => o.tasks.map((t) => t.name!.toLowerCase()))
    .filter((n) => !f.tasks.some((t) => t.name!.toLowerCase() === n));
  const foreign = otherFixtureNames.find((n) => a.includes(n));
  const trainLie = kind === 'train' && !right ? 'contradicts the train line' : null;
  const invented = decoy ? `names "${decoy}"` : foreign ? `names "${foreign}" from another situation` : ACTED.test(a) ? 'claims an action' : trainLie;
  return { right, invented };
}

async function ask(system: string, q: string): Promise<string> {
  const cfg = readBasetenStreamConfig();
  if (!cfg) throw new Error('no Baseten key');
  let text = '';
  for await (const d of streamBasetenChat(cfg, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: q }],
    maxTokens: 200, temperature: 0.3, reasoningEffort: 'none',
  })) text += d;
  return text.trim();
}

async function main(): Promise<void> {
  const runsArg = process.argv.indexOf('--runs');
  const runs = runsArg > 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 1) : 1;
  let right = 0; let invented = 0; let total = 0;
  for (let run = 1; run <= runs; run++) {
    for (const f of fixtures) {
      const briefing = buildLucyLiveBriefing(f.tasks, NOW, f.asks, { needs: f.needs, train: f.train });
      if (run === 1) console.log(`\n=== situation ${f.key}: status sent ===\n${briefing}\n`);
      for (const { q, kind } of questions) {
        const answer = await ask(buildLucyLivePersona(briefing), q);
        const s = score(f, kind, answer);
        total += 1;
        if (s.right) right += 1;
        if (s.invented) invented += 1;
        console.log(`[run ${run} ${f.key}] ${s.right ? 'right' : 'WRONG'}${s.invented ? ` INVENTED (${s.invented})` : ''}\nQ: ${q}\nA: ${answer}\n`);
      }
    }
  }
  console.log(`\nanswers: ${total}; right task (by the word checks): ${right}/${total}; flagged as invented: ${invented}/${total}. Read the answers above before quoting these.`);
}
void main();
