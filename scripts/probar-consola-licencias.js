/**
 * VisitaFlow - La consola del servidor de licencias.
 *
 *   node scripts/probar-consola-licencias.js
 *
 * POR QUE
 * -------
 * La consola es lo unico que ve el dueno del sistema para saber como esta cada cliente:
 * quien puede operar, hasta cuando, y que modulos tiene. Si un dato de ahi engana o no
 * se entiende, la decision se toma mal.
 *
 * Lo que se comprueba es la tabla, que es donde esta el riesgo:
 *
 *   - que cada institucion salga con su situacion
 *   - que la columna de modulos diga QUE LE FALTA a cada cliente, y no los dos primeros
 *     por orden alfabetico. Con "8 de 10", ensenar "api, gafetes…" es igual para todos y
 *     no deja ver en que se diferencian sin abrirlos uno por uno.
 *   - que una licencia completa se distinga de una a la que le falta algo
 *   - que las cuentas de arriba (vigentes, por vencer, vencidas) cuadren con la lista
 *   - que sin token no se vea NADA: es la lista de clientes del negocio
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const BASE = 'http://localhost:' + (process.env.PUERTO_LICENCIAS || 4100);

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/** Busca el ejecutable de Chrome que usa el resto del proyecto. */
function chrome() {
  const candidatos = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_BIN,
  ].filter(Boolean);
  for (const c of candidatos) if (fs.existsSync(c)) return c;
  return null;
}

(async () => {
  console.log('');
  console.log('  VisitaFlow - la consola del servidor de licencias');
  console.log('  ' + '='.repeat(66));

  /* ------------------------------------------------------------------ */
  paso('1. El servidor de licencias responde');

  let salud;
  try {
    const r = await fetch(BASE + '/api/salud');
    salud = await r.json();
    bien('responde (estado ' + r.status + ')');
  } catch (e) {
    console.log('');
    console.log('  El servidor de licencias no está corriendo en ' + BASE + '.');
    console.log('  Arránquelo con:  npm run licencias');
    console.log('');
    process.exitCode = 1;
    return;
  }

  /* ------------------------------------------------------------------ */
  paso('2. La lista de clientes, que es lo que ve el dueño');

  /* La consola se autentica con el token de administracion, en una cabecera Bearer. */
  const token = (process.env.ADMIN_TOKEN || '').trim();
  if (!token) {
    mal('no hay ADMIN_TOKEN: no se puede pedir la lista');
    return;
  }

  const resp = await fetch(BASE + '/api/admin/clientes', { headers: { Authorization: 'Bearer ' + token } });
  if (resp.status !== 200) {
    mal('la lista no respondió (estado ' + resp.status + ')');
    return;
  }

  const datos = await resp.json();
  const clientes = datos.clientes || datos.licencias || [];
  const disponibles = datos.modulos_disponibles || [];

  bien(clientes.length + ' institución(es) con licencia');
  if (disponibles.length) info('módulos que existen: ' + disponibles.length + ' (' + disponibles.join(', ') + ')');
  else mal('el servidor no dice qué módulos existen: la consola no puede calcular qué falta');

  /* Las cuentas de arriba. */
  const vigentes = clientes.filter((c) => c.dias_restantes > 0 && c.activa !== false).length;
  const vencidas = clientes.filter((c) => c.dias_restantes <= 0).length;
  const porVencer = clientes.filter((c) => c.dias_restantes > 0 && c.dias_restantes <= 30).length;

  if (vigentes + vencidas >= clientes.length - 0) {
    bien('las cuentas cuadran: ' + vigentes + ' vigentes, ' + porVencer + ' por vencer, ' + vencidas + ' vencidas');
  } else {
    mal('las cuentas no cuadran con la lista');
  }

  /* ------------------------------------------------------------------ */
  paso('3. Que la tabla diga qué le falta a cada cliente');

  /* Se replica lo que hace la consola, y se comprueba que el resultado sea DISTINTO
     entre clientes con el mismo número de módulos: si dos clientes con 8 de 10 se ven
     iguales, la columna no sirve. */
  const resumen = (activos) => {
    const faltan = disponibles.filter((m) => activos.indexOf(m) === -1);
    if (!faltan.length) return 'completa';
    if (faltan.length <= 2) return 'sin ' + faltan.join(', ');
    if (activos.length && activos.length <= 3) return activos.join(', ');
    return 'sin ' + faltan.length + ' módulos';
  };

  const vistos = {};
  for (const c of clientes) {
    const activos = c.modulos || [];
    const texto = resumen(activos);
    const clave = activos.length + ':' + texto;
    const antes = (activos.slice(0, 2).join(', ') || 'ninguno') + (activos.length > 2 ? '…' : '');

    info(c.tenant.padEnd(20) + activos.length + ' de ' + disponibles.length + '   antes: ' +
      antes.padEnd(28) + '  ahora: ' + texto);

    /* Dos instituciones con la misma cantidad de módulos NO pueden mostrar el mismo
       texto si tienen módulos distintos. */
    const mismaCantidad = Object.keys(vistos).find((k) => k.split(':')[0] === String(activos.length));
    if (mismaCantidad && vistos[mismaCantidad] === texto && activos.length < disponibles.length) {
      mal('"' + c.tenant + '" y "' + vistos[mismaCantidad + ':quien'] +
        '" tienen ' + activos.length + ' módulos distintos y la tabla los muestra igual ("' + texto + '")');
    }
    vistos[clave] = texto;
    vistos[activos.length + ':quien'] = c.tenant;

    if (activos.length === disponibles.length && texto !== 'completa') {
      mal('"' + c.tenant + '" tiene todos los módulos y la tabla no lo dice claro: "' + texto + '"');
    }
    if (activos.length < disponibles.length && texto === 'completa') {
      mal('"' + c.tenant + '" NO tiene todos los módulos y la tabla dice "completa"');
    }
  }

  const algunCompleto = clientes.some((c) => (c.modulos || []).length === disponibles.length);
  if (algunCompleto) bien('una licencia completa se distingue de las demás');
  else info('ninguna licencia tiene todos los módulos: no se pudo comprobar ese caso');

  /* ------------------------------------------------------------------ */
  paso('4. Que la consola se pinte de verdad en un navegador');

  const chromeBin = chrome();
  if (!chromeBin) {
    info('no hay Chrome en esta máquina: no se comprueba el pintado');
  } else {
    const perfil = path.join(os.tmpdir(), 'vf-consola-' + Date.now());
    fs.mkdirSync(perfil, { recursive: true });

    const salida = spawnSync(chromeBin, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--user-data-dir=' + perfil,
      '--virtual-time-budget=6000',
      '--dump-dom',
      BASE + '/?t=' + encodeURIComponent(token),
    ], { encoding: 'utf8', timeout: 90000 });

    const dom = salida.stdout || '';

    if (!dom.length) {
      info('Chrome no devolvió el contenido de la página');
    } else {
      /* La tabla tiene que estar, con las instituciones dentro. */
      if (/<table/.test(dom)) bien('la tabla se pinta');
      else mal('la tabla NO se pintó: la consola quedaría vacía');

      const faltantes = clientes.filter((c) => dom.indexOf(c.tenant) === -1);
      if (!faltantes.length) bien('las ' + clientes.length + ' instituciones salen en la página');
      else mal('no salen en la página: ' + faltantes.map((c) => c.tenant).join(', '));

      /* Y el resumen nuevo tiene que estar en el HTML. */
      const conResumen = clientes.filter((c) => {
        const t = resumen(c.modulos || []);
        return dom.indexOf(t) !== -1;
      });
      if (conResumen.length === clientes.length) {
        bien('la columna de módulos muestra el resumen de cada una');
      } else {
        mal('el resumen de módulos no aparece en la página (' + conResumen.length + ' de ' + clientes.length + ')');
      }

      if (/is not defined|Uncaught/.test(dom)) mal('la página tiene un error de JavaScript');
      else bien('sin errores de JavaScript en la página');
    }

    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* da igual */ }
  }

  /* ------------------------------------------------------------------ */
  paso('5. Que sin token no se vea nada');

  const sinToken = await fetch(BASE + '/api/admin/clientes');
  if (sinToken.status === 401 || sinToken.status === 403) {
    bien('sin token no se puede ver la lista (estado ' + sinToken.status + ')');
  } else {
    mal('LA LISTA DE CLIENTES ESTÁ AL AIRE sin token (estado ' + sinToken.status + ')');
  }

  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(66));
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  process.exitCode = fallos ? 1 : 0;
})().catch((e) => {
  console.log('');
  console.log('  Se detuvo: ' + e.message);
  console.log('');
  process.exitCode = 1;
});
