/**
 * Re-export the shared quota-headroom evaluator so existing core/server
 * imports keep working. Canonical implementation:
 * `src/shared/quota-headroom-admission.ts`.
 */
export {
  evaluateQuotaHeadroomAdmission,
  QUOTA_NO_HEADROOM_UTILIZATION,
  type QuotaBindingWindow,
  type QuotaHeadroomAdmissionDecision,
  type QuotaHeadroomSample,
} from '../shared/quota-headroom-admission.js';
