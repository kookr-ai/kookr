import type { NodeId, PolicyVersion, Seq, SessionEpoch, SessionId } from '../shared/contracts/ids.js';
export type { NodeId, PolicyVersion, Seq, SessionEpoch, SessionId } from '../shared/contracts/ids.js';

declare const brand: unique symbol;

type BrandedString<Name extends string> = string & { readonly [brand]: Name };

export type NodeEpoch = BrandedString<'NodeEpoch'>;
export type ServerRevision = number & { readonly [brand]: 'ServerRevision' };
export type GrantId = BrandedString<'GrantId'>;
export type CommandId = BrandedString<'CommandId'>;
export type IdempotencyKey = BrandedString<'IdempotencyKey'>;
export type LeaseId = BrandedString<'LeaseId'>;
export type PermissionRequestId = BrandedString<'PermissionRequestId'>;
export type ActorId = BrandedString<'ActorId'>;
export type ClientId = BrandedString<'ClientId'>;
export type InputContextId = BrandedString<'InputContextId'>;

export function asNodeId(value: string): NodeId {
  return value as NodeId;
}

export function asNodeEpoch(value: string): NodeEpoch {
  return value as NodeEpoch;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asSessionEpoch(value: string): SessionEpoch {
  return value as SessionEpoch;
}

export function asServerRevision(value: number): ServerRevision {
  return value as ServerRevision;
}

export function asSeq(value: number): Seq {
  return value as Seq;
}

export function asPolicyVersion(value: number): PolicyVersion {
  return value as PolicyVersion;
}

export function asGrantId(value: string): GrantId {
  return value as GrantId;
}

export function asCommandId(value: string): CommandId {
  return value as CommandId;
}

export function asIdempotencyKey(value: string): IdempotencyKey {
  return value as IdempotencyKey;
}

export function asLeaseId(value: string): LeaseId {
  return value as LeaseId;
}

export function asPermissionRequestId(value: string): PermissionRequestId {
  return value as PermissionRequestId;
}

export function asActorId(value: string): ActorId {
  return value as ActorId;
}

export function asClientId(value: string): ClientId {
  return value as ClientId;
}
