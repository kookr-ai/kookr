import {
  DEFAULT_HOSTED_RELAY_URL,
  createHostedRelayGateStatus,
  parseHostedRelayFlag,
  parseHostedRelayMode,
  parseHostedRelayPositiveInt,
  hostedRelayStatusMessage,
  type HostedRelayStatus,
} from '../shared/contracts/hosted-relay.js';
import { normalizeRelayUrl } from './relay-connection-store.js';

export function hostedRelayStatusFromEnv(env: NodeJS.ProcessEnv = process.env): HostedRelayStatus {
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(env.KOOKR_HOSTED_RELAY_URL || DEFAULT_HOSTED_RELAY_URL);
  } catch {
    return {
      configured: false,
      relayUrl: DEFAULT_HOSTED_RELAY_URL,
      defaultEnabled: parseHostedRelayFlag(env.KOOKR_HOSTED_RELAY_ENABLED),
      operationalGatesMet: false,
      mode: 'notConfigured',
      message: 'Hosted relay URL is invalid.',
      checkedAt: new Date().toISOString(),
      gates: createHostedRelayGateStatus(false),
      tlsExpiresAt: null,
    };
  }
  const defaultEnabled = parseHostedRelayFlag(env.KOOKR_HOSTED_RELAY_ENABLED);
  const operationalGatesMet = parseHostedRelayFlag(env.KOOKR_HOSTED_RELAY_OPS_GATES_MET);
  const mode = defaultEnabled && operationalGatesMet ? parseHostedRelayMode(env.KOOKR_HOSTED_RELAY_MODE) : 'notConfigured';
  const gates = createHostedRelayGateStatus(operationalGatesMet);
  const dataRetentionDays = parseHostedRelayPositiveInt(env.KOOKR_HOSTED_RELAY_RETENTION_DAYS, Number.NaN);
  const status: HostedRelayStatus = {
    configured: defaultEnabled && operationalGatesMet,
    relayUrl,
    defaultEnabled,
    operationalGatesMet,
    mode,
    message: hostedRelayStatusMessage({ defaultEnabled, operationalGatesMet, mode }, { local: true }),
    checkedAt: new Date().toISOString(),
    gates,
    ...(env.KOOKR_HOSTED_RELAY_OWNER ? { deploymentOwner: env.KOOKR_HOSTED_RELAY_OWNER } : {}),
    ...(env.KOOKR_HOSTED_RELAY_ENVIRONMENT ? { environment: env.KOOKR_HOSTED_RELAY_ENVIRONMENT } : {}),
    tlsExpiresAt: env.KOOKR_HOSTED_RELAY_TLS_EXPIRES_AT || null,
    ...(Number.isFinite(dataRetentionDays) ? { dataRetentionDays } : {}),
  };
  return status;
}
