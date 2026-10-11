import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import sql from 'mssql';
import { appModule, Runtime } from './app';
import { MemoryVisitRepository, SqlVisitRepository } from './visits';
import { SqlRegistryReader } from './registry';

async function main() {
  const demo = process.env.DEMO_MODE === 'true';
  if (!demo && (!process.env.APP_SQL_CONNECTION || !process.env.API_ACCESS_TOKEN || process.env.API_ACCESS_TOKEN.length < 32 ||
    !process.env.LICENSE_FILE || !process.env.LICENSE_PUBLIC_KEYS_FILE || !process.env.TENANT_ID || !process.env.INSTALLATION_ID)) {
    throw new Error('Configure SQL, access token, license files and installation binding; or explicitly use DEMO_MODE=true');
  }
  if (demo && process.env.NODE_ENV === 'production') throw new Error('Demo mode is forbidden in production');
  const pools: sql.ConnectionPool[] = [];
  const runtime: Runtime = { demo, accessToken: process.env.API_ACCESS_TOKEN, visits: new MemoryVisitRepository(),
    publicKeys: {}, tenantId: process.env.TENANT_ID ?? '', installationId: process.env.INSTALLATION_ID ?? '' };
  if (!demo) {
    const pool = await new sql.ConnectionPool(process.env.APP_SQL_CONNECTION!).connect(); pools.push(pool);
    runtime.visits = new SqlVisitRepository(pool);
    runtime.license = JSON.parse(readFileSync(process.env.LICENSE_FILE!, 'utf8'));
    runtime.publicKeys = JSON.parse(readFileSync(process.env.LICENSE_PUBLIC_KEYS_FILE!, 'utf8'));
    if (process.env.REGISTRY_SQL_CONNECTION) {
      const registryPool = await new sql.ConnectionPool(process.env.REGISTRY_SQL_CONNECTION).connect(); pools.push(registryPool);
      runtime.registry = new SqlRegistryReader(registryPool);
    }
  }
  const app = await NestFactory.create(appModule(runtime), { logger: ['warn', 'error'] });
  app.use(helmet()); app.setGlobalPrefix('api');
  app.enableCors({origin: 'http://127.0.0.1:5173'});
  app.enableShutdownHooks();
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { void Promise.all(pools.map(pool => pool.close())); });
  await app.listen(Number(process.env.API_PORT ?? 3100), '127.0.0.1');
}
main().catch(() => { console.error('API startup failed; check local configuration (secrets omitted).'); process.exitCode = 1; });
