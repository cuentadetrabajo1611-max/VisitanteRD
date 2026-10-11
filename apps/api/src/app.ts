import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, HttpStatus, Inject, Injectable, Module, NotFoundException, Param, Post, UnauthorizedException, UseGuards, BadRequestException } from '@nestjs/common';
import { createVisitSchema, verifyLicense } from '@visitante/core';
import { z } from 'zod';
import { VisitRepository } from './visits';
import { RegistryReader, normalizeDocument } from './registry';

export interface Runtime {
  demo: boolean; accessToken?: string; visits: VisitRepository; registry?: RegistryReader;
  license?: unknown; publicKeys: Record<string, string>; tenantId: string; installationId: string;
}
export const RUNTIME = Symbol('RUNTIME');
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  canActivate(context: ExecutionContext) {
    if (this.runtime.demo) return true;
    const header = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>().headers.authorization;
    const expected = `Bearer ${this.runtime.accessToken ?? ''}`;
    if (!this.runtime.accessToken || !header || Buffer.byteLength(header) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(header), Buffer.from(expected))) throw new UnauthorizedException();
    return true;
  }
}
@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  canActivate(context: ExecutionContext) {
    if (this.runtime.demo) return true;
    try {
      const claims = verifyLicense(this.runtime.license, this.runtime.publicKeys, this.runtime);
      const feature = context.getClass() === RegistryController ? 'registry' : 'visits';
      if (!claims.features.includes(feature)) throw new Error('Missing feature');
    } catch { throw new ForbiddenException('Licencia inválida o capacidad no autorizada'); }
    return true;
  }
}
@Controller('health')
class HealthController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  @Get() health() { return { status: 'ok', mode: this.runtime.demo ? 'demo' : 'configured', version: '0.1.0' }; }
}
@Controller('visits')
@UseGuards(AccessGuard, LicenseGuard)
class VisitsController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  @Get() list() { return this.runtime.visits.listActive(); }
  @Post() create(@Body() body: unknown) {
    const parsed = createVisitSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Revisa los campos de la visita');
    return this.runtime.visits.create(parsed.data);
  }
  @Post(':id/checkout') async checkout(@Param('id') id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new BadRequestException('Identificador inválido');
    const result = await this.runtime.visits.checkout(id);
    if (!result) throw new NotFoundException('Visita inexistente o ya finalizada');
    return result;
  }
}
@Controller('registry')
@UseGuards(AccessGuard, LicenseGuard)
class RegistryController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  // POST keeps the document out of URLs, browser history and normal access logs.
  @Post('lookup') async lookup(@Body() body: unknown) {
    const parsed = z.object({document: z.string().max(13)}).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('Documento inválido');
    let document: string;
    try { document = normalizeDocument(parsed.data.document); } catch { throw new BadRequestException('Documento inválido'); }
    if (!this.runtime.registry) throw new HttpException('Padrón no configurado', HttpStatus.SERVICE_UNAVAILABLE);
    return { person: await this.runtime.registry.find(document) };
  }
}
export function appModule(runtime: Runtime) {
  @Module({controllers: [HealthController, VisitsController, RegistryController], providers: [
    {provide: RUNTIME, useValue: runtime}, AccessGuard, LicenseGuard,
  ]})
  class AppModule {}
  return AppModule;
}
