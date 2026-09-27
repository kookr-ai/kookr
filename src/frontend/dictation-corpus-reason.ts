/** Translate archive diagnostics at the presentation boundary, leaving retry codes intact. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  collection_disabled: 'Recording collection is disabled for this speech service.',
  recording_omitted: 'This recording exceeded the archive capture limit; no partial audio was retained.',
  empty_audio: 'No audio was received to archive.',
  corpus_disk_reserve: 'The archive could not save this example because less than one GiB of free disk space would remain.',
  corpus_queue_full: 'The archive queue was full. This recording was not confirmed saved.',
  corpus_write_failed: 'The archive could not write this recording to disk.',
  corpus_archive_failed: 'This recording could not be saved in the archive.',
  corpus_pending: 'The recording is still being saved. Its edits will be retried.',
  corpus_not_found: 'The recording is no longer available; its audio may not have saved or may have been deleted.',
  corpus_audio_missing_or_invalid: 'The original audio is missing or does not match its saved hash.',
  corpus_audio_mismatch: 'The original audio no longer matches its saved hash.',
  corpus_audio_too_large: 'The audio exceeded the archive size limit and was not retained.',
  corpus_metadata_too_large: 'The recording details exceeded the archive size limit.',
  corpus_owner_mismatch: 'This recording belongs to a different draft or field. Its edits were not saved.',
  corpus_invalid_owner: 'The archive could not validate the draft and field that own this recording.',
  corpus_submission_missing: 'The submitted field snapshot has not been saved yet, so its task cannot be linked.',
  corpus_operation_conflict: 'This save attempt conflicts with an earlier operation; it was not applied.',
  corpus_submission_conflict: 'A different snapshot already exists for this submission; it was not overwritten.',
  corpus_task_conflict: 'This submission is already linked to another task; the association was not changed.',
  corpus_revision_conflict: 'Another review was saved. Reopen the recording to compare revisions.',
  corpus_faithful_requires_complete_audio: 'A faithful reference requires complete, readable audio and confirmation after listening.',
  corpus_annotation_limit: 'This recording reached the limit for retained annotations. No additional edit was saved.',
  corpus_payload_too_large: 'These edits exceeded the archive request size limit and were not saved.',
  corpus_directory_not_private: 'The archive directory does not meet the required private permissions.',
  corpus_unsafe_directory: 'The archive directory could not be opened safely.',
  corpus_unsafe_file: 'An archive file could not be opened safely.',
  corpus_delete_failed: 'The recording could not be deleted. Its current archive state needs to be checked.',
  corpus_invalid_record: 'The archive could not validate this recording and its metadata.',
  corpus_invalid_annotations: 'The saved annotations could not be read safely.',
  corpus_invalid_response: 'The speech service returned an unreadable archive response.',
  corpus_unavailable: 'The archive service is unavailable. Retry when the speech service is reachable.',
  corpus_task_not_acknowledged: 'The server has not confirmed the task associated with this submission.',
  corpus_task_receipt_pending: 'The task acknowledgement is still being retained. Its association will be retried.',
  corpus_receipt_queue_full: 'The task acknowledgement queue is full. Its association is not confirmed yet.',
  corpus_task_receipt_limit: 'The task acknowledgement storage limit was reached. Its association is not confirmed.',
  corpus_response_too_large: 'The archive response exceeds the supported size limit.',
  corpus_response_limit: 'This archive page exceeds the supported size limit.',
  corpus_export_limit: 'The corpus exceeds the size limit for one manifest export.',
  unsupported: 'This speech service does not support corpus capture and annotations.',
  disabled: 'The speech service is disabled; its archive is unavailable here.',
};

export function explainDictationCorpusReason(reason: string): string {
  if (Object.hasOwn(REASON_LABELS, reason)) return REASON_LABELS[reason]!;
  if (reason === 'HTTP 404') return REASON_LABELS.corpus_not_found!;
  if (/^(?:HTTP \d+|[A-Za-z0-9_.:-]+)$/.test(reason)) {
    return 'The archive could not retain this recording or its edits. Dictation and task launch remain available.';
  }
  // Browser retry state already supplies full sentences for local storage limits,
  // unavailable capabilities and incomplete recoveries. Preserve those details.
  return reason;
}
