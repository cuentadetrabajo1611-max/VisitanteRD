import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { issueLicense, verifyLicense, LicenseClaims } from '../packages/core/src';
const pair=generateKeyPairSync('ed25519');
const privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
const claims:LicenseClaims={version:1,licenseId:randomUUID(),tenantId:'synthetic-tenant',installationId:randomUUID(),issuedAt:100,notBefore:100,expiresAt:200,features:['visits']};
const binding={tenantId:claims.tenantId,installationId:claims.installationId,now:150};
describe('Ed25519 licensing',()=>{
  it('accepts a bound license and rejects altered payloads',()=>{
    const license=issueLicense(claims,'key-1',privateKey);
    expect(verifyLicense(license,{'key-1':publicKey},binding)).toEqual(claims);
    expect(()=>verifyLicense({...license,payload:Buffer.from(JSON.stringify({...claims,features:['registry']})).toString('base64url')},{'key-1':publicKey},binding)).toThrow();
  });
  it.each([99,200,201,NaN])('rejects time %s',(now)=>expect(()=>verifyLicense(issueLicense(claims,'key-1',privateKey),{'key-1':publicKey},{...binding,now})).toThrow());
  it('rejects installation, tenant and unknown key mismatches',()=>{
    const license=issueLicense(claims,'key-1',privateKey);
    expect(()=>verifyLicense(license,{},binding)).toThrow();
    expect(()=>verifyLicense(license,{'key-1':publicKey},{...binding,installationId:randomUUID()})).toThrow();
    expect(()=>verifyLicense(license,{'key-1':publicKey},{...binding,tenantId:'other'})).toThrow();
    expect(()=>verifyLicense({...license,keyId:'key-2'},{'key-2':publicKey},binding)).toThrow();
  });
});
