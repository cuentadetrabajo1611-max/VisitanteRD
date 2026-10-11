import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';

export const licenseClaimsSchema = z.object({
  version: z.literal(1), licenseId: z.string().uuid(),
  tenantId: z.string().min(1).max(100), installationId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(), notBefore: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  features: z.array(z.enum(['visits', 'registry'])).max(2),
}).strict().refine(c => c.issuedAt <= c.expiresAt && c.notBefore < c.expiresAt, 'Invalid validity interval');
export type LicenseClaims = z.infer<typeof licenseClaimsSchema>;
export const licenseEnvelopeSchema = z.object({
  algorithm: z.literal('Ed25519'), keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(8192),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type LicenseEnvelope = z.infer<typeof licenseEnvelopeSchema>;

export function issueLicense(claims: LicenseClaims, keyId: string, privatePem: string): LicenseEnvelope {
  const parsed = licenseClaimsSchema.parse(claims);
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required');
  const payload = Buffer.from(JSON.stringify(parsed)).toString('base64url');
  const signed = Buffer.from(`VisitanteRD:license:v1:${keyId}:${payload}`);
  return licenseEnvelopeSchema.parse({ algorithm: 'Ed25519', keyId, payload,
    signature: sign(null, signed, key).toString('base64url') });
}

export function verifyLicense(input: unknown, keys: Record<string, string>, binding: {
  tenantId: string; installationId: string; now?: number;
}): LicenseClaims {
  const envelope = licenseEnvelopeSchema.parse(input);
  const pem = Object.hasOwn(keys, envelope.keyId) ? keys[envelope.keyId] : undefined;
  if (!pem) throw new Error('Unknown signing key');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null,
    Buffer.from(`VisitanteRD:license:v1:${envelope.keyId}:${envelope.payload}`), key,
    Buffer.from(envelope.signature, 'base64url'))) throw new Error('Invalid license signature');
  const claims = licenseClaimsSchema.parse(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8')));
  const now = binding.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < claims.notBefore || now < claims.issuedAt || now >= claims.expiresAt) throw new Error('License outside validity period');
  if (claims.tenantId !== binding.tenantId || claims.installationId !== binding.installationId) throw new Error('License binding mismatch');
  return claims;
}

export const createVisitSchema = z.object({
  visitorLabel: z.string().trim().min(2).max(120),
  destination: z.string().trim().min(2).max(120),
  purpose: z.string().trim().min(2).max(240),
}).strict();
export type CreateVisit = z.infer<typeof createVisitSchema>;
export interface Visit extends CreateVisit { id: string; enteredAt: string; exitedAt: string | null; }
