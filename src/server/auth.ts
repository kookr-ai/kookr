export const LOCAL_OWNER_ID = 'local-owner';

export interface OwnerIdentity {
  actorId?: string;
  ownerId?: string;
  local?: boolean;
}

export function isOwnerLocal(identity: OwnerIdentity | undefined): boolean {
  if (!identity) return false;
  return identity.local === true
    || identity.actorId === LOCAL_OWNER_ID
    || identity.ownerId === LOCAL_OWNER_ID;
}
