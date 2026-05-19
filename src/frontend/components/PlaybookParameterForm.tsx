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
  const hostCapabilities = useKookrStore((s) => s.hostCapabilities);
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

  // Pin capability-collapsed parameters to their default. When a gated
  // dependency is absent the parameter renders no control, so its submitted
  // value must be the default. Collapse state depends only on the playbook and
  // host capabilities, never on other field edits — hence `values`/`onChange`
  // are intentionally excluded from the dependency list.
  useEffect(() => {
    if (!playbook) return;
    for (const param of playbook.parameters) {
      if (!param.gatedBy || param.default == null) continue;
      if (hostCapabilities[param.gatedBy] !== 'absent') continue;
      if ((values[param.name] ?? '') !== param.default) {
        onChange(param.name, param.default);
      }
    }
  }, [playbook, hostCapabilities]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!playbook || playbook.parameters.length === 0) return null;

  return (
    <div className="schedule-form-params">
      {playbook.parameters.map((param) => {
        const options = resolvedOptions[param.name] ?? param.options;
        const isSelect = param.type === 'select' && options && options.length > 0;
        const useFilterable = isSelect && options.length > FILTERABLE_THRESHOLD;
        // A gated parameter whose dependency is probed `absent` is inert.
        // Collapse it (hide control, pin value to default) when it has a
        // default to pin to; otherwise leave the control plus annotation.
        const gatedAbsent = param.gatedBy != null && hostCapabilities[param.gatedBy] === 'absent';
        const collapsed = gatedAbsent && param.default != null;
        const noteId = `playbook-param-gated-${param.name}`;
        const nameSpan = (
          <span>
            {param.name}
            {param.required ? ' *' : ''}
          </span>
        );
        // When collapsed, no <input>/<select>/<textarea> renders — use a
        // <div> rather than a <label> that labels nothing. The annotation
        // lives OUTSIDE the <label> in both cases so its text is not
        // concatenated into the control's accessible name; the control
        // references it via aria-describedby instead.
        return (
          <div key={param.name} className="schedule-form-field">
            {collapsed ? (
              nameSpan
            ) : (
              <label>
                {nameSpan}
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
                    aria-describedby={gatedAbsent ? noteId : undefined}
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
                    aria-describedby={gatedAbsent ? noteId : undefined}
                  />
                ) : (
                  <input
                    type="text"
                    value={values[param.name] ?? ''}
                    onChange={(e) => onChange(param.name, e.target.value)}
                    placeholder={param.description}
                    aria-describedby={gatedAbsent ? noteId : undefined}
                  />
                )}
              </label>
            )}
            {gatedAbsent && (
              <span
                id={noteId}
                className="playbook-param-gated-note"
                role="status"
                aria-live="polite"
              >
                <code>{param.gatedBy}</code> not detected on host — this parameter has no effect.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
