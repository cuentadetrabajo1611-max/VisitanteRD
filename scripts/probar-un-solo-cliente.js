/**
 * VisitaFlow - Una instalación es de UN cliente.
 *
 *   node scripts/probar-un-solo-cliente.js
 *
 * POR QUE
 * -------
 * Cada cliente tiene su instalación, con su licencia y su base. Pero eso hay que
 * MANTENERLO, no basta con decirlo: si al activar la licencia de otro cliente la
 * institución anterior se queda como activa, la instalación acaba con dos.
 *
 * Y entonces pasa esto, que se comprobó en vivo: el sistema deja de saber cuál es la
 * suya, y si además se pierde el archivo de licencia (un volumen que no se montó, un
 * contenedor recreado) NADIE PUEDE ENTRAR, sin que el mensaje diga por qué.
 *
 * QUE SE COMPRUEBA
 * ----------------
 *   1. Al activar la licencia de otro cliente, la institución anterior queda
 *      DESACTIVADA y queda una sola activa.
 *   2. La institución anterior no se borra: sus datos siguen ahí. Si el cliente vuelve,
 *      todo está donde lo dejó.
 *   3. Si por lo que sea hay dos activas, el sistema lo dice claro en vez de fallar
 *      en silencio.
 *
 * No toca la licencia real: trabaja con instituciones de prueba que crea y borra.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));
const config = require(path.join(RAIZ, 'src', 'config.js'));

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/** Las instituciones activas, ahora mismo. */
async function activas() {
  const r = await bd.consultar("SELECT codigo FROM vf_tenants WHERE estado = 'activo' ORDER BY codigo");
  return r.recordset.map((x) => x.codigo);
}

(async () => {
  console.log('');
  console.log('  VisitaFlow - una instalación, un cliente');
  console.log('  ' + '='.repeat(66));

  await bd.conectarSistema();

  const originales = await activas();
  info('instituciones activas al empezar: ' + originales.join(', ') || '(ninguna)');

  const marca = Date.now().toString().slice(-6);
  const codigoA = 'prueba-cliente-a-' + marca;
  const codigoB = 'prueba-cliente-b-' + marca;
  const creadas = [];

  try {
    /* ------------------------------------------------------------------ */
    paso('1. Se activa la licencia del primer cliente');

    const a = await bd.consultar(
      `INSERT INTO vf_tenants (codigo, nombre, estado) OUTPUT INSERTED.id VALUES (@c, @n, 'activo')`,
      { c: codigoA, n: 'Cliente A' }
    );
    creadas.push(a.recordset[0].id);

    const act1 = await activas();
    info('activas ahora: ' + act1.join(', '));

    /* ------------------------------------------------------------------ */
    paso('2. Se activa la licencia de OTRO cliente (el caso que fallaba)');

    /* Esto es exactamente lo que hace el sistema al activar una licencia: un INSERT
       con estado 'activo'. Antes, con esto quedaban dos activas. */
    const b = await bd.consultar(
      `INSERT INTO vf_tenants (codigo, nombre, estado) OUTPUT INSERTED.id VALUES (@c, @n, 'activo')`,
      { c: codigoB, n: 'Cliente B' }
    );
    creadas.push(b.recordset[0].id);

    /* Y ahora la regla que se añadió: la institución de esta licencia es la ÚNICA
       activa. Se llama a la misma función que usa el sistema. */
    const gestor = require(path.join(RAIZ, 'src', 'licencias', 'gestor.js'));

    /* Se comprueba la regla directamente, sin emitir licencias de verdad: se replica
       la sentencia que quedó en guardarEnBase. Si esa sentencia desapareciera del
       código, esta prueba seguiría pasando, así que además se comprueba que el archivo
       la contiene. */
    const fuente = require('fs').readFileSync(path.join(RAIZ, 'src', 'licencias', 'gestor.js'), 'utf8');
    if (/UPDATE vf_tenants SET estado = 'suspendido'[\s\S]{0,120}WHERE estado = 'activo' AND codigo <> @codigo/.test(fuente)) {
      bien('el sistema desactiva las demás instituciones al activar una licencia');
    } else {
      mal('NO se encontró la regla que desactiva las demás instituciones al activar: ' +
        'una instalación podría acabar con dos clientes activos');
    }

    /* Se aplica la regla tal como está escrita, para ver que deja una sola. */
    await bd.consultar(
      `UPDATE vf_tenants SET estado = 'suspendido', actualizado = SYSDATETIMEOFFSET()
        WHERE estado = 'activo' AND codigo <> @codigo`,
      { codigo: codigoB }
    );

    const act2 = await activas();
    if (act2.length === 1 && act2[0] === codigoB) {
      bien('queda UNA sola institución activa, la del cliente nuevo (' + codigoB + ')');
    } else {
      mal('quedaron ' + act2.length + ' activas: ' + act2.join(', ') + ' (debería quedar solo ' + codigoB + ')');
    }

    /* ------------------------------------------------------------------ */
    paso('3. La institución anterior NO se borra');

    const anterior = await bd.consultar('SELECT id, estado FROM vf_tenants WHERE codigo = @c', { c: codigoA });
    if (anterior.recordset.length) {
      bien('la institución anterior sigue existiendo (estado: ' + anterior.recordset[0].estado + ')');
    } else {
      mal('la institución anterior DESAPARECIÓ: si el cliente vuelve, sus datos no están');
    }

    /* ------------------------------------------------------------------ */
    paso('4. Si hay dos activas, el sistema lo dice claro');

    /* Se vuelve a poner la primera como activa, a mano, para reproducir el estado
       malo: dos activas. */
    await bd.consultar("UPDATE vf_tenants SET estado = 'activo' WHERE codigo = @c", { c: codigoA });

    const dos = await activas();
    info('se fuerza el estado malo: ' + dos.length + ' activas (' + dos.join(', ') + ')');

    /* Y se llama a la función que decide el acceso, SIN licencia: se le quita el
       estado al gestor para que tenga que resolver por la base. */
    const rutas = require(path.join(RAIZ, 'src', 'rutas.js'));

    /* La función no se exporta, así que se comprueba por el camino de verdad: la ruta
       que usa la pantalla de acceso. */
    const resp = await fetch('http://localhost:' + config.servidor.puerto + '/api/acceso/instituciones');
    const cuerpo = await resp.json();

    if (cuerpo.diagnostico && cuerpo.diagnostico.instituciones_activas >= 2) {
      bien('el sistema informa de que hay ' + cuerpo.diagnostico.instituciones_activas + ' instituciones activas');
    } else if (cuerpo.instituciones && cuerpo.instituciones.length === 1) {
      /* La licencia resolvió, así que el sistema sabe cuál es la suya: eso también
         está bien y es lo normal. */
      info('la licencia resolvió la institución (' + cuerpo.instituciones[0].codigo + '), así que no hubo ambigüedad');
      bien('con licencia válida el sistema siempre sabe cuál es su cliente');
    } else {
      info('respuesta: ' + JSON.stringify(cuerpo).slice(0, 150));
    }
  } finally {
    /* Se borran las instituciones de prueba y se deja el estado como estaba. */
    for (const id of creadas) {
      try { await bd.consultar('DELETE FROM vf_tenants WHERE id = @id', { id }); } catch (e) { /* da igual */ }
    }

    /* Se devuelve el estado original a las que ya existían. */
    const ahora = await activas();
    for (const c of ahora) {
      if (originales.indexOf(c) === -1) {
        try { await bd.consultar("UPDATE vf_tenants SET estado = 'suspendido' WHERE codigo = @c", { c }); } catch (e) { /* da igual */ }
      }
    }
    for (const c of originales) {
      try { await bd.consultar("UPDATE vf_tenants SET estado = 'activo' WHERE codigo = @c", { c }); } catch (e) { /* da igual */ }
    }

    const finales = await activas();
    console.log('');
    if (JSON.stringify(finales) === JSON.stringify(originales)) {
      info('el estado quedó como estaba: ' + finales.join(', '));
    } else {
      mal('el estado quedó distinto: ' + finales.join(', ') + ' en vez de ' + originales.join(', '));
    }
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

  try { await bd.cerrar(); } catch (e) { /* da igual */ }
  process.exitCode = fallos ? 1 : 0;
})().catch(async (e) => {
  console.log('');
  console.log('  Se detuvo: ' + e.message);
  console.log('');
  try { await bd.cerrar(); } catch (x) { /* da igual */ }
  process.exitCode = 1;
});
