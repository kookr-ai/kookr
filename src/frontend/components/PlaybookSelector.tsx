import React from 'react';
import type { Playbook } from '../../shared/protocol.js';

interface Props {
  playbooks: Playbook[];
  value: string;
  onChange: (value: string) => void;
}

/** Stable DOM value for a concrete catalog resource, including shadowed ids. */
export function playbookSelectionKey(
  playbook: Pick<Playbook, 'id' | 'scope' | 'sourceCwd' | 'sourceDigest'>,
): string {
  return JSON.stringify([
    playbook.id,
    playbook.scope,
    playbook.sourceCwd,
    playbook.sourceDigest ?? '',
  ]);
}

export function PlaybookSelector({ playbooks, value, onChange }: Props) {
  const duplicateIds = new Set(
    playbooks
      .map((playbook) => playbook.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  );
  return (
    <label className="schedule-form-field">
      <span>Playbook</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a playbook</option>
        {playbooks.map((playbook) => (
          <option key={playbookSelectionKey(playbook)} value={playbookSelectionKey(playbook)}>
            {playbook.name}{duplicateIds.has(playbook.id) ? ` (${playbook.scope})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
