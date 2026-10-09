import React, { useState, useEffect } from 'react';
import type { TranscriptMessage, TranscriptResponse, TranscriptUnavailableReason } from '../../shared/contracts/transcript.js';
import { getTaskTranscript } from '../api/tasks.js';

const UNAVAILABLE_MESSAGES: Record<TranscriptUnavailableReason, string> = {
  vendor_never_persisted: "This conversation wasn't recorded (the agent's transcript was never written).",
  aged_out: 'This conversation is no longer available (transcript aged out).',
  unsupported_provider: "Transcript viewing isn't supported for this agent yet.",
  not_found: 'Task not found.',
};

export const LEDGER_SOURCE_NOTE =
  'Recovered from activity log — shows the final answer per turn, not every intermediate message';

function ToolMessage({ message }: { message: Extract<TranscriptMessage, { kind: 'tool_call' | 'tool_result' }> }) {
  if (message.kind === 'tool_call') {
    return (
      <details className="transcript-tool" data-testid="transcript-tool-call">
        <summary>Tool call: {message.name}</summary>
        {message.input && <pre>{message.input}</pre>}
      </details>
    );
  }
  return (
    <details className="transcript-tool" data-testid="transcript-tool-result">
      <summary>Tool result{message.name ? `: ${message.name}` : ''}{message.truncated ? ' (truncated)' : ''}</summary>
      <pre>{message.text}</pre>
    </details>
  );
}

function MessageRow({ message }: { message: TranscriptMessage }) {
  switch (message.kind) {
    case 'text':
      return (
        <div className={`transcript-msg-${message.role}`} data-testid={`transcript-${message.role}`}>
          <span className="transcript-msg-label">{message.role === 'assistant' ? 'Assistant' : 'User'}</span>
          {message.text}
        </div>
      );
    case 'truncation_marker':
      return <div className="transcript-view-notice" data-testid="transcript-truncation">{message.note}</div>;
    default:
      return <ToolMessage message={message} />;
  }
}

/** Pure presentation of a fetched transcript. */
function TranscriptBody({ response }: { response: TranscriptResponse }) {
  if ('unavailable' in response) {
    return (
      <div className="transcript-view-status" data-testid="transcript-unavailable" role="status">
        {UNAVAILABLE_MESSAGES[response.unavailable.reason] ?? 'This conversation is unavailable.'}
      </div>
    );
  }
  const { messages } = response;
  let finalIdx = -1;
  messages.forEach((m, i) => { if (m.kind === 'text' && m.role === 'assistant') finalIdx = i; });
  const final = finalIdx >= 0 ? messages[finalIdx] : null;
  return (
    <>
      {response.source === 'ledger' && (
        <div className="transcript-view-notice" data-testid="transcript-ledger-note">{LEDGER_SOURCE_NOTE}</div>
      )}
      {final && final.kind === 'text' && (
        <div data-testid="transcript-final-answer">
          <span className="transcript-msg-label">Final answer</span>
          <div className="transcript-msg-assistant">{final.text}</div>
        </div>
      )}
      {messages.length === 0 && <div className="transcript-view-status">No messages recorded.</div>}
      {messages.map((m, i) => (i === finalIdx ? null : <MessageRow key={i} message={m} />))}
    </>
  );
}

/** Read-only stored conversation for a terminal task, fetched from GET /api/tasks/:id/transcript. */
export function TranscriptView({ taskId, sessionId }: { taskId: string; sessionId?: string }) {
  const [response, setResponse] = useState<TranscriptResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setResponse(null);
    setError(false);
    getTaskTranscript(taskId, controller.signal, sessionId)
      .then((r) => {
        if (controller.signal.aborted) return;
        setResponse(r);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
      });
    return () => controller.abort();
  }, [taskId, sessionId]);

  return (
    <div className="transcript-view" data-testid="transcript-view">
      {error ? (
        <div className="transcript-view-status" data-testid="transcript-error" role="alert">
          Couldn't load the conversation. Try reopening the task.
        </div>
      ) : response ? (
        <TranscriptBody response={response} />
      ) : (
        <div className="transcript-view-status" data-testid="transcript-loading">Loading conversation…</div>
      )}
    </div>
  );
}

/** Visible "View conversation" control under the completion digest; fetches only once opened. */
export function TranscriptToggle({ taskId, sessionId }: { taskId: string; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="transcript-toggle">
      <button type="button" className="pane-control" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="transcript-toggle">
        {open ? 'Hide conversation' : 'View conversation'}
      </button>
      {open && <TranscriptView taskId={taskId} sessionId={sessionId} />}
    </div>
  );
}
