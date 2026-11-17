// Module-level state that the reset's vi.resetModules() must start fresh in
// every fixture file.
export const moduleState = { touchedBy: undefined as string | undefined };
