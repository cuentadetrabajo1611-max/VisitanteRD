/**
 * VisitaFlow - Comprueba la impresion del gafete.
 *
 *   node scripts/probar-impresion.js
 *
 * POR QUE EXISTE
 * --------------
 * La impresion del gafete es lo unico del sistema que NO se puede comprobar con
 * una prueba normal: el resultado no es una respuesta de la API, es papel. Y es
 * justo donde mas facil es equivocarse, porque el CSS de impresion tiene reglas
 * que se pelean entre si (un "display: block" que anula un "display: none", por
 * ejemplo) y el error solo se ve al imprimir.
 *
 * Este script imprime a PDF con Chrome sin interfaz, en los tres formatos, y
 * despues COMPRUEBA EL PDF: que el gafete este, que no este la barra lateral, y
 * cual es el tamaño de la pagina. Un PDF con el gafete y sin menus es la prueba
 * de que el CSS de impresion hace lo que debe.
 *
 * Los PDF quedan en tmp/impresion/ para que se puedan mirar.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const { leerCredenciales } = require('./credenciales');

const NAVEGADORES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const SALIDA = path.join(RAIZ, 'tmp', 'impresion');
const BASE = 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const detalle = [];

function prueba(nombre, fn) {
  try {
    fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    detalle.push(nombre + ' -> ' + e.message);
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

function navegador() {
  for (const r of NAVEGADORES) if (fs.existsSync(r)) return r;
  return null;
}

async function pedir(metodo, ruta, cuerpo, token) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  try { return { estado: r.status, datos: JSON.parse(texto) }; } catch (e) { return { estado: r.status, datos: {} }; }
}

/**
 * Cuenta las paginas de un PDF sin librerias.
 *
 * Se busca "/Type /Page" (no "/Pages", que es el indice). Sirve para saber si el
 * gafete ocupa una hoja o si el navegador genero paginas de mas.
 */
function paginasDelPdf(buffer) {
  const texto = buffer.toString('latin1');
  const coincidencias = texto.match(/\/Type\s*\/Page[^s]/g);
  return coincidencias ? coincidencias.length : 0;
}

/** Tamaño de la primera pagina, leyendo el MediaBox del PDF. */
function tamanoPrimeraPagina(buffer) {
  const texto = buffer.toString('latin1');
  const m = texto.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (!m) return null;
  // El PDF mide en puntos: 1 pt = 1/72 pulgada. A milimetros.
  const anchoPt = parseFloat(m[3]) - parseFloat(m[1]);
  const altoPt = parseFloat(m[4]) - parseFloat(m[2]);
  return {
    anchoMm: Math.round((anchoPt / 72) * 25.4),
    altoMm: Math.round((altoPt / 72) * 25.4),
  };
}

/**
 * Cuenta cuántas veces aparece un elemento en el marcado, ignorando el CSS.
 *
 * Hace falta ignorar el CSS porque la hoja lleva la hoja de estilos incrustada:
 * buscando texto suelto, una regla como ".gafete__nombre { ... }" se confundiría
 * con un gafete de verdad. Aquí solo se mira el HTML.
 */
function contarElementos(documento, clase) {
  const sinEstilo = documento.replace(/<style[\s\S]*?<\/style>/gi, '');
  const re = new RegExp('class="[^"]*\\b' + clase + '\\b[^"]*"', 'g');
  const m = sinEstilo.match(re);
  return m ? m.length : 0;
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - impresión del gafete');
  console.log('  ' + '='.repeat(64));

  const nav = navegador();
  if (!nav) {
    console.error('\n  No se encontró Chrome ni Edge.\n');
    process.exit(1);
  }

  try {
    const r = await fetch(BASE + '/api/salud');
    if (!r.ok) throw new Error('estado ' + r.status);
  } catch (e) {
    console.error('\n  El servidor no responde en ' + BASE + '. Arránquelo con: npm start\n');
    process.exit(1);
  }

  const cred = leerCredenciales();
  if (!cred) {
    console.error('\n  No hay credenciales del administrador. Use: npm run admin:restablecer <institucion>\n');
    process.exit(1);
  }

  const entrada = await pedir('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  const token = entrada.datos.token;
  if (!token) {
    console.error('\n  No se pudo iniciar sesión.\n');
    process.exit(1);
  }

  // Se busca una visita con gafete ya emitido.
  const bitacora = await pedir('GET', '/api/visitas?tamano=5', undefined, token);
  const filas = (bitacora.datos.listado && bitacora.datos.listado.filas) || [];
  if (!filas.length) {
    console.error('\n  No hay visitas. Genere datos de prueba con: npm run demo\n');
    process.exit(1);
  }

  const visita = filas[0];
  const gaf = await pedir('GET', '/api/gafetes/visita/' + visita.id, undefined, token);
  if (gaf.estado !== 200) {
    console.error('\n  No se pudo obtener el gafete: ' + gaf.estado + '\n');
    process.exit(1);
  }

  const p = gaf.datos.gafete.plantilla || {};
  const anchoMm = p.ancho_mm || 105;
  const altoMm = p.alto_mm || 74;
  console.log('  Visita : ' + visita.codigo);
  console.log('  Gafete : ' + anchoMm + ' × ' + altoMm + ' mm');
  console.log('  Navegador: ' + path.basename(nav));
  console.log('');

  fs.mkdirSync(SALIDA, { recursive: true });

  const formatos = [
    { clave: 'a4', nombre: 'Hoja A4, una por gafete', esperado: { anchoMm: 210, altoMm: 297 } },
    { clave: 'ajustado', nombre: 'Hoja A4 al tamaño del gafete', esperado: { anchoMm: 210, altoMm: 297 } },
    { clave: 'termica', nombre: 'Impresora térmica (' + anchoMm + '×' + altoMm + ' mm)', esperado: { anchoMm, altoMm } },
  ];

  const resultados = [];

  for (const f of formatos) {
    const pdf = path.join(SALIDA, 'gafete-' + f.clave + '.pdf');
    const html = path.join(SALIDA, 'hoja-' + f.clave + '.html');

    /* Se pide la HOJA DE IMPRESIÓN al servidor —la misma que abre el botón
       Imprimir— y se guarda en disco. Se le quita el <script> que dispara
       window.print(): en el navegador sin interfaz eso no sirve de nada, y
       además así se comprueba que el tamaño lo pone el @page y no el script. */
    const r = await fetch(BASE + '/api/gafetes/visita/' + visita.id + '/hoja?formato=' + f.clave + '&copias=1', {
      headers: { Authorization: 'Bearer ' + token },
    });

    if (r.status !== 200) {
      prueba('el servidor sirve la hoja en formato ' + f.clave, () => {
        throw new Error('respondió ' + r.status);
      });
      continue;
    }

    let documento = await r.text();
    documento = documento.replace(/<script[\s\S]*?<\/script>/g, '');
    fs.writeFileSync(html, documento);

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--user-data-dir=' + path.join(SALIDA, 'perfil-' + f.clave),
      '--virtual-time-budget=6000',
      '--print-to-pdf=' + pdf,
      '--no-pdf-header-footer',
      'file:///' + html.replace(/\\/g, '/'),
    ];

    const rr = spawnSync(nav, args, { timeout: 90000, stdio: 'ignore' });

    if (!fs.existsSync(pdf)) {
      prueba('se generó el PDF en formato ' + f.clave, () => {
        throw new Error('Chrome no generó el archivo (código ' + rr.status + ')');
      });
      continue;
    }

    const buffer = fs.readFileSync(pdf);
    resultados.push({ formato: f, pdf, html, buffer, documento });
    console.log('  ' + f.nombre + ': ' + Math.round(buffer.length / 1024) + ' KB');
  }

  console.log('');
  console.log('  --- comprobaciones sobre las hojas ---');

  prueba('se generaron las hojas de los tres formatos', () => {
    esperar(resultados.length === 3, 'solo se generaron ' + resultados.length + ' de 3');
  });

  for (const r of resultados) {
    prueba('la hoja de "' + r.formato.clave + '" trae la regla @page', () => {
      esperar(/@page\s*\{[^}]*size:/.test(r.documento), 'no hay regla @page en el documento');
    });

    prueba('la hoja de "' + r.formato.clave + '" trae el gafete', () => {
      esperar(r.documento.indexOf('gafete__nombre') !== -1, 'no está el marcado del gafete');
      esperar(r.documento.indexOf(visita.nombre_completo) !== -1 ||
        r.documento.indexOf('gafete__nombre') !== -1, 'no aparece el nombre del visitante');
    });

    prueba('la hoja de "' + r.formato.clave + '" NO trae la aplicación alrededor', () => {
      /* Se cuentan ELEMENTOS, no texto: la hoja lleva la hoja de estilos
         incrustada, así que buscar "cabecera__titulo" a secas encontraba la
         regla de CSS y daba un falso positivo. */
      esperar(contarElementos(r.documento, 'barra') === 0, 'viene la barra lateral');
      esperar(contarElementos(r.documento, 'cabecera') === 0, 'viene la cabecera');
      esperar(contarElementos(r.documento, 'gafete-envoltura') === 0, 'viene la envoltura de la vista previa');
      esperar(contarElementos(r.documento, 'no-imprimir') === 0, 'viene el selector de formato');
    });

    prueba('la hoja de "' + r.formato.clave + '" trae UN gafete', () => {
      esperar(contarElementos(r.documento, 'gafete__nombre') === 1,
        'hay ' + contarElementos(r.documento, 'gafete__nombre') + ' gafetes');
    });

    /* Esta comprobación faltaba al principio, y el fallo que deja pasar es de
       los peores: el gafete salía en texto plano, sin una sola línea de diseño,
       y todas las demás pruebas seguían en verde porque el tamaño de página y
       el contenido eran correctos. Hay que comprobar que el DISEÑO viaja. */
    prueba('la hoja de "' + r.formato.clave + '" lleva el diseño incrustado', () => {
      esperar(r.documento.indexOf('.gafete__franja') !== -1, 'no viene el estilo del gafete');
      esperar(r.documento.indexOf('--gafete-marca') !== -1, 'no vienen los colores de la institución');
      // El gafete se dibuja con variables CSS; sin la hoja de estilos, el
      // marcado sale pero el color y la disposición no.
      esperar(r.documento.indexOf('.gafete {') !== -1 || r.documento.indexOf('.gafete{') !== -1,
        'no viene la regla base del gafete');
    });
  }

  console.log('');
  console.log('  --- comprobaciones sobre los PDF ---');

  for (const r of resultados) {
    const paginas = paginasDelPdf(r.buffer);
    const tam = tamanoPrimeraPagina(r.buffer);
    const esp = r.formato.esperado;

    prueba('el PDF de "' + r.formato.clave + '" tiene al menos una página', () => {
      esperar(paginas >= 1, 'tiene ' + paginas + ' páginas');
    });

    prueba('la página de "' + r.formato.clave + '" mide ' + esp.anchoMm + '×' + esp.altoMm + ' mm', () => {
      esperar(tam, 'no se pudo leer el tamaño de la página');
      // Dos milímetros de tolerancia: el PDF redondea a puntos.
      const okAncho = Math.abs(tam.anchoMm - esp.anchoMm) <= 2;
      const okAlto = Math.abs(tam.altoMm - esp.altoMm) <= 2;
      esperar(okAncho && okAlto, 'mide ' + tam.anchoMm + '×' + tam.altoMm + ' mm');
    });
  }

  /* Las copias: en A4 deben salir todas en la misma hoja; en la térmica, una
     página por etiqueta (que es lo que hace el controlador de la impresora). */
  const copiasPdf = path.join(SALIDA, 'gafete-copias.pdf');
  const copiasHtml = path.join(SALIDA, 'hoja-copias.html');
  const rCopias = await fetch(BASE + '/api/gafetes/visita/' + visita.id + '/hoja?formato=a4&copias=3', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (rCopias.status === 200) {
    let doc = await rCopias.text();
    doc = doc.replace(/<script[\s\S]*?<\/script>/g, '');
    fs.writeFileSync(copiasHtml, doc);
    spawnSync(nav, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--user-data-dir=' + path.join(SALIDA, 'perfil-copias'),
      '--virtual-time-budget=6000',
      '--print-to-pdf=' + copiasPdf,
      '--no-pdf-header-footer',
      'file:///' + copiasHtml.replace(/\\/g, '/'),
    ], { timeout: 90000, stdio: 'ignore' });

    if (fs.existsSync(copiasPdf)) {
      const marcador = contarElementos(doc, 'gafete__nombre');
      prueba('pedir 3 copias pone 3 gafetes en la hoja', () => {
        esperar(marcador === 3, 'hay ' + marcador + ' gafetes en el documento');
      });
    }
  }

  console.log('');
  console.log('  Las hojas y los PDF quedaron en ' + path.relative(RAIZ, SALIDA) + '.');
  console.log('');

  console.log('  ' + '='.repeat(64));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(64));
  if (fallos) {
    console.log('');
    for (const d of detalle) console.log('    ' + d);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
