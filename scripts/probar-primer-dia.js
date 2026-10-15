/**
 * VisitaFlow - Lo que ve un cliente el PRIMER DIA.
 *
 *   node scripts/probar-primer-dia.js
 *
 * POR QUE
 * -------
 * Todo lo que se ha probado hasta ahora es una institucion CON datos: 90 visitas, 5
 * usuarios, catalogos ya tocados. Un cliente nuevo no tiene nada de eso.
 *
 * La primera impresion es cuando el cliente decide si el sistema le sirve. Si al entrar
 * se encuentra una pantalla vacia sin explicacion, o un grafico roto, o un error, no
 * llama para preguntar: concluye que el sistema no funciona.
 *
 * QUE SE COMPRUEBA
 * ----------------
 * Se crea una institucion de verdad, con lo que trae una recien instalada, y se recorre
 * como lo haria el cliente:
 *
 *   1. Entra con su correo y su clave.
 *   2. El panel carga SIN errores y explica que hacer, en vez de quedarse vacio.
 *   3. Las pantallas principales (registro, recepcion, reportes, configuracion) cargan
 *      sin caerse y sin numeros rotos.
 *   4. Un reporte sin datos no ensena "undefined" ni "NaN" por ningun lado.
 *   5. Se puede registrar la primera visita y sale su gafete.
 *
 * Al terminar borra la institucion de prueba entera.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const mantenimiento = require(path.join(RAIZ, 'src', 'mantenimiento.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

let token = null;

async function api(metodo, ruta, cuerpo, tok) {
  const cabeceras = { 'Content-Type': 'application/json' };
  const t = tok === undefined ? token : tok;
  if (t) cabeceras.Authorization = 'Bearer ' + t;

  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });

  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 300) }; }
  return { estado: r.status, datos, texto };
}

/** Busca valores rotos en cualquier respuesta: es lo que se ve como "undefined". */
function buscarRotos(objeto, ruta) {
  const rotos = [];
  const recorrer = (v, r) => {
    if (v === undefined) { rotos.push(r + ' = undefined'); return; }
    if (v === null) return;
    if (typeof v === 'number' && !Number.isFinite(v)) { rotos.push(r + ' = ' + v); return; }
    if (typeof v === 'string') {
      if (/^(undefined|NaN|null)$/.test(v.trim())) rotos.push(r + ' = "' + v + '"');
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => recorrer(x, r + '[' + i + ']')); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) recorrer(v[k], r ? r + '.' + k : k);
    }
  };
  recorrer(objeto, ruta || '');
  return rotos;
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - el primer día de un cliente nuevo');
  console.log('  ' + '='.repeat(66));

  /* ------------------------------------------------------------------ */
  paso('1. Se crea una institución nueva, como recién instalada');

  const marca = Date.now().toString().slice(-6);
  const codigo = 'prueba-dia-' + marca;
  const correo = 'admin@' + codigo + '.local';
  const clave = 'ClavePrimerDia123!';

  await bd.conectarSistema();

  /* El tenant lo crea el guardado de la licencia: aqui se hace lo mismo.
     OJO con el nombre de la columna: es `estado` ('activo' | 'suspendido'), no `activo`. */
  const alta = await bd.consultar(
    `INSERT INTO vf_tenants (codigo, nombre, estado, creado)
     OUTPUT INSERTED.id
     VALUES (@codigo, @nombre, 'activo', SYSDATETIMEOFFSET())`,
    { codigo, nombre: 'Institución de Prueba ' + marca }
  );
  const idTenant = alta.recordset[0].id;
  bien('institución creada (id ' + idTenant + ')');

  let idVisita = null;

  try {
    /* Lo que se siembra en una instalacion nueva, ni mas ni menos. */
    const resumen = await mantenimiento.prepararTenant(idTenant, {
      correo,
      clave,
      nombre: 'Administrador de Prueba',
      sembrarCatalogos: true,
    });

    info('se sembró: ' + resumen.permisos + ' permisos, ' + resumen.ajustes + ' ajustes, ' +
      resumen.departamentos + ' departamentos, ' + resumen.motivos + ' motivos, ' +
      resumen.categorias + ' categorías, ' + resumen.sedes + ' sedes, ' +
      (resumen.plantilla ? '1 plantilla de gafete' : 'SIN plantilla de gafete'));

    if (resumen.plantilla) bien('trae plantilla de gafete (sin ella no se puede imprimir nada)');
    else mal('no trae plantilla de gafete: el cliente no podría imprimir ni un gafete');

    if (resumen.motivos >= 3) bien('trae motivos de visita listos para usar');
    else mal('trae muy pocos motivos (' + resumen.motivos + '): habría que crearlos a mano');

    if (resumen.departamentos >= 1) bien('trae departamentos');
    else mal('no trae ningún departamento');

    /* ------------------------------------------------------------------ */
    paso('2. El cliente entra con su correo y su clave');

    /* Se manda la institución explícita.
     *
     * En una instalación de verdad no hace falta: el sistema la saca de su propia
     * licencia, y por eso el recepcionista solo escribe correo y clave. Aquí hay que
     * mandarla porque esta máquina tiene la licencia de OTRA institución, y sin esto el
     * sistema buscaría el usuario en la institución equivocada. */
    const sesion = await api('POST', '/api/acceso/entrar', { correo, clave, tenant: codigo }, null);
    if (sesion.estado !== 200) {
      throw new Error('no pudo entrar (estado ' + sesion.estado + '): ' +
        (sesion.datos.mensaje || sesion.datos.motivo || ''));
    }
    token = sesion.datos.token;
    bien('entra sin problemas, con ' + (sesion.datos.permisos || []).length + ' permisos');

    /* ------------------------------------------------------------------ */
    paso('3. El panel de inicio, sin datos');

    const panel = await api('GET', '/api/panel');
    if (panel.estado !== 200) {
      mal('el panel no cargó (estado ' + panel.estado + '): es lo primero que ve el cliente');
    } else {
      bien('el panel carga');
      const rotos = buscarRotos(panel.datos, 'panel');
      if (!rotos.length) {
        bien('sin valores rotos en el panel');
      } else {
        mal('el panel trae ' + rotos.length + ' valor(es) roto(s) que se verían raros: ' + rotos.slice(0, 3).join(', '));
      }
    }

    /* ------------------------------------------------------------------ */
    paso('4. Las pantallas principales, todas, con la institución vacía');

    const pantallas = [
      ['GET', '/api/visitas?estado=dentro', 'Recepción (los que están dentro)'],
      ['GET', '/api/visitas', 'la bitácora de visitas'],
      ['GET', '/api/registro/buscar?q=00100000017', 'buscar una cédula'],
      ['GET', '/api/config', 'Configuración'],
      ['GET', '/api/personalizacion', 'Personalización'],
      ['GET', '/api/reportes/resumen', 'Reportes'],
      ['GET', '/api/usuarios', 'Usuarios'],
      ['GET', '/api/preregistros', 'Visitas anunciadas'],
      ['GET', '/api/vigilancia', 'Vigilancia'],
      ['GET', '/api/licencia', 'Licencia'],
      ['GET', '/api/auditoria', 'Auditoría'],
      ['GET', '/api/gafetes/pendientes', 'Gafetes pendientes'],
    ];

    for (const [metodo, ruta, nombre] of pantallas) {
      const r = await api(metodo, ruta);

      if (r.estado !== 200) {
        mal(nombre + ' no carga (estado ' + r.estado + '): ' +
          String(r.datos.mensaje || r.datos.motivo || r.texto || '').slice(0, 70));
        continue;
      }

      const rotos = buscarRotos(r.datos, nombre);
      if (rotos.length) {
        mal(nombre + ' trae valores rotos: ' + rotos.slice(0, 3).join(', '));
      } else {
        bien(nombre + ' carga sin valores rotos');
      }
    }

    /* ------------------------------------------------------------------ */
    paso('5. Un reporte sin visitas no puede enseñar números inventados');

    const rep = await api('GET', '/api/reportes/resumen');
    if (rep.estado === 200) {
      const m = (rep.datos.reporte || rep.datos).metricas || {};
      if (m.visitas === 0) {
        bien('el reporte dice 0 visitas, que es la verdad');
      } else {
        mal('una institución sin visitas reporta ' + m.visitas + ' visitas');
      }
      if (typeof m.promedio_diario === 'number' && Number.isFinite(m.promedio_diario)) {
        bien('el promedio diario es un número válido (' + m.promedio_diario + ')');
      } else {
        mal('el promedio diario sale como "' + m.promedio_diario + '": se vería NaN en pantalla');
      }
    }

    /* ------------------------------------------------------------------ */
    paso('6. La primera visita de su vida, y su gafete');

    const cfg = await api('GET', '/api/config');
    const c = cfg.datos.config || cfg.datos;
    const motivos = c.motivos || [];

    if (!motivos.length) {
      mal('sin motivos no se puede registrar la primera visita');
    } else {
      const entrada = await api('POST', '/api/registro', {
        cedula: '00100000017',
        motivo_id: motivos[0].id,
        visitado: 'El encargado',
      });

      if (entrada.estado === 200 || entrada.estado === 201) {
        bien('la primera visita se registra');
        idVisita = entrada.datos.visita ? entrada.datos.visita.id : null;

        /* El gafete: es lo que se le entrega al visitante.
         *
         * Los dibujos vienen anidados en `codigos` (qr_svg y barras_svg), y se generan
         * en el servidor y no en el navegador. Buscarlos en la raíz del objeto daba un
         * falso "no trae dibujo", que es justo lo contrario de lo que pasa. */
        if (idVisita) {
          const gaf = await api('GET', '/api/gafetes/visita/' + idVisita);
          if (gaf.estado === 200) {
            const g = gaf.datos.gafete || {};
            const codigos = g.codigos || {};
            const qr = codigos.qr_svg;
            const barras = codigos.barras_svg;

            if (qr && /^\s*<svg/i.test(String(qr))) {
              bien('el gafete sale con su código QR dibujado (' + String(qr).length + ' caracteres de SVG)');
            } else {
              mal('el gafete no trae el dibujo del código: no se podría escanear');
            }

            /* El nombre de la institución y el del visitante tienen que estar. */
            if (g.nombre) bien('el gafete lleva el nombre del visitante');
            else mal('el gafete no lleva el nombre del visitante');

            if (g.institucion && g.institucion.nombre) {
              bien('y el nombre de la institución (' + g.institucion.nombre + ')');
            } else {
              mal('el gafete no lleva el nombre de la institución');
            }

            /* La plantilla por defecto trae el QR; el código de barras es opcional. */
            const p = g.plantilla || {};
            if (barras) info('y también código de barras');
            else info('sin código de barras (la plantilla "' + (p.nombre || '—') + '" no lo pide: es opcional)');
          } else {
            mal('el gafete no se pudo generar (estado ' + gaf.estado + '): ' +
              String(gaf.datos.mensaje || gaf.datos.motivo || '').slice(0, 70));
          }
        }
      } else {
        mal('LA PRIMERA VISITA NO SE PUDO REGISTRAR (estado ' + entrada.estado + '): ' +
          String(entrada.datos.mensaje || entrada.datos.motivo || '').slice(0, 80));
      }
    }
  } finally {
    /* ------------------------------------------------------------------ */
    /* Se borra la institución entera: no puede quedar en la base del cliente. */
    if (idVisita) {
      try { await api('POST', '/api/visitas/' + idVisita + '/salida', {}); } catch (e) { /* da igual */ }
    }

    const tablas = [
      'vf_vigilancia_avisos', 'vf_vigilancia', 'vf_preregistros', 'vf_avisos', 'vf_movimientos',
      'vf_gafetes', 'vf_visitas', 'vf_visitantes', 'vf_auditoria', 'vf_rol_permisos',
      'vf_ajustes', 'vf_usuarios', 'vf_categorias', 'vf_motivos', 'vf_departamentos',
      'vf_sedes', 'vf_plantillas_gafete',
    ];

    let borradas = 0;
    for (const t of tablas) {
      try {
        const r = await bd.consultar('DELETE FROM ' + t + ' WHERE tenant_id = @t', { t: idTenant });
        borradas += r.rowsAffected[0] || 0;
      } catch (e) { /* la tabla puede no existir o tener otra forma: se sigue */ }
    }

    try {
      await bd.consultar('DELETE FROM vf_tenants WHERE id = @t', { t: idTenant });
      info('institución de prueba borrada (' + borradas + ' filas)');
    } catch (e) {
      mal('no se pudo borrar la institución de prueba: ' + e.message);
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
}

/* El interprete de Python no hace falta aqui, pero el modulo lo exige al cargarse. */
principal().catch(async (e) => {
  console.log('');
  console.log('  Se detuvo: ' + e.message);
  console.log('');
  try { await bd.cerrar(); } catch (x) { /* da igual */ }
  process.exitCode = 1;
});
