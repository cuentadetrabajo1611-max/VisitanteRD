import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { licenseClaimsSchema } from '@visitante/core';
import { z } from 'zod';
import { issuerModule } from './app';

async function main() {
  const token = process.env.ISSUER_ADMIN_TOKEN;
  if (!token || token.length < 32 || !process.env.ISSUER_PRIVATE_KEY_FILE || !process.env.ISSUER_ENTITLEMENTS_FILE || !process.env.ISSUER_KEY_ID) {
    throw new Error('Issuer configuration required');
  }
  const app = await NestFactory.create(issuerModule({token, keyId:process.env.ISSUER_KEY_ID,
    privateKey:readFileSync(process.env.ISSUER_PRIVATE_KEY_FILE,'utf8'),
    entitlements:z.array(licenseClaimsSchema).parse(JSON.parse(readFileSync(process.env.ISSUER_ENTITLEMENTS_FILE,'utf8'))),
  }), {logger:['error','warn']});
  app.use(helmet()); app.setGlobalPrefix('api'); app.enableShutdownHooks();
  await app.listen(Number(process.env.ISSUER_PORT ?? 3200),'127.0.0.1');
}
main().catch(() => { console.error('Issuer startup failed; check local configuration (secrets omitted).'); process.exitCode = 1; });
