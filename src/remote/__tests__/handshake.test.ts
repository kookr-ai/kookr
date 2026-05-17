import { describe, expect, it } from 'vitest';

import {
  makeNodeHello,
  makeRelayHello,
  isRelayHello,
  parseTerminalInputKillSwitch,
  remoteTerminalInputFeatureEnabled,
  REMOTE_PROTOCOL_VERSION,
} from '../handshake.js';
import { asNodeEpoch, asNodeId } from '../ids.js';

describe('remote handshake protocol', () => {
  it('advertises Phase 1 protocol version and safe feature flags', () => {
    const hello = makeNodeHello({
      nodeId: asNodeId('node-a'),
      nodeEpoch: asNodeEpoch('7'),
      softwareVersion: 'dev',
    });

    expect(hello).toMatchObject({
      type: 'node.hello',
      nodeId: 'node-a',
      nodeEpoch: '7',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      softwareVersion: 'dev',
    });
    expect(hello.supportedFeatures).toEqual([
      'control.snapshot',
      'control.state-delta',
      'policy-sync',
    ]);
  });

  it('serializes relay decisions with accepted and disabled features separated', () => {
    const hello = makeRelayHello({
      outcome: 'downgraded',
      acceptedVersion: 1,
      enabledFeatures: ['control.snapshot'],
      disabledFeatures: ['control.state-delta'],
      shareMaxTtlMs: 31 * 24 * 60 * 60 * 1000,
    });
    expect(hello).toEqual({
      type: 'relay.hello',
      outcome: 'downgraded',
      acceptedVersion: 1,
      enabledFeatures: ['control.snapshot'],
      disabledFeatures: ['control.state-delta'],
      shareMaxTtlMs: 31 * 24 * 60 * 60 * 1000,
    });
    expect(isRelayHello(hello)).toBe(true);
    expect(isRelayHello({ ...hello, shareMaxTtlMs: Number.NaN })).toBe(false);
    expect(isRelayHello({ ...hello, shareMaxTtlMs: '2678400000' })).toBe(false);
  });

  it('parses KOOKR_RELAY_FEATURES as a terminal-input kill switch without changing legacy tokens', () => {
    expect(parseTerminalInputKillSwitch('terminal-input,terminal,launch')).toEqual({
      disabled: true,
    });
    expect(remoteTerminalInputFeatureEnabled({
      KOOKR_RELAY_URL: 'wss://relay.example.test',
      KOOKR_RELAY_TRUSTED: 'true',
      KOOKR_RELAY_FEATURES: 'terminal-input',
    })).toBe(false);
    expect(remoteTerminalInputFeatureEnabled({
      KOOKR_RELAY_URL: 'wss://relay.example.test',
      KOOKR_RELAY_TRUSTED: 'true',
      KOOKR_RELAY_FEATURES: 'launch',
    })).toBe(true);
    expect(remoteTerminalInputFeatureEnabled({
      KOOKR_RELAY_URL: 'wss://relay.example.test',
      KOOKR_RELAY_FEATURES: '',
    })).toBe(false);
  });
});
