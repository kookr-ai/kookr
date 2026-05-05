import React from 'react';
import type { Playbook } from '../../shared/protocol.js';

interface Props {
  playbooks: Playbook[];
  value: string;
  onChange: (value: string) => void;
}

export function PlaybookSelector({ playbooks, value, onChange }: Props) {
  return (
    <label className="schedule-form-field">
      <span>Playbook</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a playbook</option>
        {playbooks.map((playbook) => (
          <option key={playbook.id} value={playbook.id}>
            {playbook.name}
          </option>
        ))}
      </select>
    </label>
  );
}
