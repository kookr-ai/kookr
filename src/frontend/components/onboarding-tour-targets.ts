/**
 * Single source of truth for which tour-target classes are expected to exist
 * in the live App tree. The Playwright contract test imports this and
 * asserts that each value resolves to ≥ 1 element when the corresponding
 * card is active.
 *
 * Lives in a `.ts` file (not the parent `.tsx`) so the e2e tsconfig
 * — which does not enable `--jsx` — can resolve the import.
 */
export const TOUR_TARGET_CLASSES = ['layout', 'launch', 'findings'] as const;

export type TourTargetClass = typeof TOUR_TARGET_CLASSES[number];
