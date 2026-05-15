import type { CommandEnvelope, CommandJournal, CommandResult } from './command-journal.js';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface RemoteCommandHandler<Req extends CommandEnvelope, Res> {
  action: Req['action'];
  authorize(req: Req): ValidationResult | Promise<ValidationResult>;
  validate(req: Req): ValidationResult | Promise<ValidationResult>;
  execute(req: Req): Promise<Res>;
}

export async function executeWithPipeline<Req extends CommandEnvelope, Res>(
  opts: {
    journal: CommandJournal;
    handler: RemoteCommandHandler<Req, Res>;
    request: Req;
    isOwnerLocal: (identity: { actorId?: string; ownerId?: string; local?: boolean }) => boolean;
  },
): Promise<CommandResult<Res>> {
  const { journal, handler, request } = opts;
  if (request.action !== handler.action) {
    return await journal.appendPreAuditReject(request, `handler mismatch for action ${request.action}`) as CommandResult<Res>;
  }
  if (!opts.isOwnerLocal({ actorId: request.actorId })) {
    return await journal.appendPreAuditReject(request, 'owner identity required') as CommandResult<Res>;
  }
  if (journal.hasTombstone(request.grantId)) {
    return await journal.appendPreAuditReject(request, 'grant revoked') as CommandResult<Res>;
  }
  const authorization = await handler.authorize(request);
  if (!authorization.ok) {
    return await journal.appendPreAuditReject(request, authorization.reason) as CommandResult<Res>;
  }
  const validation = await handler.validate(request);
  if (!validation.ok) {
    return await journal.appendPreAuditReject(request, validation.reason) as CommandResult<Res>;
  }
  const replay = journal.begin(request);
  if (replay) return replay as CommandResult<Res>;

  await journal.appendIntent(request);
  try {
    const result = await handler.execute(request);
    const accepted: CommandResult<Res> = {
      commandId: request.commandId,
      action: request.action,
      outcome: 'accepted',
      result,
    };
    await journal.appendResult(request, accepted);
    return accepted;
  } catch (err) {
    const rejected: CommandResult<Res> = {
      commandId: request.commandId,
      action: request.action,
      outcome: 'rejected',
      reason: err instanceof Error ? err.message : String(err),
    };
    await journal.appendResult(request, rejected);
    return rejected;
  }
}
