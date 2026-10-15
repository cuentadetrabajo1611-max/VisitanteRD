/**
 * VisitaFlow - Hoja de impresión del gafete.
 *
 *   const hoja = impresion.generar(gafete, { formato: 'termica', copias: 1 }, '/app.css');
 *   res.type('html').send(hoja);
 *
 * POR QUE ESTO SE GENERA EN EL SERVIDOR
 * -------------------------------------
 * El tamaño de la página de impresión solo se puede fijar con una regla @page, y
 * esa regla tiene que estar en el documento ANTES de que el navegador imprima.
 * Comprobado con Chrome, midiendo el PDF resultante:
 *
 *     @page sin condiciones               -> vale para todo, no distingue
 *     body.imp-termica { size: ... }      -> lo IGNORA, sale en A4
 *     body:has(.gafete) { size: ... }     -> lo IGNORA también
 *     @page en el documento               -> funciona
 *     @page inyectado con retardo         -> funciona
 *
 * Desde la pantalla principal no se puede garantizar lo segundo, así que el
 * navegador abre esta hoja, que ya viene con su @page puesto. La misma hoja
 * sirve para la impresora térmica y para la hoja A4: lo único que cambia es el
 * tamaño de página y el margen.
 *
 * De paso, la hoja no tiene barra lateral ni diálogos ni avisos, así que no hay
 * que esconder nada al imprimir. Esa es la parte donde más fácil se cuela un
 * error, y aquí desaparece.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const util = require('./util');

/* La hoja de estilos se INCRUSTA en la hoja de impresión, no se enlaza.
 *
 * Enlazarla parecía más limpio, pero tiene tres problemas y el tercero es el
 * que duele:
 *
 *   1. Es una petición más que puede fallar justo antes de imprimir.
 *   2. Si el CSS llega tarde, el gafete sale sin estilos.
 *   3. Al imprimir desde un archivo (que es como se comprueba esto con el
 *      navegador sin interfaz), el enlace no resuelve y el gafete sale en texto
 *      plano. Eso ocultaba el problema en las pruebas: el PDF salía con el
 *      tamaño correcto y sin una sola línea de diseño.
 *
 * Incrustado, la hoja es autosuficiente: se ve igual abriéndola desde el
 * servidor, desde un archivo o desde el papel. */
let cssCache = null;

function hojaDeEstilos() {
  if (cssCache !== null) return cssCache;
  try {
    cssCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  } catch (e) {
    // Sin el CSS la hoja sale sin diseño. Es mejor saberlo que imprimir un
    // gafete en texto plano sin que nadie se entere.
    console.error('[visitaflow] AVISO: no se pudo leer public/app.css para la impresión: ' + e.message);
    cssCache = '';
  }
  return cssCache;
}

/* Los tres formatos. 'pagina' en null significa que la página toma el tamaño
   del propio gafete (la etiqueta térmica). */
const FORMATOS = {
  a4: { nombre: 'Hoja A4', pagina: null, margen: '12mm', repetir: true },
  ajustado: { nombre: 'Hoja A4 al tamaño del gafete', pagina: 'A4', margen: '6mm', repetir: true },
  termica: { nombre: 'Etiqueta térmica', pagina: null, margen: '0', repetir: false },
};

function formatoValido(codigo) {
  return FORMATOS[codigo] ? codigo : 'a4';
}

/** Milímetros a píxeles, para la vista en pantalla. */
function px(mm) {
  return Math.round((mm / 25.4) * 96);
}

/** Escapa para HTML. Se apoya en el del sistema para no tener dos versiones. */
function esc(v) {
  return util.limpiar(v === null || v === undefined ? '' : String(v), 4000) || '';
}

/** Escapa pero conserva el texto tal cual (util.limpiar recorta espacios). */
function texto(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * El gafete en sí: el mismo marcado que ve el recepcionista en pantalla.
 *
 * El aspecto lo pone app.css, que la hoja carga como cualquier otra página. Así
 * NO hay dos definiciones del mismo diseño que se puedan separar con el tiempo:
 * si mañana cambia el gafete en pantalla, cambia también en el papel.
 */
function gafeteHtml(g) {
  const p = g.plantilla || {};
  const anchoMm = p.ancho_mm || 105;
  const altoMm = p.alto_mm || 74;

  const lineas = [
    ['Cédula', g.cedula],
    ['Visita a', g.visitado],
    ['Departamento', g.departamento],
    ['Motivo', g.motivo],
    ['Entrada', g.entrada_legible],
    ['Válido hasta', g.valido_hasta],
    g.acompanantes ? ['Acompañantes', g.acompanantes] : null,
    g.vehiculo ? ['Vehículo', g.vehiculo] : null,
  ].filter(Boolean);

  const logo = g.institucion.logo_url
    ? '<img src="' + texto(g.institucion.logo_url) + '" alt="">'
    : texto(iniciales(g.institucion.nombre_comercial));

  return (
    '<div class="gafete" style="' +
    '--gafete-ancho:' + px(anchoMm) + 'px;--gafete-alto:' + px(altoMm) + 'px;' +
    '--gafete-marca:' + texto(g.colores.primario) + ';' +
    '--gafete-sobre-marca:' + texto(g.colores.texto_sobre_primario) + ';' +
    '--gafete-fondo:' + texto(g.colores.fondo) + ';' +
    (g.colores.texto_plantilla ? '--gafete-texto:' + texto(g.colores.texto_plantilla) + ';' : '') +
    '">' +
    '<div class="gafete__franja">' +
    '<div class="gafete__logo">' + logo + '</div>' +
    '<div class="crecer">' +
    '<div class="gafete__institucion">' + texto(g.institucion.nombre_comercial) + '</div>' +
    '<div class="gafete__tipo">Gafete de visitante</div>' +
    '</div></div>' +
    '<div class="gafete__cuerpo">' +
    '<div class="gafete__principal">' +
    '<div class="gafete__nombre">' + texto(g.nombre) + '</div>' +
    (g.cedula ? '<div class="gafete__cedula">' + texto(g.cedula) + '</div>' : '') +
    '<div class="gafete__lineas">' +
    lineas
      .map(
        (l) =>
          '<div class="gafete__linea"><span>' + texto(l[0]) + '</span><span>' +
          texto(l[1] || '—') + '</span></div>'
      )
      .join('') +
    '</div></div>' +
    '<div class="gafete__codigos">' +
    (g.codigos.qr_svg ? '<div class="gafete__qr">' + g.codigos.qr_svg + '</div>' : '') +
    (g.codigos.barras_svg ? '<div class="gafete__barras">' + g.codigos.barras_svg + '</div>' : '') +
    '<div class="gafete__codigo">' + texto(g.codigo) + '</div>' +
    '</div></div>' +
    '<div class="gafete__pie">' +
    '<span>' + texto(g.institucion.texto_pie || 'Conserve este gafete mientras esté en las instalaciones') + '</span>' +
    '<span>' + texto(g.codigo) + '</span>' +
    '</div></div>'
  );
}

/** Las iniciales del nombre, para cuando no hay logo. */
function iniciales(nombre) {
  return String(nombre || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase() || 'VF';
}

/**
 * La hoja completa, lista para imprimir.
 *
 * @param {object} g        lo que devuelve gafete.contenido()
 * @param {object} opciones { formato, copias, urlCss, soloGafete }
 * @returns {string} HTML
 */
function generar(g, opciones) {
  const o = opciones || {};
  const formato = formatoValido(o.formato);
  const f = FORMATOS[formato];

  const p = g.plantilla || {};
  const anchoMm = p.ancho_mm || 105;
  const altoMm = p.alto_mm || 74;

  /* Tamaño de la página:
       - A4: la hoja normal.
       - 'ajustado': también A4, pero con menos margen, para que el gafete
         salga a su tamaño real.
       - térmica: el tamaño del gafete, porque la página ES la etiqueta. */
  const tamanoPagina =
    formato === 'termica' ? anchoMm + 'mm ' + altoMm + 'mm' : (f.pagina || 'A4');

  const copias = Math.max(1, Math.min(20, Number(o.copias) || 1));
  const repetir = f.repetir && copias > 1;

  const unaCopia = gafeteHtml(g);

  // El gafete se repite para las copias. En la térmica cada etiqueta ya es una
  // página, así que ahí no se repite en la misma hoja.
  const cuerpo = repetir
    ? new Array(copias + 1).join(unaCopia)
    : unaCopia;

  return (
    '<!DOCTYPE html>\n' +
    '<html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Gafete ' + texto(g.codigo) + '</title>' +
    /* El diseño del gafete se incrusta: la hoja tiene que verse igual sin
       depender de que el navegador alcance a pedir la hoja de estilos. */
    '<style>' + hojaDeEstilos() + '</style>' +
    '<style>' +
    /* Aquí está lo importante: la regla @page, en el documento desde el
       principio. Es lo único que Chrome respeta. */
    '@page { size: ' + tamanoPagina + '; margin: ' + f.margen + '; }' +
    'html, body { margin: 0; padding: 0; background: #fff; }' +
    /* La hoja no tiene la aplicación alrededor, así que solo hay que quitar el
       fondo gris de la vista previa. */
    '.vf-hoja__pagina { padding: ' + (formato === 'termica' ? '0' : '6mm') + '; }' +
    (repetir
      ? '.vf-hoja__pagina { display: block; } .vf-hoja__pagina .gafete { margin: 0 auto 10mm; page-break-inside: avoid; }'
      : '') +
    // El gafete no lleva el borde de referencia cuando va a papel.
    '.gafete { border: 0 !important; box-shadow: none !important; margin: 0 auto; }' +
    (formato === 'termica'
      ? '.gafete, .gafete__franja { border-radius: 0 !important; } .vf-hoja__pagina { padding: 0; }'
      : '') +
    '</style>' +
    '</head><body class="vf-hoja' + (formato === 'termica' ? ' vf-hoja--termica' : '') + '">' +
    '<div class="vf-hoja__pagina">' + cuerpo + '</div>' +
    /* Se imprime sola al abrirse. El retardo da tiempo a que el navegador
       aplique los estilos y cargue el logo; sin él, el gafete puede salir sin
       diseño o con el logo en blanco. */
    '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},250);});<\/script>' +
    '</body></html>'
  );
}

module.exports = {
  FORMATOS,
  formatoValido,
  generar,
  gafeteHtml,
  iniciales,
  hojaDeEstilos,
};
