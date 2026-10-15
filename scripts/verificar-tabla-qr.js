/**
 * Comprobacion de la tabla de bloques Reed-Solomon contra la especificacion QR.
 *
 * La norma fija, para cada version y nivel, cuantos bloques hay y cuantas
 * palabras de datos y de correccion lleva cada uno. De ahi sale tambien el total
 * de palabras, que tiene que cuadrar EXACTAMENTE con los modulos de datos que
 * deja libres la matriz. Si no cuadra, el entrelazado reparte mal los bytes y el
 * simbolo se lee torcido.
 *
 *   node scripts/verificar-tabla-qr.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const fuente = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'qr.js'), 'utf8');
const bloque = fuente.slice(fuente.indexOf('const ESTRUCTURA'), fuente.indexOf('/* Posiciones de alineacion'));
const ESTRUCTURA = new Function(bloque + '\nreturn ESTRUCTURA;')();

const TAMANO = { 1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41, 7: 45, 8: 49, 9: 53, 10: 57 };
const ALINEACION = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

/* Cuantos modulos de datos (no funcionales) tiene la matriz de cada version. */
function modulosLibres(version) {
  const tamano = TAMANO[version];
  const ocupado = Array.from({ length: tamano }, () => new Array(tamano).fill(false));
  const marcar = (f, c) => { if (f >= 0 && c >= 0 && f < tamano && c < tamano) ocupado[f][c] = true; };

  for (const [f0, c0] of [[0, 0], [0, tamano - 7], [tamano - 7, 0]]) {
    for (let f = -1; f <= 7; f++) for (let c = -1; c <= 7; c++) marcar(f0 + f, c0 + c);
  }
  for (const f of ALINEACION[version]) {
    for (const c of ALINEACION[version]) {
      const sp = (f <= 7 && c <= 7) || (f <= 7 && c >= tamano - 8) || (f >= tamano - 8 && c <= 7);
      if (sp) continue;
      for (let df = -2; df <= 2; df++) for (let dc = -2; dc <= 2; dc++) marcar(f + df, c + dc);
    }
  }
  for (let i = 8; i < tamano - 8; i++) { marcar(6, i); marcar(i, 6); }
  for (let i = 0; i <= 8; i++) { marcar(8, i); marcar(i, 8); }
  for (let i = 0; i < 8; i++) { marcar(8, tamano - 1 - i); marcar(tamano - 1 - i, 8); }
  marcar(tamano - 8, 8);
  if (version >= 7) for (let i = 0; i < 18; i++) { const f = Math.floor(i / 3); const c = i % 3; marcar(tamano - 11 + c, f); marcar(f, tamano - 11 + c); }

  let libres = 0;
  for (let f = 0; f < tamano; f++) for (let c = 0; c < tamano; c++) if (!ocupado[f][c]) libres++;
  return libres;
}

/* Total de palabras (datos + correccion) segun la tabla del archivo. */
function totalSegunTabla(version, nivel) {
  const e = ESTRUCTURA[version][nivel];
  return e[2] * e[3] + e[4] * e[5] + (e[2] + e[4]) * e[1];
}

console.log('\n=== Verificacion de la tabla de bloques QR ===\n');
console.log('version nivel  palabras(tabla)  bits  modulos libres  resto  veredicto');
let malos = 0;

for (const version of Object.keys(TAMANO).map(Number)) {
  for (const nivel of ['L', 'M', 'Q', 'H']) {
    const palabras = totalSegunTabla(version, nivel);
    const bits = palabras * 8;
    const libres = modulosLibres(version);
    const resto = libres - bits;
    /* El resto son los "remainder bits": 0 a 7, fijos por version. Si la tabla
       esta bien, el resto nunca puede ser negativo ni mayor que 7. */
    const bien = resto >= 0 && resto <= 7;
    if (!bien) malos++;
    console.log(
      String(version).padStart(7) +
        String(nivel).padStart(6) +
        String(palabras).padStart(15) +
        String(bits).padStart(6) +
        String(libres).padStart(16) +
        String(resto).padStart(7) +
        '  ' +
        (bien ? 'ok' : '<<< NO CUADRA')
    );
  }
}

console.log('\n' + (malos ? malos + ' combinaciones NO cuadran.' : 'Todas las combinaciones cuadran.'));
process.exit(malos ? 1 : 0);
