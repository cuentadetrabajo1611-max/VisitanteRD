/**
 * VisitaFlow - Verificacion del generador de QR.
 *
 *   node sql/92-pruebas-qr.js
 *
 * No basta con que el generador "no falle": hay que comprobar que lo que
 * dibuja se puede volver a leer. Este archivo incluye un decodificador minimo
 * que recorre la matriz en el mismo orden que exige la norma, quita la mascara,
 * rearma los bytes y comprueba que el texto de salida es el de entrada.
 *
 * Si la colocacion de los modulos, la mascara o la informacion de formato
 * estuvieran mal, el texto leido no coincidiria.
 */
'use strict';

const path = require('path');
const qr = require(path.resolve(__dirname, '..', 'src', 'qr.js'));

const ALINEACION = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* Tamano del simbolo (modulos por lado) segun la version. */
const TAMANO_VERSION = { 1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41, 7: 45, 8: 49, 9: 53, 10: 57 };

/* Estructura de bloques por version y nivel, leida del propio generador para
   que el decodificador y el codificador no se puedan desincronizar.
   Formato: [palabrasDatos, palabrasCorreccion, bloquesGrupo1, datosGrupo1, bloquesGrupo2, datosGrupo2] */
const ESTRUCTURA_BLOQUES = (() => {
  const fuente = require('fs').readFileSync(path.resolve(__dirname, '..', 'src', 'qr.js'), 'utf8');
  const trozo = fuente.slice(fuente.indexOf('const ESTRUCTURA'), fuente.indexOf('/* Posiciones de alineacion'));
  return new Function(trozo + '\nreturn ESTRUCTURA;')();
})();

/* ------------------------------------------------------------------ */
/* Decodificador minimo                                                */
/* ------------------------------------------------------------------ */

/** Reconstruye el mapa de celdas reservadas (no son datos). */
function mapaReservado(tamano, version) {
  const r = Array.from({ length: tamano }, () => new Array(tamano).fill(false));
  const marcar = (f, c) => {
    if (f >= 0 && c >= 0 && f < tamano && c < tamano) r[f][c] = true;
  };

  // Patrones de posicion, con su separador.
  for (const [f0, c0] of [[0, 0], [0, tamano - 7], [tamano - 7, 0]]) {
    for (let f = -1; f <= 7; f++) for (let c = -1; c <= 7; c++) marcar(f0 + f, c0 + c);
  }

  // Patrones de alineacion.
  for (const f of ALINEACION[version]) {
    for (const c of ALINEACION[version]) {
      const sobrePosicion = (f <= 7 && c <= 7) || (f <= 7 && c >= tamano - 8) || (f >= tamano - 8 && c <= 7);
      if (sobrePosicion) continue;
      for (let df = -2; df <= 2; df++) for (let dc = -2; dc <= 2; dc++) marcar(f + df, c + dc);
    }
  }

  // Sincronizacion.
  for (let i = 8; i < tamano - 8; i++) {
    marcar(6, i);
    marcar(i, 6);
  }

  // Informacion de formato.
  for (let i = 0; i <= 8; i++) {
    marcar(8, i);
    marcar(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    marcar(8, tamano - 1 - i);
    marcar(tamano - 1 - i, 8);
  }
  marcar(tamano - 8, 8);

  // Informacion de version (desde la version 7).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const f = Math.floor(i / 3);
      const c = i % 3;
      marcar(tamano - 11 + c, f);
      marcar(f, tamano - 11 + c);
    }
  }

  return r;
}

/** Lee los 15 bits de formato de la primera copia y devuelve nivel y mascara. */
function leerFormato(modulos, tamano) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits.push(modulos[8][i] ? 1 : 0);
  bits.push(modulos[8][7] ? 1 : 0);
  bits.push(modulos[8][8] ? 1 : 0);
  bits.push(modulos[7][8] ? 1 : 0);
  for (let i = 9; i <= 14; i++) bits.push(modulos[14 - i][8] ? 1 : 0);

  let valor = 0;
  for (let i = 14; i >= 0; i--) valor = (valor << 1) | bits[i];
  valor ^= 0x5412;

  const datos = valor >> 10;
  const nivel = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[datos >> 3];
  const mascara = datos & 7;
  return { nivel, mascara };
}

/** Aplica la mascara indicada (invierte la celda cuando toca). */
function aplicarMascara(fila, col, mascara) {
  switch (mascara) {
    case 0: return (fila + col) % 2 === 0;
    case 1: return fila % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (fila + col) % 3 === 0;
    case 4: return (Math.floor(fila / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((fila * col) % 2) + ((fila * col) % 3) === 0;
    case 6: return (((fila * col) % 2) + ((fila * col) % 3)) % 2 === 0;
    case 7: return (((fila + col) % 2) + ((fila * col) % 3)) % 2 === 0;
    default: return false;
  }
}

/** Recorre los modulos de datos y devuelve los bytes. */
function leerDatos(modulos, tamano, version, mascara) {
  const reservado = mapaReservado(tamano, version);
  const bits = [];

  let subiendo = true;
  for (let col = tamano - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < tamano; i++) {
      const fila = subiendo ? tamano - 1 - i : i;
      for (let j = 0; j < 2; j++) {
        const c = col - j;
        if (reservado[fila][c]) continue;
        let bit = modulos[fila][c] ? 1 : 0;
        if (aplicarMascara(fila, c, mascara)) bit ^= 1;
        bits.push(bit);
      }
    }
    subiendo = !subiendo;
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }
  return bytes;
}

/**
 * Desentrelaza el flujo de palabras segun la estructura de bloques.
 *
 * Esto es imprescindible: cuando el simbolo tiene mas de un bloque, los datos
 * NO van seguidos en el flujo. Van repartidos palabra a palabra (la primera del
 * bloque 1, la primera del bloque 2, la segunda del 1, la segunda del 2...).
 * Sin desentrelazar, un simbolo de varios bloques se lee torcido a partir del
 * segundo byte, aunque la cabecera se vea bien.
 *
 * Devuelve las palabras de datos ya en orden.
 */
function desentrelazar(palabras, version, nivel) {
  const estructura = ESTRUCTURA_BLOQUES[version] && ESTRUCTURA_BLOQUES[version][nivel];
  if (!estructura) throw new Error('no hay estructura de bloques para v' + version + '-' + nivel);

  const [, , bloques1, datos1, bloques2, datos2] = estructura;
  const bloques = [];
  for (let i = 0; i < bloques1; i++) bloques.push({ datos: datos1, palabras: [] });
  for (let i = 0; i < bloques2; i++) bloques.push({ datos: datos2, palabras: [] });

  let pos = 0;
  const maxDatos = Math.max(...bloques.map((b) => b.datos));
  for (let i = 0; i < maxDatos; i++) {
    for (const bl of bloques) {
      if (i < bl.datos) {
        if (pos >= palabras.length) return bloques.flatMap((b) => b.palabras);
        bl.palabras.push(palabras[pos++]);
      }
    }
  }
  return bloques.flatMap((b) => b.palabras);
}

/** Interpreta el flujo: modo, longitud y contenido. */
function interpretar(bytes, version) {
  let pos = 0;
  const leer = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = bytes[pos >> 3];
      // Ojo: (byte >> k) & 1 ya es entero; el booleano se convierte aparte.
      v = (v << 1) | ((byte >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };

  const modo = leer(4);
  if (modo !== 4) return { modo, texto: null, error: 'no es modo byte (modo ' + modo + ')' };

  const longitud = leer(version < 10 ? 8 : 16);
  const contenido = [];
  for (let i = 0; i < longitud; i++) contenido.push(leer(8));

  return { modo, longitud, texto: Buffer.from(contenido).toString('utf8') };
}

/** Decodifica un SVG generado por src/qr.js y devuelve el texto. */
function decodificar(svg) {
  const version = Number((svg.match(/data-version="(\d+)"/) || [])[1]);
  if (!version) throw new Error('el SVG no trae data-version');
  if (version > 10) throw new Error('solo se decodifican versiones 1 a 10');

  // Ojo: el ancho del SVG no es el tamano del simbolo (incluye el margen).
  // El tamano real sale de la version, y el modulo de una de las celdas.
  const tamano = TAMANO_VERSION[version];
  if (!tamano) throw new Error('version desconocida: ' + version);

  const modulo = Number((svg.match(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+"\/>/) || [])[1]);
  if (!modulo) throw new Error('no se pudo deducir el tamano del modulo');
  const margen = Number((svg.match(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+"/) || [])[1]) / modulo;
  const colorFondo = (svg.match(/<rect width="\d+" height="\d+" fill="([^"]+)"/) || [])[1];

  // Se reconstruye la matriz a partir de los rectangulos oscuros.
  const modulos = Array.from({ length: tamano }, () => new Array(tamano).fill(false));
  const re = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const x = Number(m[1]) / modulo - margen;
    const y = Number(m[2]) / modulo - margen;
    const w = Number(m[3]) / modulo;
    if (Math.abs(w - 1) > 0.001) continue; // es el fondo, no un modulo
    modulos[Math.round(y)][Math.round(x)] = true;
  }

  const { nivel, mascara } = leerFormato(modulos, tamano);
  const palabras = leerDatos(modulos, tamano, version, mascara);
  // Los simbolos de varios bloques hay que desentrelazarlos antes de leerlos.
  const datos = desentrelazar(palabras, version, nivel);
  const lectura = interpretar(datos, version);
  return { texto: lectura.texto, version, nivel, mascara, colorFondo, longitud: lectura.longitud };
}

/* ------------------------------------------------------------------ */
/* Pruebas                                                             */
/* ------------------------------------------------------------------ */

/* El decodificador se exporta para poder usarlo desde otras pruebas: por
   ejemplo, comprobar que el QR impreso en un gafete se vuelve a leer. */
module.exports = {
  decodificar,
  leerFormato,
  leerDatos,
  desentrelazar,
  interpretar,
  mapaReservado,
  aplicarMascara,
  TAMANO_VERSION,
  ALINEACION,
  ESTRUCTURA_BLOQUES,
};

/* Las pruebas solo corren si a este archivo se le da doble clic (se ejecuta
   directamente). Importarlo desde otro sitio no dispara nada. */
if (require.main !== module) {
  return;
}

let ok = 0;
let fallos = 0;

function prueba(nombre, fn) {
  try {
    fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condicion no cumplida');
}

console.log('\n=== VisitaFlow: pruebas del codigo QR ===\n');

console.log('Ida y vuelta (lo que de verdad importa)');
const casos = [
  { texto: 'HOLA', nivel: 'L', version: 1 },
  { texto: '001-1234567-8', nivel: 'M', version: null },
  { texto: 'VF-4821', nivel: 'H', version: null },
  { texto: 'https://visitaflow.do/v/VF-4821', nivel: 'M', version: null },
  { texto: '00112345678|VF-4821|2026-10-15T09:30:00', nivel: 'Q', version: null },
  { texto: 'x'.repeat(120), nivel: 'L', version: null },
  { texto: 'Acentuación: José Peña, 5° piso', nivel: 'M', version: null },
];

for (const caso of casos) {
  prueba('se lee igual lo que se escribio: ' + JSON.stringify(caso.texto.slice(0, 34)) + (caso.texto.length > 34 ? '…' : '') + ' [' + caso.nivel + ']', () => {
    const svg = qr.generarSvg(caso.texto, { nivel: caso.nivel });
    esperar(svg, 'no se genero el SVG');
    const r = decodificar(svg);
    esperar(r.texto === caso.texto, 'se leyo "' + r.texto + '" en vez de "' + caso.texto + '"');
    esperar(r.nivel === caso.nivel, 'el nivel leido es ' + r.nivel + ' y se pidio ' + caso.nivel);
    if (caso.version) esperar(r.version === caso.version, 'version ' + r.version + ' en vez de ' + caso.version);
  });
}

console.log('\nEstructura del simbolo');
prueba('la version 1 mide 21x21 modulos', () => {
  const svg = qr.generarSvg('HOLA', { nivel: 'L' });
  const r = decodificar(svg);
  esperar(r.version === 1, 'version ' + r.version);
  esperar(qr.versionDe('HOLA', 'L') === 1, 'versionDe devolvio otra cosa');
});

prueba('los patrones de posicion estan en las tres esquinas', () => {
  const svg = qr.generarSvg('PRUEBA DE POSICION', { nivel: 'M' });
  const version = Number((svg.match(/data-version="(\d+)"/) || [])[1]);
  const tamano = { 1: 21, 2: 25, 3: 29, 4: 33 }[version];
  esperar(tamano, 'version fuera de rango para esta comprobacion: ' + version);

  const modulos = Array.from({ length: tamano }, () => new Array(tamano).fill(false));
  const modulo = Number((svg.match(/width="(\d+)" height="\d+"\/>/g) || [''])[0].match(/\d+/)[0]);
  const re = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"\/>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    if (Number(m[3]) !== modulo) continue;
    modulos[Number(m[2]) / modulo - 4][Number(m[1]) / modulo - 4] = true;
  }

  for (const [f0, c0] of [[0, 0], [0, tamano - 7], [tamano - 7, 0]]) {
    // El borde exterior del patron debe estar oscuro y el anillo interior claro.
    esperar(modulos[f0][c0], 'falta la esquina del patron en ' + f0 + ',' + c0);
    esperar(modulos[f0 + 1][c0 + 1] === false, 'el anillo del patron deberia ser claro en ' + f0 + ',' + c0);
    esperar(modulos[f0 + 3][c0 + 3], 'falta el centro del patron en ' + f0 + ',' + c0);
  }
});

prueba('los patrones de sincronizacion alternan entre los patrones de posicion', () => {
  const svg = qr.generarSvg('SINCRONIZACION', { nivel: 'M' });
  const version = Number((svg.match(/data-version="(\d+)"/) || [])[1]);
  const tamano = TAMANO_VERSION[version];
  const modulo = Number((svg.match(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+"\/>/) || [])[1]);
  const margen = Number((svg.match(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+"/) || [])[1]) / modulo;

  const modulos = Array.from({ length: tamano }, () => new Array(tamano).fill(false));
  const re = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    if (Math.abs(Number(m[3]) / modulo - 1) > 0.001) continue;
    modulos[Math.round(Number(m[2]) / modulo - margen)][Math.round(Number(m[1]) / modulo - margen)] = true;
  }

  /* La sincronizacion solo vive en el tramo que queda ENTRE los patrones de
     posicion. En la version 1 son las columnas 8 a 12 de la fila 6, y las filas
     8 a 12 de la columna 6. El resto de esa fila y esa columna son los
     separadores de los patrones de posicion y la copia 2 del formato, que en la
     esquina superior derecha ocupa justamente la fila 8: por eso no se puede
     exigir la alternancia de punta a punta. */
  for (let i = 8; i <= tamano - 9; i++) {
    const esperado = i % 2 === 0;
    esperar(modulos[6][i] === esperado, 'la fila 6 alterna mal en la columna ' + i);
    esperar(modulos[i][6] === esperado, 'la columna 6 alterna mal en la fila ' + i);
  }
});

console.log('\nDatos de entrada');
prueba('un texto vacio no genera nada', () => {
  esperar(qr.generarSvg('') === null, 'deberia devolver null');
  esperar(qr.generarSvg(null) === null, 'deberia devolver null');
});

prueba('un texto demasiado largo devuelve null en vez de fallar', () => {
  esperar(qr.generarSvg('x'.repeat(5000), { nivel: 'H' }) === null, 'deberia devolver null');
});

prueba('las opciones de color y tamano se respetan', () => {
  const svg = qr.generarSvg('COLOR', { color: '#123456', colorFondo: '#abcdef', modulo: 6 });
  esperar(svg.includes('#123456'), 'no aplico el color de los modulos');
  esperar(svg.includes('#abcdef'), 'no aplico el color de fondo');
});

prueba('el nivel de correccion se refleja en el simbolo', () => {
  const svgL = qr.generarSvg('MISMO TEXTO', { nivel: 'L' });
  const svgH = qr.generarSvg('MISMO TEXTO', { nivel: 'H' });
  const vL = Number((svgL.match(/data-version="(\d+)"/) || [])[1]);
  const vH = Number((svgH.match(/data-version="(\d+)"/) || [])[1]);
  esperar(vH >= vL, 'el nivel H deberia exigir una version igual o mayor');
});

prueba('el nivel por defecto es M', () => {
  const svg = qr.generarSvg('POR DEFECTO');
  esperar(svg.includes('data-nivel="M"'), 'el nivel por defecto no es M');
});

prueba('cuanto mas largo el texto, mayor la version', () => {
  const v1 = qr.versionDe('CORTO', 'L');
  const v2 = qr.versionDe('x'.repeat(60), 'L');
  esperar(v2 > v1, 'la version no crecio: ' + v1 + ' -> ' + v2);
});

console.log('\n---------------------------------------------');
console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
console.log('---------------------------------------------\n');
process.exit(fallos ? 1 : 0);
