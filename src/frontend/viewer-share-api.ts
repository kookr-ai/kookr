// --- Owner Share control surface client (#808) ---
//
// Thin fetch wrappers over the owner-only `/api/share/viewers` routes. The CSRF
// nonce on the mutating POSTs is attached transparently by the `fetch` wrapper
// installed in `auth-session.ts`, so these call sites stay header-free.

/** A viewer grant's scope, mirroring the server `Scope` (Phase 1: only `all`). */
export type ViewerScope =
  | { kind: 'all' }
  | { kind: 'projects'; projectIds: string[] };

/** Owner-facing grant summary (no raw token), mirroring `ViewerGrantSummary`. */
export interface ViewerGrantSummary {
  id: string;
  label: string;
  scope: ViewerScope;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** One live viewer connection, mirroring the server `ViewerConnectionInfo`. */
export interface ViewerConnectionInfo {
  grantId: string;
  kind: 'dashboard' | 'terminal';
  sessionName?: string;
  connectedAt: string;
  remoteAddr?: string;
  scopeEffective: ViewerScope;
}

export interface ViewerLinksResponse {
  grants: ViewerGrantSummary[];
  roster: ViewerConnectionInfo[];
}

export interface CreatedViewerLink {
  grant: ViewerGrantSummary;
  /** Raw token — shown to the owner exactly once. */
  token: string;
  /** Fragment-carrier handoff URL the owner copies to the viewer. */
  handoffUrl: string;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.message || body.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Options for creating a viewer link (#811: scope picker + optional expiry). */
export interface CreateViewerLinkInput {
  label: string;
  /** Defaults to whole-dashboard (`all`) when omitted. */
  scope?: ViewerScope;
  /** Optional ISO-8601 expiry; the link stops working after this instant. */
  expiresAt?: string;
}

/** Create a viewer link with the given scope (default `all`) and optional expiry. */
export async function createViewerLink(input: CreateViewerLinkInput): Promise<CreatedViewerLink> {
  const scope: ViewerScope = input.scope ?? { kind: 'all' };
  const res = await fetch('/api/share/viewers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: input.label,
      scope,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CreatedViewerLink;
}

/** List all grants (active + revoked) and the live viewer roster. */
export async function listViewerLinks(): Promise<ViewerLinksResponse> {
  const res = await fetch('/api/share/viewers');
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ViewerLinksResponse;
}

/** Revoke a grant by id. The live viewer is dropped within one sweep. */
export async function revokeViewerLink(id: string): Promise<void> {
  const res = await fetch(`/api/share/viewers/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await readError(res));
}
