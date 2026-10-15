/**
 * VisitaFlow - Reparacion de texto con doble codificacion (mojibake).
 *
 *   node scripts/reparar-texto.js            (informa)
 *   node scripts/reparar-texto.js --aplicar  (repara)
 *
 * QUE PASO
 * --------
 * Varios archivos se guardaron pasando el texto por Windows-1252: el contenido
 * UTF-8 se leyo como si fuera CP1252 y se volvio a guardar como UTF-8. Una "o"
 * con tilde (bytes C3 B3) termino siendo los bytes C3 83 C2 B3, y una "A" con
 * tilde (C3 81) termino en C3 83 C2 81.
 *
 * No es Latin-1 puro: CP1252 tiene una tabla propia para los bytes 0x80 a 0x9F
 * (comillas curvas, guion largo, etc.), y esa diferencia es justo la que impide
 * que una reparacion con Latin-1 funcione. Por eso este script usa la tabla de
 * CP1252 de verdad.
 *
 * COMO SE REPARA
 * --------------
 * 1. Se decodifica el texto actual como CP1252 -> se recuperan los bytes
 *    originales.
 * 2. Se leen esos bytes como UTF-8 -> se recupera el texto bueno.
 * 3. Se comprueba que la operacion MEJORA (menos secuencias rotas, sin
 *    caracteres de reemplazo) antes de escribir nada.
 *
 * Se puede ejecutar varias veces: cada pasada deshace una capa. Los archivos ya
 * correctos no se tocan.
 *
 * Antes de escribir deja copia en tmp/respaldo-texto/.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APLICAR = process.argv.includes('--aplicar');
const RESPALDO = path.join(RAIZ, 'tmp', 'respaldo-texto');

/* Tabla de Windows-1252 para los bytes 0x80-0x9F, que es donde se diferencia de
   Latin-1. Los huecos (0x81, 0x8D, 0x8F, 0x90, 0x9D) no estan definidos en
   CP1252: se dejan como el mismo codigo, que es lo que hacen los navegadores. */
const CP1252_ALTOS = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/* Tabla inversa: de codigo Unicode a byte CP1252, para volver a los bytes. */
const A_CP1252 = (function () {
  const tabla = {};
  for (let b = 0; b < 0x100; b++) {
    const punto = CP1252_ALTOS[b] !== undefined ? CP1252_ALTOS[b] : b;
    if (tabla[punto] === undefined) tabla[punto] = b;
  }
  return tabla;
})();

/** Cuenta las marcas de doble codificacion en un buffer. */
function contarMarcas(buffer) {
  let n = 0;
  for (let i = 0; i + 1 < buffer.length; i++) {
    // C3 83 (dos primeros bytes de una letra mal guardada) o C2 82
    if ((buffer[i] === 0xc3 || buffer[i] === 0xc2) && buffer[i + 1] === 0x83) n++;
    if (buffer[i] === 0xc2 && buffer[i + 1] === 0x82) n++;
  }
  return n;
}

/**
 * Deshace una capa de doble codificacion.
 * Devuelve el buffer corregido, o null si no se puede o no mejora.
 */
function reparar(buffer) {
  const antes = contarMarcas(buffer);
  if (!antes) return null;

  // 1. Texto -> bytes, usando la tabla de CP1252.
  const bytes = [];
  for (const caracter of buffer.toString('utf8')) {
    const punto = caracter.codePointAt(0);
    const b = A_CP1252[punto];
    // Si aparece un caracter que CP1252 no puede representar, la conversion no
    // es la correcta: mejor no tocar el archivo.
    if (b === undefined) return null;
    bytes.push(b);
  }

  // 2. Bytes -> texto, ahora como UTF-8 de verdad.
  const candidato = Buffer.from(bytes);
  const texto = candidato.toString('utf8');

  // 3. Solo se acepta si de verdad mejora.
  if (texto.indexOf('\ufffd') !== -1) return null;
  const marcasDespues = contarMarcas(candidato);
  if (marcasDespues >= antes) return null;

  return { buffer: candidato, antes, despues: marcasDespues };
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
  console.log('');
  console.log('  VisitaFlow - reparacion de texto' + (APLICAR ? ' (aplicando)' : ' (solo informe)'));
  console.log('  ' + '-'.repeat(68));

  const archivos = recorrer(RAIZ, []);
  let conProblema = 0;
  let reparados = 0;
  let totalMarcas = 0;
  let sinReparar = [];

  for (const a of archivos) {
    const buffer = fs.readFileSync(a);
    const r = reparar(buffer);
    if (!r) continue;

    conProblema++;
    totalMarcas += r.antes;
    const rel = path.relative(RAIZ, a);
    console.log('  ' + rel.padEnd(32) + String(r.antes).padStart(4) + ' marcas -> ' + r.despues);

    if (APLICAR) {
      if (r.despues > 0) sinReparar.push(rel);
      const respaldo = path.join(RESPALDO, rel);
      fs.mkdirSync(path.dirname(respaldo), { recursive: true });
      if (!fs.existsSync(respaldo)) fs.writeFileSync(respaldo, buffer);
      fs.writeFileSync(a, r.buffer);
      reparados++;
    }
  }

  console.log('  ' + '-'.repeat(68));
  if (!conProblema) {
    console.log('  No se encontro texto con doble codificacion.');
  } else if (APLICAR) {
    console.log('  ' + reparados + ' archivo(s) reparado(s), de ' + totalMarcas + ' marcas.');
    if (sinReparar.length) {
      console.log('');
      console.log('  Quedan marcas en ' + sinReparar.length + ' archivo(s): ' + sinReparar.join(', '));
      console.log('  Vuelva a ejecutarlo: cada pasada deshace una capa de doble codificacion.');
    } else {
      console.log('  Todo el texto quedo limpio.');
    }
    console.log('  Copia de seguridad en tmp/respaldo-texto/');
  } else {
    console.log('  ' + conProblema + ' archivo(s) con ' + totalMarcas + ' marcas. Ejecute con --aplicar.');
  }
  console.log('');
}

principal();
