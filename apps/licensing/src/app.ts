import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, Module, Post, BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { issueLicense, LicenseClaims, licenseClaimsSchema } from '@visitante/core';
import { z } from 'zod';

export interface IssuerConfig { token: string; keyId: string; privateKey: string; entitlements: LicenseClaims[]; }
export function issuerModule(config: IssuerConfig) {
  @Controller('licenses')
  class IssuerController {
    @Post('issue') issue(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
      const expected = `Bearer ${config.token}`;
      if (!authorization || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) throw new UnauthorizedException();
      const parsed = z.object({licenseId:z.string().uuid()}).strict().safeParse(body);
      if (!parsed.success) throw new BadRequestException('Invalid issuance request');
      // The requester cannot choose dates, tenant, installation or features.
      const entitlement = config.entitlements.find(e => e.licenseId === parsed.data.licenseId);
      const now = Math.floor(Date.now()/1000);
      if (!entitlement || entitlement.expiresAt <= now) throw new ForbiddenException('No active entitlement');
      return issueLicense(licenseClaimsSchema.parse(entitlement), config.keyId, config.privateKey);
    }
  }
  @Module({controllers:[IssuerController]}) class IssuerModule {}
  return IssuerModule;
}
