import { describe, expect, it } from 'vitest';

import { hostedRelayStatusFromEnv } from './hosted-relay-config.js';

describe('hostedRelayStatusFromEnv', () => {
  it('enables terminal viewing only when the hosted relay is available and gates passed', () => {
    const status = hostedRelayStatusFromEnv({
      KOOKR_HOSTED_RELAY_ENABLED: 'true',
      KOOKR_HOSTED_RELAY_OPS_GATES_MET: 'true',
      KOOKR_HOSTED_RELAY_MODE: 'available',
      KOOKR_HOSTED_RELAY_URL: 'https://relay.example.test',
    });

    expect(status.configured).toBe(true);
    expect(status.terminalViewing).toEqual({
      enabled: true,
      disabledTenants: 0,
    });
  });

  it('keeps terminal viewing blocked when production gates have not passed', () => {
    const status = hostedRelayStatusFromEnv({
      KOOKR_HOSTED_RELAY_ENABLED: 'true',
      KOOKR_HOSTED_RELAY_OPS_GATES_MET: 'false',
      KOOKR_HOSTED_RELAY_MODE: 'available',
      KOOKR_HOSTED_RELAY_URL: 'https://relay.example.test',
    });

    expect(status.configured).toBe(false);
    expect(status.terminalViewing).toEqual({
      enabled: false,
      blockReason: 'hosted-relay-production-gate',
      disabledTenants: 0,
    });
  });

  it.each([
    ['maintenance', 'hosted-relay-maintenance'],
    ['emergencyDisabled', 'hosted-relay-emergency-disabled'],
  ] as const)(
    'keeps terminal viewing blocked when hosted relay mode is %s',
    (mode, blockReason) => {
      const status = hostedRelayStatusFromEnv({
        KOOKR_HOSTED_RELAY_ENABLED: 'true',
        KOOKR_HOSTED_RELAY_OPS_GATES_MET: 'true',
        KOOKR_HOSTED_RELAY_MODE: mode,
        KOOKR_HOSTED_RELAY_URL: 'https://relay.example.test',
      });

      expect(status.configured).toBe(true);
      expect(status.terminalViewing).toEqual({
        enabled: false,
        blockReason,
        disabledTenants: 0,
      });
    },
  );
});
