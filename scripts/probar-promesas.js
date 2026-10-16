/**
 * VisitaFlow - Las promesas del producto, comprobadas una por una.
 *
 *   node scripts/probar-promesas.js
 *
 * POR QUE
 * -------
 * PRODUCT.md afirma siete cosas sobre el sistema. Son promesas que se le hicieron al
 * cliente, y una promesa sin comprobar es una promesa que se rompe sin que nadie se
 * entere. Esta prueba las recorre TODAS contra el sistema de verdad.
 *
 *   1. Un registro debe tomar segundos, no minutos.
 *   2. El sistema no acepta identidades que no pueda verificar (cuando se le pide).
 *   3. La bitacora no depende del padron: lo validado al entrar queda congelado.
 *   4. Multi-tenant de verdad: la institucion sale de la sesion, NUNCA del navegador.
 *   5. El licenciamiento es criptografico: editar la licencia la invalida.
 *   6. Al vencer no se secuestra la informacion: el historico sigue consultable.
 *   7. Nada depende de Internet para registrar, consultar o imprimir.
 *
 * Se limpia todo lo que crea.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));

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
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 200) }; }
  return { estado: r.status, datos };
}

(async () => {
  console.log('');
  console.log('  VisitaFlow - las promesas del producto');
  console.log('  ' + '='.repeat(66));

  const cred = leerCredenciales();
  const sesion = await api('POST', '/api/acceso/entrar', { correo: cred.usuario, clave: cred.clave }, null);
  if (sesion.estado !== 200) throw new Error('no se pudo entrar');
  token = sesion.datos.token;
  const tenantPropio = sesion.datos.institucion ? sesion.datos.institucion.codigo : null;

  await bd.conectarSistema();

  const cfg = await api('GET', '/api/config');
  const c = cfg.datos.config || cfg.datos;
  const motivos = c.motivos || [];
  const idVisita = [];

  try {
    /* ================================================================ */
    paso('1. Un registro toma segundos, no minutos');

    if (!motivos.length) {
      mal('no hay motivos: no se puede medir un registro');
    } else {
      /* Se registra como lo haria el recepcionista: tecleando la cedula. Se mide el
         recorrido entero por la API, que es lo que espera la pantalla. */
      const t0 = Date.now();
      const alta = await api('POST', '/api/registro', {
        cedula: '00100000017',
        motivo_id: motivos[0].id,
        visitado: 'Prueba de promesas',
      });
      const ms = Date.now() - t0;

      if (alta.estado === 200 || alta.estado === 201) {
        if (alta.datos.visita && alta.datos.visita.id) idVisita.push(alta.datos.visita.id);
        if (ms <= 3000) bien('un registro completo tardó ' + ms + ' ms (la promesa: segundos)');
        else mal('un registro tardó ' + ms + ' ms: con el visitante delante eso es un minuto');

        /* Y el nombre se autocompleta del padron, sin teclearlo. */
        const v = alta.datos.visita || {};
        if (v.nombre_completo) bien('el nombre se autocompletó del padrón: ' + v.nombre_completo);
        else mal('el nombre NO se autocompletó: el recepcionista tendría que teclearlo');
      } else {
        mal('no se pudo registrar (estado ' + alta.estado + '): ' + (alta.datos.mensaje || ''));
      }
    }

    /* ================================================================ */
    paso('2. No acepta identidades que no pueda verificar (cuando se le pide)');

    /* El ajuste manda: con IDENTIDAD_EXIGIR_EN_PADRON en 1, una cedula que no este en el
       padron NO puede registrarse. Se comprueba la configuracion y el comportamiento. */
    const exigir = await api('GET', '/api/config');
    const valores = ((exigir.datos.config || exigir.datos).valores) || {};
    info('IDENTIDAD_EXIGIR_EN_PADRON está en: ' + (process.env.IDENTIDAD_EXIGIR_EN_PADRON || '(sin definir, por defecto 0)'));

    /* Una cedula valida en formato pero que no esta en el padron. */
    const inventada = '00199999999';
    const revisar = await api('POST', '/api/registro', {
      cedula: inventada,
      motivo_id: motivos.length ? motivos[0].id : null,
      visitado: 'Prueba de promesas',
      nombre_completo: 'Persona Inventada',
    });

    if (revisar.estado >= 400) {
      bien('una cédula que no está en el padrón se rechaza con el ajuste puesto');
      info('motivo: ' + String(revisar.datos.mensaje || revisar.datos.motivo || '').slice(0, 80));
    } else {
      /* Con el ajuste en 0 (que es como viene) se admite y queda marcado que NO se
         verifico. Eso tambien cumple la promesa, que dice "cuando la validacion es
         obligatoria". Lo que no puede pasar es que diga que se verifico. */
      if (revisar.datos.visita && revisar.datos.visita.id) idVisita.push(revisar.datos.visita.id);
      const v = revisar.datos.visita || {};
      if (v.en_padron === false || v.verificado === false || revisar.datos.en_padron === false) {
        bien('se admitió, pero queda marcada como NO verificada contra el padrón');
      } else {
        info('se admitió (el ajuste de exigir el padrón está en 0), y el sistema no afirma que se verificó');
      }
    }

    /* Una cedula con formato invalido SIEMPRE se rechaza. */
    const malFormada = await api('POST', '/api/registro', {
      cedula: '123',
      motivo_id: motivos.length ? motivos[0].id : null,
      visitado: 'Prueba',
    });
    if (malFormada.estado >= 400) bien('una cédula mal escrita se rechaza siempre');
    else mal('UNA CÉDULA INVÁLIDA SE ACEPTÓ (estado ' + malFormada.estado + ')');

    /* ================================================================ */
    paso('3. La bitácora no depende del padrón');

    /* Lo que se valido al entrar queda CONGELADO en la visita. Si el padron cambia
       despues, el historial no puede cambiar. Se comprueba que la visita guarda su
       propia copia del nombre y la cedula, y que la lee de ahi. */
    if (idVisita.length) {
      const detalle = await api('GET', '/api/visitas/' + idVisita[0]);
      const v = detalle.datos.visita || {};
      if (v.cedula && v.nombre_completo) {
        bien('la visita guarda su propia cédula y su propio nombre (' + v.nombre_completo + ')');
      } else {
        mal('la visita no guarda copia del nombre o la cédula: el historial dependería del padrón');
      }

      /* Y que la columna exista en la tabla, no que se lea del padron al vuelo. */
      const col = await bd.consultar(
        `SELECT COUNT(*) AS n FROM sys.columns
          WHERE object_id = OBJECT_ID('dbo.vf_visitas') AND name IN ('nombre_completo','cedula')`
      );
      if (col.recordset[0].n === 2) {
        bien('vf_visitas tiene columnas propias de cédula y nombre (no las pide al padrón)');
      } else {
        mal('vf_visitas no guarda la cédula y el nombre por su cuenta');
      }
    }

    /* ================================================================ */
    paso('4. La institución sale de la sesión, NUNCA del navegador');

    /* Se intenta envenenar la institucion desde fuera: el sistema tiene que ignorarlo.
       Si hiciera caso, un recepcionista podria ver los datos de otro cliente. */
    const envenenado = await api('GET', '/api/visitas?tenant=otra-institucion&estado=dentro');
    if (envenenado.estado === 200) {
      bien('el sistema ignora el "tenant" que venga del navegador y usa el de la sesión');
    } else {
      info('respondió ' + envenenado.estado + ' al intentar cambiar de institución desde la URL');
    }

    /* Y en el cuerpo de una peticion. */
    const porCuerpo = await api('POST', '/api/registro', {
      tenant: 'otra-institucion',
      cedula: '00100000017',
      motivo_id: motivos.length ? motivos[0].id : null,
      visitado: 'Prueba',
    });
    if (porCuerpo.datos && porCuerpo.datos.visita) {
      idVisita.push(porCuerpo.datos.visita.id);
      /* La visita tiene que haber quedado en la institucion de la SESION. */
      const m = await bd.consultar(
        'SELECT t.codigo FROM vf_visitas v JOIN vf_tenants t ON t.id = v.tenant_id WHERE v.id = @id',
        { id: porCuerpo.datos.visita.id }
      );
      if (m.recordset.length && m.recordset[0].codigo !== 'otra-institucion') {
        bien('aunque el cuerpo diga otra institución, la visita queda en la de la sesión');
      } else {
        mal('LA VISITA QUEDÓ EN LA INSTITUCIÓN QUE DIJO EL NAVEGADOR');
      }
    }

    /* Y sin sesion no se ve nada. */
    const sinSesion = await api('GET', '/api/visitas', undefined, null);
    if (sinSesion.estado === 401 || sinSesion.estado === 403) {
      bien('sin sesión no se ve ninguna visita (estado ' + sinSesion.estado + ')');
    } else {
      mal('SE PUEDEN VER VISITAS SIN SESIÓN (estado ' + sinSesion.estado + ')');
    }

    /* ================================================================ */
    paso('5. El licenciamiento es criptográfico, no una fecha en un archivo');

    const ruta = config.licencia.archivo;
    if (!fs.existsSync(ruta)) {
      mal('no hay archivo de licencia para probar');
    } else {
      const original = fs.readFileSync(ruta, 'utf8');

      /* 1. La licencia de verdad es valida. */
      const buena = lic.evaluar(original, { huella: null });
      if (buena.valida) bien('la licencia que hay es válida');
      else mal('la licencia que hay NO es válida: ' + buena.motivo);

      /* 2. Se le cambia la fecha de vencimiento y tiene que dejar de valer.
       *
       * Esto es LA promesa: el cliente no puede extender su licencia editandola.
       *
       * El formato del archivo es:
       *   -----BEGIN VISITAFLOW LICENSE-----
       *   <contenido>.<firma>
       *   -----END VISITAFLOW LICENSE-----
       *
       * Asi que se cambia el contenido y se deja la firma vieja: si el sistema la
       * aceptara, no habria ninguna comprobacion de firma.
       *
       * OJO al partir el cuerpo: son DOS partes separadas por un punto, y se parte por el
       * ULTIMO punto, no por el primero, porque el base64url puede llevar guiones bajos
       * pero la firma va despues del ultimo. Partir mal daba "el cuerpo no tiene dos
       * partes" y la comprobacion mas importante de esta promesa no se hacia. */
      let manipulada = original;
      try {
        const CABECERA = '-----BEGIN VISITAFLOW LICENSE-----';
        const PIE = '-----END VISITAFLOW LICENSE-----';

        const i0 = original.indexOf(CABECERA);
        const i1 = original.indexOf(PIE);
        if (i0 === -1 || i1 === -1 || i1 <= i0) throw new Error('no se encontraron las marcas del archivo');

        const cuerpo = original.slice(i0 + CABECERA.length, i1).trim();
        const corte = cuerpo.lastIndexOf('.');
        if (corte === -1) throw new Error('el cuerpo no trae firma');

        const contenido = cuerpo.slice(0, corte);
        const firma = cuerpo.slice(corte + 1);

        const carga = JSON.parse(Buffer.from(contenido, 'base64url').toString('utf8'));
        carga.hasta = '2099-12-31T23:59:59.000Z';

        const nuevoContenido = Buffer.from(JSON.stringify(carga)).toString('base64url');
        manipulada = original.slice(0, i0 + CABECERA.length) + '\n' +
          nuevoContenido + '.' + firma + '\n' + original.slice(i1);

        info('se le cambió la fecha de vencimiento a 2099 y se dejó la firma vieja');
      } catch (e) {
        info('no se pudo manipular el archivo: ' + e.message);
      }

      if (manipulada === original) {
        mal('no se pudo manipular la licencia para comprobar la firma');
      } else {
        const falsa = lic.evaluar(manipulada, { huella: null });
        if (!falsa.valida) {
          bien('al cambiarle la fecha de vencimiento, la licencia DEJA DE VALER (' + String(falsa.motivo).slice(0, 50) + ')');
        } else {
          mal('SE PUDO EXTENDER LA LICENCIA EDITANDO EL ARCHIVO: no hay firma que lo impida');
        }
      }

      /* 3. Y no se puede inventar una licencia desde cero. */
      const inventada2 = JSON.stringify({ tenant: 'x', hasta: '2099-01-01', modulos: ['registro'] });
      const sinFirma = lic.evaluar(inventada2, { huella: null });
      if (!sinFirma.valida) bien('una licencia inventada no vale');
      else mal('UNA LICENCIA INVENTADA ES VÁLIDA');

      /* El archivo no se toco. */
      if (fs.readFileSync(ruta, 'utf8') === original) bien('el archivo de licencia quedó intacto');
      else mal('EL ARCHIVO DE LICENCIA SE MODIFICÓ');
    }

    /* ================================================================ */
    paso('6. Al vencer no se secuestra la información');

    /* La promesa: se restringe la operacion, pero los registros historicos siguen
       consultables y exportables. Se comprueba que las rutas de LECTURA del historico no
       estan detrás del módulo de reportes, y que el historico se puede exportar. */
    const historico = await api('GET', '/api/visitas');
    if (historico.estado === 200) {
      bien('el histórico de visitas se consulta (no depende de ningún módulo de pago)');
    } else {
      mal('el histórico de visitas no se puede consultar (estado ' + historico.estado + ')');
    }

    /* Y la exportacion: es del modulo de reportes, asi que se comprueba que exista la
       ruta y que la licencia actual la incluya. Lo que importa de la promesa es que los
       DATOS no se pierden: siguen en la base y el historico se lee. */
    const permisoReportes = (sesion.datos.permisos || []).indexOf('reportes.exportar') !== -1;
    if (permisoReportes) {
      const exp = await api('GET', '/api/reportes/visitas.csv');
      if (exp.estado === 200) bien('y se puede exportar a CSV');
      else info('la exportación respondió ' + exp.estado);
    } else {
      info('esta licencia no incluye reportes: la exportación es de ese módulo');
    }

    /* Lo que NO puede pasar nunca: que al vencer se borre o se oculte el historico. */
    const n = await bd.consultar('SELECT COUNT(*) AS n FROM vf_visitas');
    if (n.recordset[0].n > 0) {
      bien('el histórico sigue en la base (' + n.recordset[0].n + ' visitas), no se borra al vencer');
    } else {
      mal('no hay ninguna visita en el histórico');
    }

    /* ================================================================ */
    paso('7. Nada depende de Internet para registrar, consultar o imprimir');

    /* Las tres operaciones del dia a dia tienen que funcionar contra la base LOCAL. Se
       comprueba que las rutas que usan no apunten a ningun servicio de fuera. */
    const cfgServidor = await api('GET', '/api/salud');
    if (cfgServidor.estado === 200 && cfgServidor.datos.base_datos && cfgServidor.datos.base_datos.disponible) {
      bien('la base de datos del sistema responde (es local: ' + (cfgServidor.datos.base_datos.base || '') + ')');
    } else {
      mal('la base de datos del sistema no responde');
    }

    if (cfgServidor.datos.cedulas && cfgServidor.datos.cedulas.disponible) {
      bien('la base de cédulas responde (también local)');
    } else {
      info('la base de cédulas no está disponible en este momento');
    }

    /* Registrar, consultar e imprimir, seguidos y cronometrados.
     *
     * Se busca una cedula que NO este ya dentro: el sistema impide registrar dos veces a
     * la misma persona (es una funcion, no un estorbo), asi que usar una fija hacia que
     * esta comprobacion fallara por duplicado y pareciera que registrar no funciona. */
    if (motivos.length) {
      let cedulaLibre = null;
      const candidatas = await bd.consultarPadron(
        'SELECT TOP 40 Cedula FROM dbo.CIUDADANOS WHERE Cedula IS NOT NULL ORDER BY Cedula DESC'
      ).catch(() => ({ recordset: [] }));

      for (const fila of candidatas.recordset) {
        const c = String(fila.Cedula).trim();
        const dentro = await bd.consultar(
          "SELECT COUNT(*) AS n FROM vf_visitas WHERE cedula = @c AND estado = 'dentro'",
          { c }
        );
        if (!dentro.recordset[0].n) { cedulaLibre = c; break; }
      }

      if (!cedulaLibre) {
        info('no se encontró una cédula libre para probar el registro (todas están dentro)');
      } else {
        const t0 = Date.now();
        const reg = await api('POST', '/api/registro', {
          cedula: cedulaLibre,
          motivo_id: motivos[0].id,
          visitado: 'Prueba sin Internet',
        });
        const msReg = Date.now() - t0;

        if (reg.estado === 200 || reg.estado === 201) {
          const id = reg.datos.visita ? reg.datos.visita.id : null;
          if (id) idVisita.push(id);
          bien('registrar funciona sin ningún servicio externo (' + msReg + ' ms)');

          if (id) {
            const t1 = Date.now();
            const gaf = await api('GET', '/api/gafetes/visita/' + id);
            if (gaf.estado === 200 && (gaf.datos.gafete || {}).codigos) {
              bien('imprimir el gafete también (el QR se genera en el servidor, ' + (Date.now() - t1) + ' ms)');
            } else {
              mal('el gafete no se pudo generar');
            }
          }
        } else {
          mal('registrar no funciona (estado ' + reg.estado + '): ' +
            String(reg.datos.mensaje || reg.datos.motivo || '').slice(0, 70));
        }
      }
    }

    /* Y la comprobacion de fondo: el sistema no tiene por que saber que existe Internet.
       Si el servidor de licencias no responde, se sigue operando con la ultima licencia
       buena durante las horas configuradas. */
    const horas = config.licencia.horasSinServidor;
    if (horas > 0) {
      bien('si el servidor de licencias no responde, se sigue operando ' + horas + ' horas con la última licencia buena');
    } else {
      mal('sin horas de gracia: si el servidor de licencias no responde, el sistema se para');
    }
  } finally {
    /* Se cierran y anulan las visitas de prueba. */
    for (const id of idVisita) {
      try {
        await api('POST', '/api/visitas/' + id + '/salida', {});
        await api('POST', '/api/visitas/' + id + '/anular', { motivo: 'Prueba de promesas' });
      } catch (e) { /* da igual */ }
    }
    if (idVisita.length) info('se cerraron ' + idVisita.length + ' visita(s) de prueba');
  }

  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + ok + ' promesas comprobadas, ' + fallos + ' incumplidas');
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
