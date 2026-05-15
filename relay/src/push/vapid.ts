import webpush from 'web-push';

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
  version: number;
  rotatedAt: string;
}

export interface VapidKeyStore {
  current(): VapidKeyPair;
  rotate(now?: Date): VapidKeyPair;
}

export function createVapidKeyStore(initial?: Pick<VapidKeyPair, 'publicKey' | 'privateKey'>): VapidKeyStore {
  let version = 1;
  let pair = makePair(version, initial);

  return {
    current: () => pair,
    rotate(now = new Date()): VapidKeyPair {
      version += 1;
      pair = makePair(version, undefined, now);
      return pair;
    },
  };
}

function makePair(
  version: number,
  initial?: Pick<VapidKeyPair, 'publicKey' | 'privateKey'>,
  now = new Date(),
): VapidKeyPair {
  const generated = initial ?? webpush.generateVAPIDKeys();
  return {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    version,
    rotatedAt: now.toISOString(),
  };
}
