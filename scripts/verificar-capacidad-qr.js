/**
 * Comprueba que la version que elige el codificador SIEMPRE tenga capacidad
 * suficiente para los datos.
 *
 * Este es el fallo peligroso: si el codificador eligiera una version demasiado
 * pequena, recortaria los datos en silencio y el QR se leeria incompleto.
 * Aqui se prueba con textos de todos los tamanos hasta el limite de la version
 * 10, en los cuatro niveles de correccion.
 *
 *   node scripts\verificar-capacidad-qr.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const qr = require(path.resolve(__dirname, '..', 'src', 'qr.js'));

const fuente = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'qr.js'), 'utf8');
const ESTRUCTURA = new Function(
  fuente.slice(fuente.indexOf('const ESTRUCTURA'), fuente.indexOf('/* Posiciones de alineacion')) + '\nreturn ESTRUCTURA;'
)();
const TAMANO = { 1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41, 7: 45, 8: 49, 9: 53, 10: 57 };

/** Palabras de datos disponibles en una version y nivel. */
function palabrasDatos(version, nivel) {
  const [, , b1, d1, b2, d2] = ESTRUCTURA[version][nivel];
  return b1 * d1 + b2 * d2;
}

/** Bits que ocupa un texto en modo byte dentro de una version concreta. */
function bitsNecesarios(bytes, version) {
  return 4 + (version < 10 ? 8 : 16) + bytes * 8;
}

/** El texto mas largo que cabe, en bytes, para una version y nivel. */
function maximoBytes(version, nivel) {
  const disponibles = palabrasDatos(version, nivel) * 8;
  let max = 0;
  while (bitsNecesarios(max + 1, version) <= disponibles) max++;
  return max;
}

console.log('\n=== Capacidad del codigo QR ===\n');

let fallos = 0;
let probados = 0;

for (const nivel of ['L', 'M', 'Q', 'H']) {
  for (let bytes = 1; bytes <= 300; bytes++) {
    const texto = 'a'.repeat(bytes);
    const salida = qr.matriz(texto, nivel);
    probados++;

    if (!salida) {
      // Se acepta que devuelva null solo si de verdad no cabe en la version 10.
      if (bytes <= maximoBytes(10, nivel)) {
        console.log('  FALLO  ' + bytes + ' bytes [' + nivel + ']: devolvio null y todavia cabia');
        fallos++;
      }
      continue;
    }

    const capacidad = palabrasDatos(salida.version, nivel) * 8;
    const necesario = bitsNecesarios(bytes, salida.version);

    if (necesario > capacidad) {
      console.log(
        '  FALLO  ' + bytes + ' bytes [' + nivel + ']: eligio v' + salida.version +
          ' con ' + capacidad + ' bits y necesitaba ' + necesario
      );
      fallos++;
    }

    // La version elegida debe ser la MAS PEQUENA que sirve.
    const esperada = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((v) => bitsNecesarios(bytes, v) <= palabrasDatos(v, nivel) * 8);
    if (esperada && salida.version !== esperada) {
      console.log(
        '  FALLO  ' + bytes + ' bytes [' + nivel + ']: eligio v' + salida.version + ' y correspondia v' + esperada
      );
      fallos++;
    }
  }
}

/* Comprobar el limite exacto de cada nivel en la version 10. */
console.log('\nLimite de la version 10 (ultima soportada):');
for (const nivel of ['L', 'M', 'Q', 'H']) {
  const maxBytes = maximoBytes(10, nivel);
  const justoCabe = qr.matriz('a'.repeat(maxBytes), nivel);
  const noCabe = qr.matriz('a'.repeat(maxBytes + 1), nivel);
  const ok = justoCabe && justoCabe.version === 10 && noCabe === null;
  if (!ok) fallos++;
  console.log(
    '  ' + (ok ? 'ok  ' : 'FALLO') + '  ' + nivel + ': hasta ' + maxBytes + ' bytes -> v' +
      (justoCabe ? justoCabe.version : 'null') + ', con ' + (maxBytes + 1) + ' -> ' + (noCabe ? 'v' + noCabe.version : 'null')
  );
}

console.log('\n  ' + probados + ' tamanos probados, ' + fallos + ' fallos\n');
process.exit(fallos ? 1 : 0);
