import type { PlaybookParameter } from '../../shared/contracts/playbook.js';

interface MergeParamDefaultsOptions {
  /** Relaunch should preserve the original launch values, including resolved defaults. */
  preserveDefaultFromSnapshot?: boolean;
}

/** Merge last-used values with current playbook parameter defaults. */
export function mergeParamDefaults(
  parameters: PlaybookParameter[],
  snapshot: Record<string, string> | null,
  options: MergeParamDefaultsOptions = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const param of parameters) {
    const stored = snapshot?.[param.name];
    if (param.defaultFrom && !options.preserveDefaultFromSnapshot) {
      result[param.name] = param.default ?? '';
    } else if (param.type === 'select' && param.options && !param.source && stored != null) {
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
