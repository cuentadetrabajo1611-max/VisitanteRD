import {afterEach,expect,it} from 'vitest';
import {NestFactory} from '@nestjs/core';
import {INestApplication} from '@nestjs/common';
import request from 'supertest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {issueLicense} from '../packages/core/src';
import {appModule,Runtime} from '../apps/api/src/app';
import {MemoryVisitRepository} from '../apps/api/src/visits';
let app:INestApplication;
afterEach(async()=>{await app?.close();});
async function setup(overrides:Partial<Runtime>={}) {
  app=await NestFactory.create(appModule({demo:true,visits:new MemoryVisitRepository(),publicKeys:{},tenantId:'synthetic',installationId:'',...overrides}),{logger:false});
  await app.init();return request(app.getHttpServer());
}
it('registers, lists and checks out only once',async()=>{
  const http=await setup();
  await http.post('/visits').send({visitorLabel:'X'}).expect(400);
  const created=await http.post('/visits').send({visitorLabel:'Synthetic visitor',destination:'Test area',purpose:'Test visit'}).expect(201);
  expect((await http.get('/visits').expect(200)).body).toHaveLength(1);
  await http.post(`/visits/${created.body.id}/checkout`).expect(201);
  await http.post(`/visits/${created.body.id}/checkout`).expect(404);
  expect((await http.get('/visits')).body).toHaveLength(0);
});
it('fails closed for missing access credentials or license',async()=>{
  const http=await setup({demo:false,accessToken:'test-access-token'});
  await http.get('/visits').expect(401);
  await http.get('/visits').set('Authorization','Bearer test-access-token').expect(403);
});
it('does not pretend the padrón is configured',async()=>{
  const http=await setup();
  await http.post('/registry/lookup').send({document:'00000000000'}).expect(503);
});
it('permits licensed visits and denies a registry feature absent from the license',async()=>{
  const pair=generateKeyPairSync('ed25519');const now=Math.floor(Date.now()/1000);const installationId=randomUUID();
  const license=issueLicense({version:1,licenseId:randomUUID(),tenantId:'synthetic',installationId,issuedAt:now,notBefore:now,expiresAt:now+60,features:['visits']},'test',pair.privateKey.export({type:'pkcs8',format:'pem'}).toString());
  const http=await setup({demo:false,accessToken:'test-access-token',installationId,license,publicKeys:{test:pair.publicKey.export({type:'spki',format:'pem'}).toString()}});
  await http.get('/visits').set('Authorization','Bearer test-access-token').expect(200);
  await http.post('/registry/lookup').set('Authorization','Bearer test-access-token').send({document:'00000000000'}).expect(403);
});
