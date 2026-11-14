/**
 * Measures the two model-facing parts of answering a question by voice against the real helper model
 * (needs KOOKR_BASETEN_API_KEY or BASETEN_API_KEY). Run: `node --import tsx scripts/measure-lucy-voice-answer.ts`.
 *
 *  1. The mapping call: spoken words -> one listed choice or none. The near-misses must NOT map to a choice.
 *  2. The persona: questions answered without inventing facts, with a waiting question in the status.
 *     The answers are printed for a person to read; invented facts are judged by eye.
 */
import { createBasetenLlmClientFromEnv } from '../src/adapters/llm/baseten-client.js';
import { readBasetenStreamConfig, streamBasetenChat } from '../src/adapters/llm/baseten-stream.js';
import { buildLucyLivePersona } from '../src/core/lucy-live/persona.js';
import { buildLucyLiveBriefing } from '../src/core/lucy-live/briefing.js';
import { buildAnswerMatchPrompt, parseAnswerMatch, type AnswerMatch, type VoiceAskChoice } from '../src/core/lucy-live/voice-answer.js';
import type { OperatorAskView } from '../src/shared/contracts/asks.js';

const ASK_A: VoiceAskChoice = { askId: 'a1', taskName: 'Cleanup', question: 'When should I run the cleanup of merged worktrees?', options: ['Run it now', 'Run it tonight', 'Skip it'] };
const ASK_B: VoiceAskChoice = { askId: 'a2', taskName: 'Deploy', question: 'Which region should I deploy to?', options: ['Europe', 'United States'] };
const ASK_C: VoiceAskChoice = { askId: 'a3', taskName: 'Cleanup', question: 'Delete the 101 merged worktrees?', options: ['Yes, delete them', 'No, keep them'] };

interface Case { say: string; asks: VoiceAskChoice[]; expect: AnswerMatch | 'not-choice' }
const cases: Case[] = [
  // Clear answers
  { say: 'run it tonight', asks: [ASK_A], expect: { kind: 'choice', askId: 'a1', optionIndex: 1 } },
  { say: 'skip it please', asks: [ASK_A], expect: { kind: 'choice', askId: 'a1', optionIndex: 2 } },
  { say: 'europe', asks: [ASK_A, ASK_B], expect: { kind: 'choice', askId: 'a2', optionIndex: 0 } },
  { say: 'no keep them', asks: [ASK_C], expect: { kind: 'choice', askId: 'a3', optionIndex: 1 } },
  // Near-misses that must not send anything
  { say: 'run it tomorrow', asks: [ASK_A], expect: 'not-choice' },
  { say: 'run it at noon', asks: [ASK_A], expect: 'not-choice' },
  { say: 'asia', asks: [ASK_B], expect: 'not-choice' },
  { say: 'yes', asks: [ASK_A, ASK_B], expect: 'not-choice' },
  { say: 'what is the cleanup question about', asks: [ASK_A], expect: 'not-choice' },
  { say: 'how many tasks are running', asks: [ASK_A], expect: 'not-choice' },
  { say: 'yes delete them', asks: [ASK_A], expect: 'not-choice' }, // answer to a question that is not waiting
  { say: 'tonight', asks: [ASK_A, ASK_B], expect: { kind: 'choice', askId: 'a1', optionIndex: 1 } },
  // One word that only one waiting question lists: mapped, then read back before anything is sent.
  { say: 'skip', asks: [ASK_A, ASK_C], expect: { kind: 'choice', askId: 'a1', optionIndex: 2 } },
  { say: 'delete', asks: [ASK_C, ASK_A], expect: { kind: 'choice', askId: 'a3', optionIndex: 0 } },
  { say: 'thank you', asks: [ASK_A], expect: 'not-choice' },
  { say: 'the second one', asks: [ASK_A, ASK_B], expect: 'not-choice' },
];

async function main(): Promise<void> {
  const client = createBasetenLlmClientFromEnv({ ...process.env, KOOKR_BASETEN_REASONING_EFFORT: 'none' });
  const cfg = readBasetenStreamConfig();
  if (!client || !cfg) throw new Error('no Baseten key');
  let ok = 0; let sentWrong = 0;
  for (const c of cases) {
    const { system, user } = buildAnswerMatchPrompt(c.say, c.asks);
    const raw = await client.complete({ system, userMessage: user, maxTokens: 60, timeoutMs: 8000, responseFormat: { type: 'json_object' } });
    const got = parseAnswerMatch(raw, c.asks);
    const good = c.expect === 'not-choice' ? got.kind !== 'choice' : JSON.stringify(got) === JSON.stringify(c.expect);
    if (good) ok += 1;
    else if (c.expect === 'not-choice' && got.kind === 'choice') sentWrong += 1;
    console.log(`${good ? 'ok  ' : 'FAIL'} "${c.say}" -> ${JSON.stringify(got)}  raw=${raw}`);
  }
  console.log(`\nmapping: ${ok}/${cases.length} as expected; near-misses wrongly mapped to a choice: ${sentWrong}`);

  const asks: OperatorAskView[] = [ASK_A, ASK_B].map((a, i) => ({
    id: a.askId, taskId: `t${i}`, taskName: a.taskName, question: a.question, options: [...a.options], allowText: false,
    state: 'pending', createdAt: Date.now() - 180_000, expiresAt: Date.now() + 3_600_000,
  }));
  const briefing = buildLucyLiveBriefing([], Date.now(), asks);
  const questions = [
    'Which tasks need me?', 'How many tasks are running right now?', 'Is the deploy finished?', 'What did the cleanup task cost?',
    'What are the choices for the deploy question?', 'Did the build pass?', 'Which question has been waiting longest?',
    'Can you pick run it tonight for me?', 'Who wrote the cleanup task?', 'Can you cancel the deploy?',
    'Run it tonight.', 'Yes, send it.',
  ];
  console.log('\npersona answers (read for invented facts):');
  for (const q of questions) {
    let text = '';
    for await (const d of streamBasetenChat(cfg, {
      messages: [{ role: 'system', content: buildLucyLivePersona(briefing) }, { role: 'user', content: q }],
      maxTokens: 200, temperature: 0.3, reasoningEffort: 'none' })) text += d;
    console.log(`Q: ${q}\nA: ${text.trim()}\n`);
  }
}
void main();
