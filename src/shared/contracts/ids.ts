declare const brand: unique symbol;

type BrandedString<Name extends string> = string & { readonly [brand]: Name };

export type NodeId = BrandedString<'NodeId'>;
export type SessionId = BrandedString<'SessionId'>;
export type SessionEpoch = BrandedString<'SessionEpoch'>;
export type Seq = number & { readonly [brand]: 'Seq' };
export type PolicyVersion = number & { readonly [brand]: 'PolicyVersion' };
