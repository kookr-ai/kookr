import './DictationCorpusStatus.css';
import React, { useEffect, useSyncExternalStore } from 'react';
import { explainDictationCorpusReason } from '../dictation-corpus-reason.js';
import {
  dictationCorpusVersion, subscribeDictationCorpus, listDictationLinks, listDictationSubmissions,
  retryDictationCorpus, discardDictationCorpusEntry, resumeDictationCorpusRetries,
} from '../store/dictation-corpus.js';

/** Compact archive feedback stays separate from the task's ability to launch. */
export function DictationCorpusStatus({ draftId }: { draftId?: string }) {
  useSyncExternalStore(subscribeDictationCorpus, dictationCorpusVersion, dictationCorpusVersion);
  useEffect(() => {
    resumeDictationCorpusRetries();
    const onStorage = () => { resumeDictationCorpusRetries(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [draftId]);
  const submissions = listDictationSubmissions().filter(entry => !draftId || entry.draftId === draftId);
  const entries = [...listDictationLinks().filter(entry => (!draftId || entry.draftId === draftId) && !submissions.some(submission => submission.fields.some(field => field.recordings.some(link => link.id === entry.id)))), ...submissions];
  if (!entries.length) return null;
  return <div className="dictation-corpus-status" role="group" aria-label="Dictation archive status">
    {entries.map(entry => <div className="dictation-corpus-status-entry" key={entry.id}>
      <span role="status">Dictation {'fields' in entry ? 'edits' : 'audio'}: {entry.status}.
        {entry.reason ? ` ${explainDictationCorpusReason(entry.reason)}` : ''}
        {!entry.persisted ? ' Browser storage unavailable; keep this tab open.' : ''}
        {'fields' in entry && entry.taskId ? ' Task linked.' : ''}
        {'fields' in entry && entry.launchError ? ' Task launch failed; no task linked.' : ''}
        {'fields' in entry && entry.associationError && !entry.taskId ? ' Task association is pending or unavailable; the launch itself may have succeeded.' : ''}
      </span>
      {(entry.status === 'failed' || entry.status === 'pending') && <button className="btn-secondary" type="button" onClick={() => { void retryDictationCorpus(entry.id); }}>Retry archive</button>}
      <button className="btn-secondary" type="button" onClick={() => discardDictationCorpusEntry(entry.id)}>Discard local retry</button>
    </div>)}
    <small>Review recordings in Settings → Dictation corpus. Retry drafts expire after 7 days. Archival never prevents Launch.</small>
  </div>;
}
