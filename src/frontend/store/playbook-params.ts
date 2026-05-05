import type { PlaybookParameter } from '../../core/playbook.js';

/** Merge last-used values with current playbook parameter defaults. */
export function mergeParamDefaults(
  parameters: PlaybookParameter[],
  snapshot: Record<string, string> | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const param of parameters) {
    const stored = snapshot?.[param.name];
    if (param.type === 'select' && param.options && !param.source && stored != null) {
      // Only validate stored value against static options when there's no dynamic source.
      // Params with `source` resolve options at render time — stored values may be valid
      // against the resolved set even if they're not in the static fallback list.
      const valid = param.options.some((opt) => opt.value === stored);
      result[param.name] = valid ? stored : (param.default ?? '');
    } else {
      result[param.name] = stored ?? param.default ?? '';
    }
  }
  return result;
}
