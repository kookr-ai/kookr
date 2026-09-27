import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteDictationCorpusRecord, dictationCorpusAudioUrl, getDictationCorpusCapabilities,
  getDictationCorpusManifest, getDictationCorpusRecord, getDictationCorpusRecords,
  postDictationAnnotation,
  type CorpusCapabilities, type CorpusRecord, type CorpusReview, type CorpusReviewStatus,
} from '../api/dictation-corpus.js';
import { DictationCorpusStatus } from './DictationCorpusStatus.js';
import { forgetDictationCorpusRecording } from '../store/dictation-corpus.js';
import { createDictationId } from '../store/dictation-recovery.js';
import { ApiError } from '../api/client.js';
import './DictationCorpusPanel.css';

const PAGE_SIZE = 20;
const MAX_CORRECTION_LENGTH = 32_000;
const REVIEW_LABELS: Record<CorpusReviewStatus, string> = {
  candidate: 'Unreviewed candidate', faithful: 'Faithful transcript',
  reformulation: 'Reformulation', excluded: 'Excluded',
};

function latestReview(record: CorpusRecord): CorpusReview | undefined {
  return record.annotations.filter((annotation): annotation is CorpusReview => annotation.kind === 'review').at(-1);
}

interface ReviewRequest {
  operationId: string;
  kind: 'review';
  expectedRevision: number;
  correction: string;
  status: CorpusReviewStatus;
  listened: boolean;
}

function RecordingReview({ record, writable, onUpdated, onDeleted }: {
  record: CorpusRecord;
  writable: boolean;
  onUpdated: (record: CorpusRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const originalReview = latestReview(record);
  const [correction, setCorrection] = useState(originalReview?.correction ?? record.metadata.transcript ?? '');
  const [status, setStatus] = useState<CorpusReviewStatus>(originalReview?.status ?? 'candidate');
  const [revision, setRevision] = useState(record.reviewRevision);
  const [played, setPlayed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const [audioAttempt, setAudioAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<CorpusRecord | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  // A response can disappear after the service saved the review. Retrying the
  // unchanged request must reuse its operation ID to avoid adding a revision.
  const pending = useRef<ReviewRequest | null>(null);
  const eligible = record.archive.status === 'saved' && record.archive.complete
    && record.audioAvailable && record.audio !== null && !audioFailed;
  const faithfulAllowed = eligible && played && confirmed && correction.trim().length > 0;
  const submissions = record.annotations.filter((annotation) => annotation.kind === 'submission');

  function changed() { pending.current = null; setNotice(''); setError(''); setConfirmed(false); }

  async function save() {
    if (!writable || busy || conflict || (status === 'faithful' && !faithfulAllowed)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const request = pending.current ?? {
        operationId: createDictationId(), kind: 'review' as const, expectedRevision: revision,
        correction, status, listened: played && confirmed,
      };
      pending.current = request;
      const result = await postDictationAnnotation(record.id, request);
      if (!result.ok || !result.body || !('annotation' in result.body)) {
        const code = result.body && 'error' in result.body ? result.body.error : '';
        if (result.status === 409 && code === 'corpus_revision_conflict') {
          setConflict(await getDictationCorpusRecord(record.id));
          setError('Another review was saved. Compare it below before saving your correction.');
        } else {
          setError('Review was not confirmed saved. Your correction is still here; retry Save review.');
        }
        return;
      }
      const annotation = result.body.annotation;
      if (annotation.kind !== 'review') throw new Error('Unexpected annotation');
      setRevision(annotation.reviewRevision);
      onUpdated({ ...record, reviewRevision: annotation.reviewRevision,
        annotations: record.annotations.some((item) => item.operationId === annotation.operationId)
          ? record.annotations : [...record.annotations, annotation] });
      pending.current = null;
      setNotice(`Review saved · revision ${annotation.reviewRevision} · ${REVIEW_LABELS[annotation.status]}`);
    } catch {
      setError('Review was not confirmed saved. Your correction is still here; retry Save review.');
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError('');
    try {
      await deleteDictationCorpusRecord(record.id);
      forgetDictationCorpusRecording(record.id);
      onDeleted(record.id);
    } catch { setError('Could not delete this example. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <article className="corpus-record" data-testid={`corpus-record-${record.id}`}>
      <div className="corpus-record-heading">
        <h4>{new Date(record.recordedAt).toLocaleString()}</h4>
        <span>{record.archive.status}{record.archive.complete ? ' · complete' : ' · incomplete'}</span>
      </div>
      <p className="corpus-help">Recording {record.id} · {record.owner?.field ?? record.metadata.source}</p>
      {record.archive.reason && <p className="corpus-help">Archive reason: {record.archive.reason}</p>}
      {record.audioAvailable && record.audio ? (
        <audio
          key={`${record.id}:${audioAttempt}`} controls preload="none" aria-label="Original recording"
          src={dictationCorpusAudioUrl(record.id)}
          onEnded={() => { if (!audioFailed) setPlayed(true); }}
          onError={() => { setAudioFailed(true); setPlayed(false); setConfirmed(false); }}
        />
      ) : <p className="corpus-help">Original audio is unavailable.</p>}
      {!eligible && <p className="corpus-warning">This recording cannot become a verified audio/reference pair because its audio is incomplete or unavailable.</p>}
      {audioFailed && <p role="alert" className="corpus-error">The original audio could not be played.</p>}
      {audioFailed && <button type="button" className="btn-secondary" onClick={() => {
        setAudioFailed(false); setPlayed(false); setConfirmed(false); setAudioAttempt((current) => current + 1);
      }}>Retry audio playback</button>}
      <div className="corpus-comparison">
        <div>
          <h5>Original prediction</h5>
          <pre className="corpus-text">{record.metadata.transcript ?? '(No prediction)'}</pre>
        </div>
        <label className="corpus-field">
          <span>Correction for this recording</span>
          <textarea
            aria-label="Correction for this recording" value={correction}
            maxLength={MAX_CORRECTION_LENGTH} rows={5} disabled={busy || !writable}
            onChange={(event) => { changed(); setCorrection(event.target.value); }}
          />
        </label>
      </div>
      <p className="corpus-help">Correct only what this recording says. Submitted prompts below may include typed additions or other clips and remain separate.</p>
      <label className="corpus-field">
        <span>Review status</span>
        <select aria-label="Review status" value={status} disabled={busy || !writable}
          onChange={(event) => { changed(); setStatus(event.target.value as CorpusReviewStatus); }}>
          {Object.entries(REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="corpus-confirm">
        <input type="checkbox" checked={confirmed} disabled={!writable || !eligible || !played || busy}
          aria-label="I listened to this recording and confirm the correction faithfully transcribes it"
          onChange={(event) => { pending.current = null; setConfirmed(event.target.checked); }} />
        <span>I listened to this recording and confirm the correction faithfully transcribes it.</span>
      </label>
      {!played && eligible && <p className="corpus-help">Play the recording to the end to enable confirmation. An unchanged prediction also needs review.</p>}
      {conflict && (
        <div className="corpus-conflict">
          <h5>Latest saved review · revision {conflict.reviewRevision}</h5>
          <pre className="corpus-text">{latestReview(conflict)?.correction ?? '(No correction)'}</pre>
          <p>{latestReview(conflict) ? REVIEW_LABELS[latestReview(conflict)!.status] : 'Unreviewed'}</p>
          <button type="button" className="btn-secondary" onClick={() => {
            setRevision(conflict.reviewRevision); onUpdated(conflict); setConflict(null);
            pending.current = null; setError('');
          }}>Keep my correction as the next revision</button>
        </div>
      )}
      {error && <p className="corpus-error" role="alert">{error}</p>}
      <p className="corpus-help" role="status">{notice}</p>
      <div className="corpus-actions">
        <button type="button" className="btn-primary" onClick={() => void save()}
          disabled={!writable || busy || conflict !== null || (status === 'faithful' && !faithfulAllowed)}>
          {busy ? 'Saving…' : 'Save review'}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDeleteConfirmation(true)}>Delete example</button>
      </div>
      {deleteConfirmation && <div className="corpus-delete" role="group" aria-label="Confirm example deletion">
        <p>Delete this recording’s original audio and all annotations permanently? This does not delete the launched task.</p>
        <div className="corpus-actions">
          <button type="button" className="btn-danger" disabled={busy} onClick={() => void remove()}>Delete this recording permanently</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDeleteConfirmation(false)}>Cancel deletion</button>
        </div>
      </div>}
      <details className="corpus-details" open={submissions.length > 0}>
        <summary>Submitted field snapshots ({submissions.length})</summary>
        {submissions.length === 0 && <p className="corpus-help">No submitted field snapshot has been retained for this recording.</p>}
        {submissions.map((submission) => {
          const task = record.annotations.find((item) => item.kind === 'task' && item.submissionId === submission.submissionId);
          return <section key={submission.operationId} className="corpus-submission">
            <h5>{submission.field} · {new Date(submission.createdAt).toLocaleString()}</h5>
            <p className="corpus-help">{task?.kind === 'task' ? `Acknowledged task: ${task.taskId}` : 'No acknowledged task association'} · {submission.recordingIds.length} recording(s)</p>
            <pre className="corpus-text">{submission.submittedText}</pre>
            <details><summary>Insertion context</summary>
              <h5>Text before insertion</h5><pre className="corpus-text">{submission.beforeText || '(Empty)'}</pre>
              <h5>Delivered transcription</h5><pre className="corpus-text">{submission.deliveredText}</pre>
            </details>
          </section>;
        })}
      </details>
      <details className="corpus-details">
        <summary>Recognition provenance and original audio</summary>
        <pre className="corpus-text">{JSON.stringify({ metadata: record.metadata, audio: record.audio }, null, 2)}</pre>
      </details>
      <details className="corpus-details">
        <summary>Review history ({record.reviewRevision})</summary>
        {record.annotations.filter((item) => item.kind === 'review').map((review) => <section key={review.operationId}>
          <h5>Revision {review.reviewRevision} · {REVIEW_LABELS[review.status]} · {new Date(review.createdAt).toLocaleString()}</h5>
          <pre className="corpus-text">{review.correction || '(Empty)'}</pre>
        </section>)}
      </details>
    </article>
  );
}

/** Local archive review remains reachable from Settings after either launcher closes. */
export function DictationCorpusPanel() {
  const [capabilities, setCapabilities] = useState<CorpusCapabilities | null>(null);
  const [records, setRecords] = useState<CorpusRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [offset, setOffset] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exportSelection, setExportSelection] = useState('verified');
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async (nextOffset: number) => {
    const sequence = ++requestSequence.current;
    setLoading(true); setError('');
    try {
      const capabilitiesResult = await getDictationCorpusCapabilities();
      if (sequence !== requestSequence.current) return;
      setCapabilities(capabilitiesResult);
      if (!capabilitiesResult.supported) { setRecords([]); return; }
      const page = await getDictationCorpusRecords(nextOffset, PAGE_SIZE);
      if (sequence !== requestSequence.current) return;
      setRecords(page.records); setTruncated(page.truncated); setOffset(nextOffset);
      setSelectedId((current) => page.records.some((record) => record.id === current) ? current : page.records[0]?.id ?? '');
    } catch {
      if (sequence === requestSequence.current) setError('Could not load the dictation corpus. Dictation and task launch remain available.');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(0); return () => { requestSequence.current++; }; }, [load]);

  async function exportManifest() {
    setExporting(true); setError(''); setExportNotice('');
    try {
      const manifest = await getDictationCorpusManifest();
      const selected = { ...manifest, candidates: exportSelection === 'all' ? manifest.candidates : [] };
      const blob = new Blob([JSON.stringify(selected, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `dictation-corpus-v1-${exportSelection}.json`; anchor.click();
      // Let the browser start the download before releasing its object URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNotice(`Exported ${selected.verifiedPairs.length} verified pairs · ${selected.candidates.length} candidates.`);
    } catch (error) {
      setError(error instanceof ApiError && error.status === 413
        ? 'The corpus exceeds the manifest export limit. Individual recordings remain available for review and playback.'
        : 'Could not export the corpus. Try again.');
    }
    finally { setExporting(false); }
  }

  const selected = records.find((record) => record.id === selectedId);
  return (
    <section className="settings-section dictation-corpus" aria-label="Dictation corpus">
      <h4 className="settings-section-title">Dictation corpus</h4>
      <p className="corpus-help">Review recordings, automatic predictions and launch edits. Only a faithful transcript confirmed after listening becomes a verified reference. Nothing is uploaded or used for training.</p>
      <DictationCorpusStatus />
      <div className="corpus-actions"><button type="button" className="btn-secondary" disabled={loading} onClick={() => void load(offset)}>Refresh corpus</button></div>
      {loading && <p role="status">Loading corpus…</p>}
      {error && <p role="alert" className="corpus-error">{error}</p>}
      {capabilities && !capabilities.supported && <p className="corpus-warning">{capabilities.reason === 'disabled'
        ? 'The speech service is disabled. Corpus review is unavailable here.'
        : 'This speech service does not support corpus review. Its recordings and annotations are not available here; dictation remains usable.'}</p>}
      {capabilities?.supported && <>
        {!capabilities.enabled && <p className="corpus-warning">Collection is disabled. Existing recordings remain available for playback, export and deletion; saving reviews is disabled.</p>}
        <div className="corpus-export">
          <label className="corpus-field"><span>Export selection</span>
            <select aria-label="Export selection" value={exportSelection} onChange={(event) => setExportSelection(event.target.value)}>
              <option value="verified">Verified audio/reference pairs only</option>
              <option value="all">Verified pairs and separate candidates</option>
            </select>
          </label>
          <button type="button" className="btn-secondary" disabled={exporting} onClick={() => void exportManifest()}>Export manifest</button>
        </div>
        <p className="corpus-help">The manifest retains hashes, predictions and provenance. Candidates are separate from verified pairs; excluded examples are omitted. Audio stays in the local archive.</p>
        <p role="status" className="corpus-help">{exportNotice}</p>
        {!loading && records.length === 0 && <p>No retained recordings on this page.</p>}
        {records.length > 0 && <label className="corpus-field"><span>Recording</span>
          <select aria-label="Recording" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {records.map((record) => <option key={record.id} value={record.id}>
              {new Date(record.recordedAt).toLocaleString()} · {record.owner?.field ?? record.metadata.source} · {record.metadata.transcript?.slice(0, 60) || '(No prediction)'}
            </option>)}
          </select>
        </label>}
        {(offset > 0 || truncated) && <div className="corpus-actions">
          <button type="button" className="btn-secondary" disabled={loading || offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>Previous recordings</button>
          <button type="button" className="btn-secondary" disabled={loading || !truncated} onClick={() => void load(offset + PAGE_SIZE)}>Next recordings</button>
        </div>}
        {selected && <RecordingReview key={selected.id} record={selected} writable={capabilities.enabled}
          onUpdated={(updated) => setRecords((current) => current.map((record) => record.id === updated.id ? updated : record))}
          onDeleted={(id) => { setRecords((current) => current.filter((record) => record.id !== id)); setSelectedId(records.find((record) => record.id !== id)?.id ?? ''); }} />}
      </>}
    </section>
  );
}
