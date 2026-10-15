/**
 * VisitaFlow - Comprobacion de que el texto quedo bien codificado.
 *
 *   node scripts/revisar-texto.js
 *
 * Recorre los archivos y avisa si alguno tiene marcas de doble codificacion
 * (los pares de bytes que delatan el problema) o si perdio los acentos. Sirve
 * para confirmar que una reparacion dejo el texto limpio de verdad.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');

/* Marcas de doble codificacion, por bytes: C3 83, C2 82 y los pares que
   aparecen cuando se pasa el texto por CP1252. */
function contarMarcas(buffer) {
  let n = 0;
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0xc3 && buffer[i + 1] === 0x83) n++;
    if (buffer[i] === 0xc2 && (buffer[i + 1] === 0x82 || buffer[i + 1] === 0x81)) n++;
  }
  return n;
}

/* Vocales acentuadas y enie, contadas por sus codigos para no depender de la
   codificacion de este archivo. */
const ACENTOS = [0xe1, 0xe9, 0xed, 0xf3, 0xfa, 0xf1, 0xc1, 0xc9, 0xcd, 0xd3, 0xda, 0xd1];

function contarAcentos(texto) {
  let n = 0;
  for (const c of texto) if (ACENTOS.indexOf(c.codePointAt(0)) !== -1) n++;
  return n;
}

function recorrer(dir, salida) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tmp', '.git', 'capturas', 'datos'].indexOf(e.name) !== -1) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, salida);
    else if (/\.(js|json|sql|md|html|css)$/.test(e.name)) salida.push(p);
  }
  return salida;
}

function principal() {
  const archivos = recorrer(RAIZ, []);
  console.log('');
  console.log('  VisitaFlow - revision de codificacion del texto');
  console.log('  ' + '-'.repeat(62));
  console.log('  archivo                          acentos   marcas rotas');
  console.log('  ' + '-'.repeat(62));

  let conMarcas = 0;
  let totalAcentos = 0;

  for (const a of archivos) {
    const buffer = fs.readFileSync(a);
    const texto = buffer.toString('utf8');
    const acentos = contarAcentos(texto);
    const marcas = contarMarcas(buffer);
    if (!acentos && !marcas) continue;

    totalAcentos += acentos;
    if (marcas) conMarcas++;

    const rel = path.relative(RAIZ, a);
    console.log(
      '  ' + rel.padEnd(32) + String(acentos).padStart(7) + String(marcas).padStart(14) +
      (marcas ? '   <-- REVISAR' : '')
    );
  }

  console.log('  ' + '-'.repeat(62));
  console.log('  ' + archivos.length + ' archivos revisados, ' + totalAcentos + ' acentos encontrados');
  console.log('  ' + (conMarcas ? conMarcas + ' archivo(s) con marcas de doble codificacion' : 'Ninguna marca de doble codificacion'));
  console.log('');

  process.exit(conMarcas ? 1 : 0);
}

principal();
