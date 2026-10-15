/**
 * VisitaFlow - Generacion del par de llaves RSA del licenciamiento.
 *
 *   node scripts/generar-llaves.js
 *
 * Escribe en licencias-keys/:
 *   privada.pem   -> se queda SOLO en el servidor de licencias.
 *   publica.pem   -> se incrusta en cada instalacion del sistema.
 *
 * La llave privada firma; la publica verifica. Sin la privada nadie puede
 * emitir una licencia valida, aunque tenga el codigo del sistema.
 *
 * Si las llaves ya existen NO se sobreescriben (para no invalidar las
 * licencias ya emitidas). Use --forzar para regenerarlas.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DESTINO = path.resolve(__dirname, '..', 'licencias-keys');
const PRIVADA = path.join(DESTINO, 'privada.pem');
const PUBLICA = path.join(DESTINO, 'publica.pem');
const KEY_ID = path.join(DESTINO, 'keyid.txt');

const forzar = process.argv.includes('--forzar');

function main() {
  fs.mkdirSync(DESTINO, { recursive: true });

  if (fs.existsSync(PRIVADA) && !forzar) {
    console.log('Las llaves ya existen en ' + DESTINO);
    console.log('No se tocan para no invalidar las licencias emitidas.');
    console.log('Use --forzar si de verdad quiere regenerarlas.');
    return;
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(PRIVADA, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLICA, publicKey, { mode: 0o644 });

  // Identificador corto de la llave: viaja dentro de cada licencia para
  // poder rotar llaves sin romper las licencias viejas.
  const keyId = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  fs.writeFileSync(KEY_ID, keyId + '\n');

  console.log('Llaves generadas en ' + DESTINO);
  console.log('  privada.pem  (SECRETA - solo servidor de licencias)');
  console.log('  publica.pem  (va dentro del sistema)');
  console.log('  keyid.txt    ' + keyId);
  console.log('');
  console.log('Para el VPS, la llave privada se pasa por variable de entorno:');
  console.log('  LICENCIA_LLAVE_PRIVADA_PEM=<contenido de privada.pem en una sola linea con \\n>');
  console.log('  o bien LICENCIA_LLAVE_PRIVADA_B64=<privada.pem en base64>');
}

main();
