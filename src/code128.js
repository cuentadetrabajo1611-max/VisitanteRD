/* ============================================================================
   Codigo de barras Code 128
   ----------------------------------------------------------------------------
   Genera el codigo de barras que llevara la credencial del visitante, sin
   depender de librerias externas.

   Se implementa Code 128 en su juego B (el que cubre ASCII imprimible), que es
   el estandar usado en documentos de identificacion y pases.

   La salida es SVG: se imprime nitido a cualquier tamano y el navegador lo
   dibuja sin necesidad de imagenes.

   Estructura de un simbolo Code 128:
     [inicio B] [datos...] [digito verificador] [parada] [terminacion]
   Cada caracter se representa con 6 elementos (barras y espacios) de ancho
   variable, segun la tabla de patrones.
   ============================================================================ */
'use strict';

/* Anchos de los 107 simbolos de Code 128 (0-102 datos, 103-105 inicio, 106 parada).
   Cada patron son 6 digitos: barra, espacio, barra, espacio, barra, espacio. */
const PATRONES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const INICIO_B = 104;
const PARADA = 106;
const VALOR_BASE = 32; // Code 128 B: caracter ASCII = valor + 32

/**
 * Convierte un texto a la secuencia de valores Code 128 B.
 * Devuelve null si hay caracteres fuera del rango soportado.
 */
function valoresDe(texto) {
  const valores = [INICIO_B];

  for (const caracter of String(texto)) {
    const codigo = caracter.charCodeAt(0);

    /* Code 128 B cubre del 32 (espacio) al 126 (~). No se admiten caracteres
       acentuados ni de control: el codigo de la credencial se arma solo con
       mayusculas, digitos y guiones. */
    if (codigo < VALOR_BASE || codigo > 126) return null;

    valores.push(codigo - VALOR_BASE);
  }

  /* Digito verificador: inicio + suma ponderada de los datos, modulo 103. */
  let suma = INICIO_B;
  for (let i = 1; i < valores.length; i++) {
    suma += valores[i] * i;
  }

  valores.push(suma % 103);
  valores.push(PARADA);

  return valores;
}

/**
 * Genera el SVG del codigo de barras.
 *
 * @param {string} texto        Contenido a codificar.
 * @param {object} opciones     { alto, grosorModulo, mostrarTexto, color }
 * @returns {string|null}       SVG, o null si el texto no es codificable.
 */
function generarSvg(texto, opciones = {}) {
  const valores = valoresDe(texto);
  if (!valores) return null;

  const alto = opciones.alto || 60;
  const modulo = opciones.grosorModulo || 1.6;
  const color = opciones.color || '#111827';
  const mostrarTexto = opciones.mostrarTexto !== false;
  const altoTexto = mostrarTexto ? 16 : 0;

  /* Se recorre cada simbolo y se alternan barras (indice par) y espacios. */
  let x = 0;
  const barras = [];

  for (const valor of valores) {
    const patron = PATRONES[valor];

    for (let i = 0; i < patron.length; i++) {
      const ancho = parseInt(patron[i], 10) * modulo;

      // Los indices pares son barra; los impares, espacio.
      if (i % 2 === 0) {
        barras.push(`<rect x="${x.toFixed(2)}" y="0" width="${ancho.toFixed(2)}" height="${alto}" />`);
      }

      x += ancho;
    }
  }

  const anchoTotal = x;
  const altoTotal = alto + altoTexto;

  const etiqueta = mostrarTexto
    ? `<text x="${(anchoTotal / 2).toFixed(2)}" y="${alto + 13}"
             font-family="monospace" font-size="12" fill="${color}"
             text-anchor="middle">${escapar(texto)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${anchoTotal.toFixed(2)}" height="${altoTotal}"
       viewBox="0 0 ${anchoTotal.toFixed(2)} ${altoTotal}" role="img" aria-label="Codigo de barras ${escapar(texto)}">
  <g fill="${color}">${barras.join('')}</g>
  ${etiqueta}
</svg>`;
}

function escapar(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Comprueba si un texto se puede codificar con Code 128 B.
 */
function esCodificable(texto) {
  return valoresDe(texto) !== null;
}

module.exports = { generarSvg, esCodificable, valoresDe };
