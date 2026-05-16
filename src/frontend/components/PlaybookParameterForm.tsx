import React, { useState, useEffect } from 'react';
import type { Playbook } from '../../shared/protocol.js';
import type { PlaybookParameterOption } from '../../shared/contracts/playbook.js';
import { useKookrStore } from '../store/useStore.js';
import { resolveParameterSource, mergeSourceAndStaticOptions } from '../store/playbook-source-resolver.js';
import { FilterableSelect } from './FilterableSelect.js';

const FILTERABLE_THRESHOLD = 5;

interface Props {
  playbook: Playbook | null;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}

export function PlaybookParameterForm({ playbook, values, onChange }: Props) {
  const projectSummaries = useKookrStore((s) => s.projectSummaries);
  const [resolvedOptions, setResolvedOptions] = useState<Record<string, PlaybookParameterOption[]>>({});

  // Resolve dynamic sources when playbook or project summaries change
  useEffect(() => {
    if (!playbook) {
      setResolvedOptions({});
      return;
    }

    let cancelled = false;
    const paramsWithSource = playbook.parameters.filter((p) => p.source);
    if (paramsWithSource.length === 0) {
      setResolvedOptions({});
      return;
    }

    Promise.all(
      paramsWithSource.map(async (param) => {
        const sourceOpts = await resolveParameterSource(param.source!, projectSummaries);
        const merged = mergeSourceAndStaticOptions(sourceOpts, param.options);
        return { name: param.name, options: merged };
      }),
    ).then((results) => {
      if (cancelled) return;
      const resolved: Record<string, PlaybookParameterOption[]> = {};
      for (const { name, options } of results) {
        resolved[name] = options;
      }
      setResolvedOptions(resolved);
    }).catch(() => {
      if (!cancelled) setResolvedOptions({});
    });

    return () => { cancelled = true; };
  }, [playbook, projectSummaries]);

  if (!playbook || playbook.parameters.length === 0) return null;

  return (
    <div className="schedule-form-params">
      {playbook.parameters.map((param) => {
        const options = resolvedOptions[param.name] ?? param.options;
        const isSelect = param.type === 'select' && options && options.length > 0;
        const useFilterable = isSelect && options.length > FILTERABLE_THRESHOLD;

        return (
          <label key={param.name} className="schedule-form-field">
            <span>
              {param.name}
              {param.required ? ' *' : ''}
            </span>
            {useFilterable ? (
              <FilterableSelect
                options={options}
                value={values[param.name] ?? ''}
                onChange={(v) => onChange(param.name, v)}
                placeholder={param.description}
              />
            ) : isSelect ? (
              <select
                value={values[param.name] ?? ''}
                onChange={(e) => onChange(param.name, e.target.value)}
              >
                <option value="">Select…</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : param.type === 'textarea' ? (
              <textarea
                rows={3}
                value={values[param.name] ?? ''}
                onChange={(e) => onChange(param.name, e.target.value)}
                placeholder={param.description}
              />
            ) : (
              <input
                type="text"
                value={values[param.name] ?? ''}
                onChange={(e) => onChange(param.name, e.target.value)}
                placeholder={param.description}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
