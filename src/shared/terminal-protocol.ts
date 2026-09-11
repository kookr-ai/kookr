import { z } from 'zod';

export const TERMINAL_V2_PROTOCOL = 'kookr-terminal.v2';
export const TERMINAL_CREDIT_BYTES = 128 * 1024;
export const TERMINAL_FRAME_BYTES = 8 * 1024;
export const TERMINAL_CONTROL_BYTES = 4096;
export const TERMINAL_INPUT_BYTES = 8_000_000;
export const TERMINAL_CLOSE = {
  lagged: 4408, incompatible: 4409, accessDenied: 4403,
  ended: 4404, continuityLost: 4410, unavailable: 4411,
} as const;

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(128);
const dimensions = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };
const cursorSchema = z.strictObject({ epoch: identity, position, geometryRevision: position, ...dimensions });
const rangeShape = { epoch: identity, start: position, end: position, geometryRevision: position, ...dimensions };
export type TerminalResumeCursor = z.infer<typeof cursorSchema>;

/** Avoid repeated regex groups: valid multi-megabyte pastes can exhaust their stack. */
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf('=');
  return padding === -1 || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding)));
}

const clientSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('attach'), generation: identity, ...dimensions,
    attachId: identity, cursor: cursorSchema.optional(), acceptGap: z.boolean().optional() }),
  z.strictObject({ type: z.literal('ack'), generation: identity, processed: position }),
  z.strictObject({ type: z.literal('input'), generation: identity, text: z.string() }),
  z.strictObject({ type: z.literal('input-bytes'), generation: identity,
    base64: z.string().refine(isBase64) }),
  z.strictObject({ type: z.literal('paste'), generation: identity, text: z.string() }),
  z.strictObject({ type: z.literal('resize'), generation: identity, ...dimensions }),
  z.strictObject({ type: z.literal('request-history'), generation: identity }),
]);
export type TerminalClientControl = z.infer<typeof clientSchema>;

const serverSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), version: z.literal(2), generation: identity,
    creditBytes: z.literal(TERMINAL_CREDIT_BYTES), frameBytes: z.literal(TERMINAL_FRAME_BYTES) }),
  z.strictObject({ type: z.literal('seed-begin'), generation: identity,
    mode: z.enum(['replace', 'resume']), transaction: identity }),
  z.strictObject({ type: z.literal('seed-end'), generation: identity, transaction: identity,
    cursor: cursorSchema.nullable(), historyAvailable: z.boolean(), approximate: z.boolean(),
    screenUnavailable: z.boolean().optional() }),
  z.strictObject({ type: z.literal('source'), generation: identity, ...rangeShape }),
  z.strictObject({ type: z.literal('continuity-unavailable'), generation: identity,
    reason: z.enum(['epoch', 'geometry', 'history', 'checkpoint', 'source-gap']) }),
  z.strictObject({ type: z.literal('history-unavailable'), generation: identity }),
  z.strictObject({ type: z.literal('attach_timing'), generation: identity, protocolVersion: z.literal(2),
    attachId: identity, strategy: z.string().max(64), seedCacheHit: z.boolean(), recoveryUsed: z.boolean(),
    totalMs: z.number().nonnegative(), resizeWaitMs: z.number().nonnegative(), captureMs: z.number().nonnegative(),
    reconstructMs: z.number().nonnegative(), replayBytes: position, earlySeedBytes: position,
    historyAvailable: z.boolean(), attachSeed: z.enum(['viewport', 'full', 'absolute', 'empty']) }),
]);
export type TerminalServerControl = z.infer<typeof serverSchema>;

/** No untyped fallback: malformed envelopes must never become agent input. */
export function parseTerminalClientControl(text: string): TerminalClientControl | null {
  if (text.length > TERMINAL_INPUT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const result = clientSchema.safeParse(parsed);
    if (!result.success) return null;
    if (result.data.type !== 'input' && result.data.type !== 'input-bytes' && result.data.type !== 'paste'
      && new TextEncoder().encode(text).byteLength > TERMINAL_CONTROL_BYTES) return null;
    return result.data;
  } catch { return null; }
}

export function parseTerminalServerControl(text: string): TerminalServerControl | null {
  if (text.length > TERMINAL_CONTROL_BYTES || new TextEncoder().encode(text).byteLength > TERMINAL_CONTROL_BYTES) return null;
  try {
    const result = serverSchema.safeParse(JSON.parse(text));
    if (!result.success) return null;
    if (result.data.type === 'source' && result.data.end <= result.data.start) return null;
    return result.data;
  } catch { return null; }
}
