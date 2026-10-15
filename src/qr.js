/**
 * VisitaFlow - Codigo QR.
 *
 * Implementacion propia (sin librerias) del QR en modo byte, que es lo que
 * necesita un gafete: el contenido tipico es la cedula o la direccion de
 * verificacion de la visita, y ambos son ASCII.
 *
 * El QR del gafete sirve para dos cosas:
 *   - registrar la salida pasando el gafete por un lector,
 *   - y, si la institucion lo publica, abrir una pagina que confirma que la
 *     visita es real sin exponer los datos personales del visitante.
 *
 * Salida en SVG: se imprime nitido a cualquier tamano.
 */
'use strict';

/* Capacidad de datos (en bytes) y bloques de correccion por version.
   Solo se incluyen las versiones 1 a 10: 1 a 269 bytes cubre de sobra una
   cedula, un codigo de visita o una direccion corta.
   El dato de "capacidad" es informativo; para elegir version se calcula en bits
   exactos contra la tabla de bloques, que es la que manda. */
const VERSIONES = [
  // version, [capacidad L, M, Q, H] en bytes
  { v: 1, capacidad: { L: 17, M: 14, Q: 11, H: 7 } },
  { v: 2, capacidad: { L: 32, M: 26, Q: 20, H: 14 } },
  { v: 3, capacidad: { L: 53, M: 42, Q: 32, H: 24 } },
  { v: 4, capacidad: { L: 78, M: 62, Q: 46, H: 34 } },
  { v: 5, capacidad: { L: 106, M: 84, Q: 60, H: 44 } },
  { v: 6, capacidad: { L: 134, M: 106, Q: 74, H: 58 } },
  { v: 7, capacidad: { L: 154, M: 122, Q: 86, H: 64 } },
  { v: 8, capacidad: { L: 192, M: 152, Q: 108, H: 84 } },
  { v: 9, capacidad: { L: 230, M: 180, Q: 130, H: 98 } },
  { v: 10, capacidad: { L: 271, M: 213, Q: 151, H: 119 } },
];

/* Tamano del modulo por version (cantidad de filas/columnas). */
const TAMANO = { 1: 21, 2: 25, 3: 29, 4: 33, 5: 37, 6: 41, 7: 45, 8: 49, 9: 53, 10: 57 };

/* Palabras de datos y de correccion por version y nivel.
   Formato: { version: { nivel: [palabrasDatos, palabrasCorreccion, bloquesGrupo1, datosGrupo1, bloquesGrupo2, datosGrupo2] } } */
const ESTRUCTURA = {
  1: { L: [19, 7, 1, 19, 0, 0], M: [16, 10, 1, 16, 0, 0], Q: [13, 13, 1, 13, 0, 0], H: [9, 17, 1, 9, 0, 0] },
  2: { L: [34, 10, 1, 34, 0, 0], M: [28, 16, 1, 28, 0, 0], Q: [22, 22, 1, 22, 0, 0], H: [16, 28, 1, 16, 0, 0] },
  3: { L: [55, 15, 1, 55, 0, 0], M: [44, 26, 1, 44, 0, 0], Q: [34, 18, 2, 17, 0, 0], H: [26, 22, 2, 13, 0, 0] },
  4: { L: [80, 20, 1, 80, 0, 0], M: [64, 18, 2, 32, 0, 0], Q: [48, 26, 2, 24, 0, 0], H: [36, 16, 4, 9, 0, 0] },
  5: { L: [108, 26, 1, 108, 0, 0], M: [86, 24, 2, 43, 0, 0], Q: [62, 18, 2, 15, 2, 16], H: [46, 22, 2, 11, 2, 12] },
  6: { L: [136, 18, 2, 68, 0, 0], M: [108, 16, 4, 27, 0, 0], Q: [76, 24, 4, 19, 0, 0], H: [60, 28, 4, 15, 0, 0] },
  7: { L: [156, 20, 2, 78, 0, 0], M: [124, 18, 4, 31, 0, 0], Q: [88, 18, 2, 14, 4, 15], H: [66, 26, 4, 13, 1, 14] },
  8: { L: [194, 24, 2, 97, 0, 0], M: [154, 22, 2, 38, 2, 39], Q: [110, 22, 4, 18, 2, 19], H: [86, 26, 4, 14, 2, 15] },
  9: { L: [232, 30, 2, 116, 0, 0], M: [182, 22, 3, 36, 2, 37], Q: [132, 20, 4, 16, 4, 17], H: [100, 24, 4, 12, 4, 13] },
  10: { L: [274, 18, 2, 68, 2, 69], M: [216, 26, 4, 43, 1, 44], Q: [154, 24, 6, 19, 2, 20], H: [122, 28, 6, 15, 2, 16] },
};

/* Posiciones de alineacion por version (patrones de alineacion). */
const ALINEACION = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ------------------------------------------------------------------ */
/* Campo de Galois GF(256) para Reed-Solomon                           */
/* ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function inicializarGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // polinomioprimario del QR
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function multiplicar(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Polinomio generador de Reed-Solomon para n palabras de correccion. */
function generador(grado) {
  let poli = [1];
  for (let i = 0; i < grado; i++) {
    const siguiente = new Array(poli.length + 1).fill(0);
    for (let j = 0; j < poli.length; j++) {
      siguiente[j] ^= multiplicar(poli[j], 1);
      siguiente[j + 1] ^= multiplicar(poli[j], EXP[i]);
    }
    poli = siguiente;
  }
  return poli;
}

/** Calcula las palabras de correccion de un bloque de datos. */
function correccion(datos, grado) {
  const gen = generador(grado);
  const resto = new Array(grado).fill(0);

  for (const byte of datos) {
    const factor = byte ^ resto[0];
    resto.shift();
    resto.push(0);
    for (let i = 0; i < grado; i++) {
      resto[i] ^= multiplicar(gen[i + 1], factor);
    }
  }
  return resto;
}

/* ------------------------------------------------------------------ */
/* Construccion de la matriz                                           */
/* ------------------------------------------------------------------ */

/**
 * Genera la matriz de modulos del QR.
 * @param {string} texto
 * @param {'L'|'M'|'Q'|'H'} nivel
 * @returns {{modulos:boolean[][], tamano:number, version:number, nivel:string}|null}
 */
function matriz(texto, nivel) {
  const nivelSeguro = ['L', 'M', 'Q', 'H'].includes(nivel) ? nivel : 'M';
  const bytes = Buffer.from(String(texto), 'utf8');

  // Version mas pequena donde quepan los datos. Se calcula en BITS exactos
  // (4 de modo + 8 o 16 de longitud + 8 por byte), no con la tabla de capacidad
  // en bytes: usar la tabla redondeada hacia arriba hace que se elija una
  // version mas grande de la necesaria y el QR sale mas denso en el gafete.
  let version = null;
  for (const entrada of VERSIONES) {
    const bitsLongitud = entrada.v < 10 ? 8 : 16;
    const [, , b1, d1, b2, d2] = ESTRUCTURA[entrada.v][nivelSeguro];
    const bitsDisponibles = (b1 * d1 + b2 * d2) * 8;
    const necesario = 4 + bitsLongitud + bytes.length * 8;
    if (necesario <= bitsDisponibles) {
      version = entrada.v;
      break;
    }
  }
  if (!version) return null; // demasiado largo para las versiones soportadas

  const tamano = TAMANO[version];
  const [, , bloques1, datos1, bloques2, datos2] = ESTRUCTURA[version][nivelSeguro];
  const totalBloques = bloques1 + bloques2;
  const palabrasDatos = bloques1 * datos1 + bloques2 * datos2;

  /* --- Flujo de bits: modo byte (0100) + longitud + datos + terminador --- */
  const bits = [];
  const agregar = (valor, cantidad) => {
    for (let i = cantidad - 1; i >= 0; i--) bits.push((valor >> i) & 1);
  };

  agregar(0b0100, 4);
  agregar(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) agregar(b, 8);

  // Terminador y relleno hasta completar las palabras de datos.
  const capacidadBits = palabrasDatos * 8;
  for (let i = 0; i < 4 && bits.length < capacidadBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const palabras = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    palabras.push(byte);
  }
  // Relleno alterno 0xEC / 0x11 exigido por la norma.
  const rellenos = [0xec, 0x11];
  let r = 0;
  while (palabras.length < palabrasDatos) palabras.push(rellenos[r++ % 2]);

  /* --- Bloques y correccion --- */
  const bloques = [];
  let pos = 0;
  for (let i = 0; i < bloques1; i++) {
    bloques.push(palabras.slice(pos, pos + datos1));
    pos += datos1;
  }
  for (let i = 0; i < bloques2; i++) {
    bloques.push(palabras.slice(pos, pos + datos2));
    pos += datos2;
  }

  const palabrasCorreccion = ESTRUCTURA[version][nivelSeguro][1];
  const correcciones = bloques.map((b) => correccion(b, palabrasCorreccion));

  /* --- Entrelazado --- */
  const flujo = [];
  const maxDatos = Math.max(...bloques.map((b) => b.length));
  for (let i = 0; i < maxDatos; i++) {
    for (const b of bloques) if (i < b.length) flujo.push(b[i]);
  }
  for (let i = 0; i < palabrasCorreccion; i++) {
    for (const c of correcciones) flujo.push(c[i]);
  }

  /* --- Colocacion de los modulos --- */
  const modulos = Array.from({ length: tamano }, () => new Array(tamano).fill(false));
  const reservado = Array.from({ length: tamano }, () => new Array(tamano).fill(false));

  const colocar = (fila, col, oscuro) => {
    modulos[fila][col] = oscuro;
    reservado[fila][col] = true;
  };

  // Patrones de posicion (las tres esquinas).
  const posicion = (fila, col) => {
    for (let f = -1; f <= 7; f++) {
      for (let c = -1; c <= 7; c++) {
        const ff = fila + f;
        const cc = col + c;
        if (ff < 0 || cc < 0 || ff >= tamano || cc >= tamano) continue;
        const enBorde = f === 0 || f === 6 || c === 0 || c === 6;
        const enCentro = f >= 2 && f <= 4 && c >= 2 && c <= 4;
        colocar(ff, cc, enBorde || enCentro);
      }
    }
  };
  posicion(0, 0);
  posicion(0, tamano - 7);
  posicion(tamano - 7, 0);

  // Patrones de alineacion.
  const centros = ALINEACION[version];
  for (const f of centros) {
    for (const c of centros) {
      // Se omiten los que caen sobre los patrones de posicion.
      const sobrePosicion =
        (f <= 7 && c <= 7) || (f <= 7 && c >= tamano - 8) || (f >= tamano - 8 && c <= 7);
      if (sobrePosicion) continue;
      for (let df = -2; df <= 2; df++) {
        for (let dc = -2; dc <= 2; dc++) {
          const oscuro = Math.max(Math.abs(df), Math.abs(dc)) !== 1;
          colocar(f + df, c + dc, oscuro);
        }
      }
    }
  }

  // Informacion de formato: se reserva ahora y se escribe al final.
  const formato = (fila, col) => {
    if (fila >= 0 && fila < tamano && col >= 0 && col < tamano) reservado[fila][col] = true;
  };
  for (let i = 0; i <= 8; i++) {
    formato(8, i);
    formato(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    formato(8, tamano - 1 - i);
    formato(tamano - 1 - i, 8);
  }
  formato(tamano - 8, 8);

  // Informacion de version a partir de la version 7.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const f = Math.floor(i / 3);
      const c = i % 3;
      reservado[tamano - 11 + c][f] = true;
      reservado[f][tamano - 11 + c] = true;
    }
  }

  // Modulo oscuro fijo.
  colocar(tamano - 8, 8, true);

  /* Patrones de sincronizacion: la fila y la columna 6 alternan desde el
     borde. Se pintan al final de los patrones fijos para rellenar los tramos
     que no reclaman ni los patrones de posicion ni la informacion de formato;
     sin esto quedarian celdas vacias en medio del simbolo. */
  for (let i = 8; i < tamano - 8; i++) {
    const oscuro = i % 2 === 0;
    modulos[6][i] = oscuro;
    reservado[6][i] = true;
    modulos[i][6] = oscuro;
    reservado[i][6] = true;
  }

  /* --- Datos en zigzag desde la esquina inferior derecha --- */
  let indice = 0;
  const bitEn = (n) => {
    const byte = flujo[n >> 3];
    if (byte === undefined) return 0;
    return (byte >> (7 - (n & 7))) & 1;
  };

  let subiendo = true;
  for (let col = tamano - 1; col > 0; col -= 2) {
    if (col === 6) col--; // la columna 6 es la de sincronizacion
    for (let i = 0; i < tamano; i++) {
      const fila = subiendo ? tamano - 1 - i : i;
      for (let j = 0; j < 2; j++) {
        const c = col - j;
        if (reservado[fila][c]) continue;
        let oscuro = bitEn(indice++) === 1;
        // Mascara 0: (fila + columna) par.
        if ((fila + c) % 2 === 0) oscuro = !oscuro;
        modulos[fila][c] = oscuro;
      }
    }
    subiendo = !subiendo;
  }

  /* --- Informacion de formato (nivel + mascara 0) --- */
  const indicadorNivel = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[nivelSeguro];
  let datosFormato = (indicadorNivel << 3) | 0; // mascara 0
  let resto = datosFormato;
  for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >> 9) * 0x537);
  const formatoFinal = ((datosFormato << 10) | resto) ^ 0x5412;

  const bitFormato = (i) => ((formatoFinal >> i) & 1) === 1;

  // Primera copia, alrededor de la esquina superior izquierda.
  for (let i = 0; i <= 5; i++) modulos[8][i] = bitFormato(i);
  modulos[8][7] = bitFormato(6);
  modulos[8][8] = bitFormato(7);
  modulos[7][8] = bitFormato(8);
  for (let i = 9; i <= 14; i++) modulos[14 - i][8] = bitFormato(i);

  // Segunda copia, repartida entre las otras dos esquinas.
  for (let i = 0; i <= 7; i++) modulos[tamano - 1 - i][8] = bitFormato(i);
  for (let i = 8; i <= 14; i++) modulos[8][tamano - 15 + i] = bitFormato(i);
  modulos[tamano - 8][8] = true;

  /* --- Informacion de version (a partir de la 7) --- */
  if (version >= 7) {
    let v = version;
    let restoV = version;
    for (let i = 0; i < 12; i++) restoV = (restoV << 1) ^ ((restoV >> 11) * 0x1f25);
    const bitsVersion = (v << 12) | restoV;
    for (let i = 0; i < 18; i++) {
      const bit = ((bitsVersion >> i) & 1) === 1;
      const f = Math.floor(i / 3);
      const c = i % 3;
      modulos[tamano - 11 + c][f] = bit;
      modulos[f][tamano - 11 + c] = bit;
    }
  }

  return { modulos, tamano, version, nivel: nivelSeguro };
}

/* ------------------------------------------------------------------ */
/* Salida SVG                                                          */
/* ------------------------------------------------------------------ */

function escapar(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Genera el SVG del QR.
 * @param {string} texto
 * @param {object} opciones { nivel, modulo, margen, color, colorFondo, radio }
 * @returns {string|null} SVG, o null si el texto no cabe o esta vacio.
 */
function generarSvg(texto, opciones = {}) {
  if (texto === null || texto === undefined || String(texto) === '') return null;

  const salida = matriz(texto, opciones.nivel || 'M');
  if (!salida) return null;

  const { modulos, tamano, version, nivel } = salida;
  const modulo = opciones.modulo || 4;
  const margen = opciones.margen === undefined ? 4 : opciones.margen;
  const color = opciones.color || '#111827';
  const colorFondo = opciones.colorFondo || '#ffffff';
  const lado = (tamano + margen * 2) * modulo;

  const partes = [];
  for (let f = 0; f < tamano; f++) {
    for (let c = 0; c < tamano; c++) {
      if (!modulos[f][c]) continue;
      const x = (c + margen) * modulo;
      const y = (f + margen) * modulo;
      partes.push(`<rect x="${x}" y="${y}" width="${modulo}" height="${modulo}"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}" role="img" aria-label="Codigo QR de ${escapar(texto)}" data-version="${version}" data-nivel="${nivel}">
  <rect width="${lado}" height="${lado}" fill="${colorFondo}"/>
  <g fill="${color}">${partes.join('')}</g>
</svg>`;
}

/** Texto en blanco y negro, util para pruebas en consola. */
function comoTexto(texto, opciones = {}) {
  const salida = matriz(texto, opciones.nivel || 'M');
  if (!salida) return null;
  const { modulos, tamano } = salida;
  const lineas = [];
  for (let f = 0; f < tamano; f++) {
    let linea = '';
    for (let c = 0; c < tamano; c++) linea += modulos[f][c] ? '##' : '  ';
    lineas.push(linea);
  }
  return lineas.join('\n');
}

function versionDe(texto, nivel) {
  const salida = matriz(texto, nivel || 'M');
  return salida ? salida.version : null;
}

module.exports = { generarSvg, comoTexto, versionDe, matriz };
