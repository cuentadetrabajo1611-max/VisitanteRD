/**
 * VisitaFlow - Rutas del sistema.
 *
 * Todas las rutas de datos cuelgan de /api y pasan por el intermediario de
 * sesion, que es el que fija req.tenant_id. Ninguna ruta lee la institucion del
 * cuerpo ni de la direccion.
 */
'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const bd = require('./db');
const util = require('./util');
const auth = require('./auth');
const acceso = require('./acceso');
const auditoria = require('./auditoria');
const permisos = require('./permisos');
const mantenimiento = require('./mantenimiento');
const padron = require('./identidad/padron');
const visitas = require('./visitas');
const gafete = require('./gafete');
const impresion = require('./impresion');
const avisos = require('./avisos');
const vigilancia = require('./vigilancia');
const preregistro = require('./preregistro');
const reportes = require('./reportes');
const lic = require('./licencias/licencia');

const { asincrono, responder, error } = util;

/**
 * El gestor de licencias, a nivel de modulo.
 *
 * Estaba declarado DENTRO de rutas(), y eso fue un problema real: las funciones
 * que viven fuera (tenantDeLaInstalacion, notificarAnfitrion) no lo veian. Al
 * llamarlo desde alli no saltaba un error, porque el nombre existia en otro
 * ambito y se resolvia a undefined... salvo que la referencia revienta. En la
 * practica se traducia en "no se puede entrar al sistema" sin ninguna pista.
 *
 * Se asigna al construir el enrutador y queda disponible para todo el modulo.
 */
let gestor = null;

/**
 * Construye el enrutador principal.
 * @param {object} ctx  { gestor }
 */
function rutas(ctx) {
  gestor = ctx.gestor;
  const r = express.Router();

  const conSesion = acceso.sesion;
  const permiso = acceso.exigePermiso;

  /**
   * Exige que la licencia incluya un modulo que se PAGA aparte.
   *
   * Hasta ahora el modulo no se comprobaba en NINGUNA ruta: la licencia decia
   * que modulos tenia el cliente, pero el sistema dejaba usar todos. La lista de
   * modulos era decorativa, y eso hace que la licencia no sirva de nada.
   *
   * Que modulos se bloquean y cuales no, y por que:
   *
   *   SE BLOQUEAN los que se venden aparte y no afectan a la operacion diaria:
   *   reportes, vigilancia, pre-registro y la API.
   *
   *   NO SE BLOQUEAN los que sostienen el sistema: registro, recepcion, gafetes,
   *   configuracion, usuarios y personalizacion. Un recepcionista que de pronto
   *   no puede registrar visitantes por un modulo que vencio, con gente en la
   *   puerta, es un problema mucho mas grave que una licencia impagada. Para eso
   *   esta el vencimiento de la licencia, que ya deja el sistema en solo lectura
   *   sin impedir consultar lo registrado.
   */
  const modulo = (nombre) => acceso.exigeModulo(gestor, nombre);

  /* ================================================================== */
  /* Salud y marca (publicas)                                           */
  /* ================================================================== */

  r.get(
    '/salud',
    asincrono(async (req, res) => {
      const inicio = Date.now();
      let bdOk = false;
      let bdMotivo = null;
      try {
        await bd.consultar('SELECT 1 AS x');
        bdOk = true;
      } catch (e) {
        bdMotivo = e.message;
      }

      const estadoLic = gestor.estado();
      responder(res, {
        sistema: 'VisitaFlow',
        version: require(path.join(config.raiz, 'package.json')).version,
        entorno: config.servidor.entorno,
        hora: new Date().toISOString(),
        ms: Date.now() - inicio,
        base_datos: { disponible: bdOk, base: config.bd.sistema.database, motivo: bdMotivo },
        cedulas: padron.estado(),
        licencia: {
          estado: estadoLic.estado,
          valida: estadoLic.valida,
          cliente: estadoLic.licencia ? estadoLic.licencia.cliente : null,
          hasta: estadoLic.licencia ? estadoLic.licencia.hasta : null,
          dias_restantes: estadoLic.dias_restantes,
        },
        /* El servidor de licencias, sin llamarlo: se informa de si está
           configurado y a qué dirección apunta. Llamarlo en cada consulta de
           salud convertiría una comprobación local en una que depende de la red,
           y esta ruta la usa el healthcheck del contenedor. */
        servidor_licencias: {
          configurado: Boolean(config.licencia.servidor),
          direccion: config.licencia.servidor || null,
        },
      });
    })
  );

  /** Marca de la institucion: colores, logo y nombre para pintar la interfaz. */
  r.get(
    '/marca',
    acceso.sesionOpcional,
    asincrono(async (req, res) => {
      /* Con sesión: la institución del token. Sin sesión: la de la instalación,
         que sale de su licencia. Ya no hay lista donde elegir: esta instalación
         es de un solo cliente. */
      const codigo = req.tenant
        ? req.tenant.codigo
        : (codigoPedido(req.query.tenant) || await tenantDeLaInstalacion());

      if (!codigo) {
        // Sin licencia activada no hay institución todavía: la pantalla de acceso
        // mostrará el formulario de activación.
        return responder(res, { instituciones: [], marca: null, necesita_licencia: true });
      }

      const t = await mantenimiento.porCodigo(codigo);
      if (!t) return responderError404(res, 'No se encontró esa institución.');
      const marca = await mantenimiento.marca(t.id);
      // La zona horaria y el estado viajan con la marca: la pantalla de acceso
      // los necesita antes de tener sesion.
      responder(res, { marca: Object.assign({ estado: t.estado }, marca) });
    })
  );

  /** Lista de instituciones para la pantalla de acceso. */
  /**
   * Datos de ESTA instalación, para la pantalla de acceso.
   *
   * Una instalación es de un solo cliente, así que esto devuelve su institución
   * y nada más: no hay lista donde elegir. El ordenador del recepcionista abre
   * su sistema y ya está en el suyo.
   *
   * Se sigue llamando "instituciones" y devolviendo una lista de uno para no
   * romper lo que ya lo usaba (pruebas, capturas), pero la lista nunca tiene más
   * de un elemento: si tuviera dos, algo está mal en esa instalación y conviene
   * que se note.
   */
  r.get(
    '/acceso/instituciones',
    asincrono(async (req, res) => {
      const codigo = await tenantDeLaInstalacion();
      if (!codigo) {
        /* No se pudo resolver la institución. Se devuelve el motivo para que se
           pueda diagnosticar sin mirar los registros del servidor: si el sistema
           no deja entrar, hay que saber POR QUÉ. */
        const e = gestor.estado();
        let enBase = [];
        try {
          const r = await bd.consultar('SELECT codigo FROM vf_tenants WHERE estado = @e', { e: 'activo' });
          enBase = r.recordset.map((x) => x.codigo);
        } catch (err) {
          enBase = ['error leyendo la base: ' + err.message];
        }
        return responder(res, {
          instituciones: [],
          hay_datos: false,
          necesita_licencia: true,
          diagnostico: {
            licencia_valida: Boolean(e.valida),
            licencia_estado: e.estado,
            licencia_tenant: e.licencia ? e.licencia.tenant : null,
            motivo: e.motivo || null,
            instituciones_activas: enBase,
            explicacion: e.valida && e.licencia && e.licencia.tenant
              ? 'La licencia está bien, pero esa institución no existe en la base. Falta crearla (reinicie el sistema).'
              : (enBase.length > 1
                ? 'Hay más de una institución activa. Esta instalación debe tener una sola.'
                : 'La licencia no está cargada o no es válida.'),
          },
        });
      }

      const t = await mantenimiento.porCodigo(codigo);
      if (!t) return responder(res, { instituciones: [], hay_datos: false, necesita_licencia: true });

      responder(res, {
        instituciones: [t],
        hay_datos: true,
        necesita_licencia: false,
        // De dónde salió la institución: de la licencia o de la base. Sirve para
        // diagnosticar cuando alguien no puede entrar.
        origen: gestor.estado().valida ? 'licencia' : 'base',
      });
    })
  );

  /**
   * Utilidad de desarrollo: deja la cookie de sesión puesta para poder abrir la
   * aplicacion en un navegador sin pasar por el formulario.
   *
   * Solo existe cuando NODE_ENV no es "production", y de todos modos exige
   * credenciales validas: no es una puerta trasera, es un atajo para pruebas
   * automatizadas y para tomar capturas de pantalla.
   */
  r.get(
    '/acceso/dev-entrar',
    asincrono(async (req, res) => {
      if (config.esProduccion()) throw error(404, 'Esa dirección no existe.');

      const { tenant, correo, clave } = req.query;
      if (!tenant || !correo || !clave) throw error(400, 'Indique tenant, correo y clave.');

      const resultado = await auth.iniciarSesion({ tenant, correo, clave, ip: util.ip(req), agente: util.agente(req) });
      if (!resultado.ok) throw error(401, resultado.motivo);

      res.cookie('vf_token', resultado.token, {
        httpOnly: true,
        sameSite: 'lax',
        // La cookie se marca segura si el sitio va por HTTPS. Estaba fijo en
        // false: con HTTPS el navegador la habría rechazado.
        secure: config.esProduccion(),
        maxAge: 12 * 3600 * 1000,
        path: '/',
      });
      responder(res, { ok_dev: true, usuario: resultado.usuario, token: resultado.token });
    })
  );

  /** Inicio de sesion. */
  r.post(
    '/acceso/entrar',
    asincrono(async (req, res) => {
      const { correo, clave } = req.body || {};
      if (!correo || !clave) {
        throw error(400, 'Indique el correo y la contraseña.');
      }

      /* La institución NO se pide en el formulario: sale de la licencia de ESTA
         instalación. Cada cliente tiene la suya, con su propia licencia, así que
         el recepcionista solo escribe su correo y su clave. Pedirle además que
         elija institución era una complicación sin motivo: en su instalación
         solo hay una.

         Se sigue aceptando que venga en el cuerpo, para no romper las
         herramientas que ya la mandan (pruebas y capturas de pantalla). */
      const tenant = codigoPedido(req.body && req.body.tenant) || await tenantDeLaInstalacion();

      if (!tenant) {
        throw error(409, 'Esta instalación todavía no tiene la licencia activada. Actívela para poder entrar.');
      }

      const resultado = await auth.iniciarSesion({
        tenant,
        correo,
        clave,
        ip: util.ip(req),
        agente: util.agente(req),
      });

      if (!resultado.ok) {
        await auditoria.anotar({ tenant_id: null, usuario: null }, 'acceso.fallido', {
          entidad: 'usuario',
          entidad_id: correo,
          detalle: 'Institución: ' + tenant + '. ' + resultado.motivo,
        });
        throw error(401, resultado.motivo);
      }

      // El token viaja en una cookie HttpOnly ademas de en el cuerpo: la cookie
      // permite que las imagenes y las descargas lo lleven sin trucos.
      res.cookie('vf_token', resultado.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.esProduccion(),
        maxAge: 12 * 3600 * 1000,
        path: '/',
      });

      req.tenant_id = resultado.usuario.tenant_id;
      req.usuario = resultado.usuario;
      await auditoria.anotar(req, 'acceso.entrar', { entidad: 'usuario', entidad_id: resultado.usuario.id });

      responder(res, {
        token: resultado.token,
        usuario: resultado.usuario,
        permisos: resultado.permisos,
        marca: await mantenimiento.marca(resultado.usuario.tenant_id),
        licencia: gestor.estado(),
      });
    })
  );

  /** Cerrar sesion. */
  r.post(
    '/acceso/salir',
    asincrono(async (req, res) => {
      res.clearCookie('vf_token', { path: '/' });
      responder(res, {});
    })
  );

  /** Sesion actual: la usa el frontend al recargar la pagina. */
  r.get(
    '/acceso/sesion',
    conSesion,
    asincrono(async (req, res) => {
      // Se devuelve el usuario completo, incluido tenant_id: el frontend lo
      // necesita para saber a qué institución pertenece la sesión.
      responder(res, {
        usuario: Object.assign({}, req.usuario, { tenant: req.tenant.codigo, tenant_nombre: req.tenant.nombre }),
        permisos: req.permisos,
        marca: await mantenimiento.marca(req.tenant_id),
        licencia: gestor.estado(),
      });
    })
  );

  /** Recuperacion de contrasena: pide el enlace. */
  r.post(
    '/acceso/recuperar',
    asincrono(async (req, res) => {
      const { correo } = req.body || {};
      if (!correo) throw error(400, 'Indique su correo.');

      const respuesta = {
        mensaje: 'Si ese correo existe en el sistema, recibirá un enlace para restablecer su contraseña.',
      };

      /* La institución sale de la licencia de la instalación, igual que al
         entrar. Sin licencia activada no hay ninguna institución donde buscar la
         cuenta, y la respuesta es la misma de siempre: no se revela si el correo
         existe o no. */
      const tenant = codigoPedido(req.body && req.body.tenant) || await tenantDeLaInstalacion();
      if (!tenant) return responder(res, respuesta);

      const datos = await auth.crearTokenRecuperacion(tenant, correo, 60);
      // La respuesta es la misma exista o no el correo: no se revela quien tiene
      // cuenta en el sistema.
      if (datos && config.correo.activo) {
        console.log('[recuperar] enlace para', correo, ':', config.servidor.urlPublica + '/reset?token=' + datos.token);
      }
      responder(res, respuesta);
    })
  );

  /** Recuperacion de contrasena: cambia la clave con el token. */
  r.post(
    '/acceso/restablecer',
    asincrono(async (req, res) => {
      const { token, clave } = req.body || {};
      if (!token || !clave) throw error(400, 'Faltan datos para restablecer la contraseña.');
      const resultado = await auth.usarTokenRecuperacion(token, clave);
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, { mensaje: 'Su contraseña quedó cambiada. Ya puede entrar.' });
    })
  );

  /* ================================================================== */
  /* Licencia                                                           */
  /* ================================================================== */

  /**
   * Activar con el ID de la licencia.
   *
   * Es la via del primer arranque: el cliente instala el sistema, escribe el ID
   * que le dieron y el sistema pide la licencia al servidor. No hay que mandar
   * ningun archivo por correo.
   *
   * Publica por la misma razon que la activacion por archivo: en una instalacion
   * vacia no existe ningun usuario con el que autenticarse, asi que exigir sesion
   * la bloquearia para siempre. Lo que entra es un ID que el servidor valida.
   */
  r.post(
    '/licencia/activar-id',
    asincrono(async (req, res) => {
      const id = util.limpiar(req.body && req.body.licencia_id, 60);
      if (!id) throw error(400, 'Escriba el ID de la licencia.');

      const primerArranque = await auth.esPrimerArranque();

      /* Si la instalacion YA tiene institucion, activar es un cambio de
         licencia y eso si exige sesion y permiso: no puede hacerlo cualquiera
         que llegue a la red. */
      if (!primerArranque) {
        await new Promise((listo, falla) => {
          conSesion(req, res, () => permiso('licencia.activar')(req, res, (e) => (e ? falla(e) : listo())));
        });
      }

      const resultado = await gestor.activarPorId(id);

      await auditoria.anotar(req, 'licencia.activar', {
        entidad: 'licencia',
        entidad_id: id,
        detalle: (primerArranque ? '[primer arranque] ' : '') +
          (resultado.ok ? 'Activada por ID: ' + (resultado.cliente || '') : 'Rechazada: ' + resultado.motivo),
      });

      if (!resultado.ok) throw error(resultado.sinServidor || resultado.sinConexion ? 503 : 400, resultado.motivo);

      responder(res, {
        licencia: gestor.estado(),
        cliente: resultado.cliente || null,
        hasta: resultado.hasta || null,
        // Si es el primer arranque, el sistema acaba de crear su institucion,
        // sus catalogos y su administrador. Conviene decirlo.
        primer_arranque: primerArranque,
      });
    })
  );

  /**
   * Estado para la pantalla de acceso: dice si la instalacion esta VACIA.
   *
   * Es publica a proposito: la pantalla de acceso necesita saber si mostrar el
   * formulario de entrada o el de activacion, y eso ocurre antes de tener
   * sesion. No revela nada delicado: solo si hay o no alguna institucion.
   */
  r.get(
    '/licencia/estado-inicial',
    asincrono(async (req, res) => {
      const vacia = await auth.esPrimerArranque();
      const estado = gestor.estado();
      responder(res, {
        primer_arranque: vacia,
        necesita_activacion: vacia,
        licencia: {
          cargada: estado.cargada,
          valida: estado.valida,
          estado: estado.estado,
          motivo: vacia ? estado.motivo : null,
          cliente: estado.licencia ? estado.licencia.cliente : null,
          dias_restantes: estado.dias_restantes,
        },
      });
    })
  );

  r.get(
    '/licencia',
    conSesion,
    asincrono(async (req, res) => {
      responder(res, { licencia: gestor.estado() });
    })
  );

  /**
   * Activar la licencia.
   *
   * Dos caminos, y la diferencia importa:
   *
   *  - Instalacion VACIA (primer arranque): NO se pide sesion, porque no puede
   *    haberla. Sin institucion no hay usuarios, y sin usuarios nadie podria
   *    activar el sistema: quedaria bloqueado para siempre. Lo que entra por
   *    aqui es un archivo firmado que se verifica antes de guardar nada.
   *
   *  - Instalacion en uso: se exige sesion y el permiso de siempre. Si no,
   *    cualquiera con acceso a la red podria cambiar la licencia.
   */
  r.post(
    '/licencia/activar',
    asincrono(async (req, res, next) => {
      if (await auth.esPrimerArranque()) return next();
      // Instalacion en uso: pasa por las mismas puertas que todo lo demas.
      return conSesion(req, res, () => {
        permiso('licencia.activar')(req, res, next);
      });
    }),
    asincrono(async (req, res) => {
      const { texto } = req.body || {};
      if (!texto) throw error(400, 'Pegue el contenido del archivo de licencia.');

      const primerArranque = await auth.esPrimerArranque();
      const resultado = await gestor.activar(texto, primerArranque ? 'primer-arranque' : 'manual');

      await auditoria.anotar(req, 'licencia.activar', {
        entidad: 'licencia',
        detalle:
          (primerArranque ? '[primer arranque] ' : '') +
          (resultado.ok
            ? 'Activada: ' + ((resultado.evaluacion && resultado.evaluacion.contenido) || {}).licencia_id
            : 'Rechazada: ' + resultado.motivo),
      });

      if (!resultado.ok && resultado.estado !== 'vencida') throw error(400, resultado.motivo);
      responder(res, { licencia: gestor.estado() });
    })
  );

  r.post(
    '/licencia/renovar',
    conSesion,
    permiso('licencia.activar'),
    asincrono(async (req, res) => {
      const resultado = await gestor.renovarDesdeServidor();
      await auditoria.anotar(req, 'licencia.renovar', { entidad: 'licencia', detalle: resultado.motivo || 'ok' });
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, { licencia: gestor.estado() });
    })
  );

  /* ================================================================== */
  /* Panel y registro                                                   */
  /* ================================================================== */

  r.get(
    '/panel',
    conSesion,
    permiso('recepcion.ver'),
    asincrono(async (req, res) => {
      const t = await mantenimiento.porId(req.tenant_id);
      responder(res, { panel: await visitas.resumen(req.tenant_id, t.zona_horaria) });
    })
  );

  /** Consulta de cedula: identidad, historial y avisos en una sola llamada. */
  r.get(
    '/registro/consultar',
    conSesion,
    permiso('registro.ver'),
    asincrono(async (req, res) => {
      const datos = await visitas.prepararRegistro(req.tenant_id, req.query.cedula, {});
      responder(res, { consulta: datos });
    })
  );

  /** Busqueda por nombre en el padron (cuando no traen la cedula a mano). */
  r.get(
    '/registro/buscar',
    conSesion,
    permiso('registro.ver'),
    asincrono(async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (padron.soloDigitos(q).length >= 6) {
        const c = await visitas.prepararRegistro(req.tenant_id, q, {});
        return responder(res, { resultados: c.ciudadano ? [c.ciudadano] : [], consulta: c, por: 'cedula' });
      }
      const resultado = await padron.porNombre(q, util.entero(req.query.limite, 20, 1, 50));
      responder(res, { resultados: resultado.resultados, motivo: resultado.motivo, disponible: resultado.disponible, por: 'nombre' });
    })
  );

  /** Registrar la entrada. */
  r.post(
    '/registro',
    conSesion,
    permiso('registro.crear'),
    asincrono(async (req, res) => {
      const resultado = await visitas.registrarEntrada(req, req.body || {});
      if (!resultado.ok) {
        return res.status(resultado.duplicado ? 409 : 400).json(Object.assign({ ok: false }, resultado));
      }

      /* Aviso a quien recibe la visita.
         Se lanza SIN esperarlo (el recepcionista esta esperando para imprimir
         el gafete), pero con un giro de la cola de eventos por delante: el
         aviso lleva una clave ajena a la visita, y si se lanzara en el mismo
         tic, la transaccion que acaba de crearla podria no estar confirmada
         todavia y el aviso se perderia sin que nadie se entere.
         Paso exactamente eso al escribirlo. */
      setTimeout(() => {
        notificarAnfitrion(req.tenant_id, resultado.visita).catch(() => {});
      }, 0);

      responder(res, resultado, 201);
    })
  );

  /* ================================================================== */
  /* Recepcion: entradas y salidas                                      */
  /* ================================================================== */

  r.get(
    '/visitas',
    conSesion,
    permiso('recepcion.ver'),
    asincrono(async (req, res) => {
      responder(res, { listado: await visitas.listar(req.tenant_id, req.query) });
    })
  );

  r.get(
    '/visitas/:id',
    conSesion,
    permiso('recepcion.ver'),
    asincrono(async (req, res) => {
      const v = await visitas.detalle(req.tenant_id, util.entero(req.params.id, 0));
      if (!v) throw error(404, 'No se encontró esa visita.');
      responder(res, { visita: v });
    })
  );

  r.post(
    '/visitas/:id/salida',
    conSesion,
    permiso('recepcion.salida'),
    asincrono(async (req, res) => {
      const resultado = await visitas.registrarSalida(req, util.entero(req.params.id, 0), req.body || {});
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, resultado);
    })
  );

  /** Salida por codigo de gafete: lo que usa el lector de barras. */
  r.post(
    '/recepcion/salida-por-codigo',
    conSesion,
    permiso('recepcion.salida'),
    asincrono(async (req, res) => {
      const resultado = await visitas.salidaPorCodigo(req, (req.body || {}).codigo);
      if (!resultado.ok) throw error(404, resultado.motivo);
      responder(res, resultado);
    })
  );

  r.post(
    '/visitas/:id/aprobar',
    conSesion,
    permiso('recepcion.aprobar'),
    asincrono(async (req, res) => {
      const resultado = await visitas.aprobar(req, util.entero(req.params.id, 0), req.body || {});
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, resultado);
    })
  );

  r.post(
    '/visitas/:id/anular',
    conSesion,
    permiso('recepcion.anular'),
    asincrono(async (req, res) => {
      const resultado = await visitas.anular(req, util.entero(req.params.id, 0), req.body || {});
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, resultado);
    })
  );

  /** Cierra las visitas que quedaron abiertas de dias anteriores. */
  r.post(
    '/recepcion/cerrar-vencidas',
    conSesion,
    permiso('recepcion.anular'),
    asincrono(async (req, res) => {
      const resultado = await visitas.cerrarVisitasVencidas(req.tenant_id, (req.body || {}).horas);
      await auditoria.anotar(req, 'recepcion.cerrar_vencidas', {
        entidad: 'visita',
        detalle: resultado.cerradas + ' visitas cerradas (más de ' + resultado.horas + ' h abiertas)',
      });
      responder(res, resultado);
    })
  );

  /* ================================================================== */
  /* Gafetes                                                            */
  /* ================================================================== */

  r.get(
    '/gafetes/visita/:id',
    conSesion,
    permiso('gafete.imprimir'),
    asincrono(async (req, res) => {
      const contenido = await gafete.contenido(req.tenant_id, util.entero(req.params.id, 0), req.query);
      if (!contenido) throw error(404, 'No se encontró esa visita.');
      responder(res, { gafete: contenido });
    })
  );

  r.post(
    '/gafetes/visita/:id/impreso',
    conSesion,
    permiso('gafete.imprimir'),
    asincrono(async (req, res) => {
      const resultado = await gafete.marcarImpreso(req.tenant_id, util.entero(req.params.id, 0));
      await auditoria.anotar(req, 'gafete.imprimir', { entidad: 'visita', entidad_id: req.params.id });
      responder(res, resultado);
    })
  );

  /**
   * Hoja de impresión del gafete: SOLO el gafete, con su propia regla @page.
   *
   * Esta es la dirección que abre el navegador al pulsar Imprimir, en una
   * ventana aparte. Existe porque el tamaño de la página tiene que estar en el
   * documento ANTES de imprimir (ver el comentario largo en src/impresion.js):
   * sin eso, una impresora térmica recibe una hoja A4 escalada en vez de una
   * etiqueta.
   *
   * Va con sesión: lleva el nombre y la cédula de una persona. No se puede
   * dejar abierta.
   */
  r.get(
    '/gafetes/visita/:id/hoja',
    conSesion,
    permiso('gafete.imprimir'),
    asincrono(async (req, res) => {
      const id = util.entero(req.params.id, 0);
      const contenido = await gafete.contenido(req.tenant_id, id, req.query);
      if (!contenido) throw error(404, 'No se encontró esa visita.');

      const formato = impresion.formatoValido(req.query.formato);
      const copias = util.entero(req.query.copias, 1);

      const html = impresion.generar(contenido, { formato, copias });

      // No se cachea: lleva datos de una visita concreta.
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    })
  );

  /** Formatos de impresión disponibles, para que la pantalla los ofrezca. */
  r.get(
    '/gafetes/formatos',
    conSesion,
    permiso('gafete.imprimir'),
    asincrono(async (req, res) => {
      responder(res, {
        formatos: Object.keys(impresion.FORMATOS).map((k) => ({
          codigo: k,
          nombre: impresion.FORMATOS[k].nombre,
        })),
      });
    })
  );

  /* ================================================================== */
  /* Avisos al anfitrion                                                */
  /* ================================================================== */

  /** Los avisos sin leer. Los ve quien esta en recepcion. */
  r.get(
    '/avisos',
    conSesion,
    permiso('recepcion.ver'),
    asincrono(async (req, res) => {
      responder(res, {
        avisos: await avisos.pendientes(req.tenant_id, req.query.limite),
        sin_leer: await avisos.contarPendientes(req.tenant_id),
      });
    })
  );

  r.post(
    '/avisos/:id/leido',
    conSesion,
    permiso('recepcion.ver'),
    asincrono(async (req, res) => {
      const ok = await avisos.marcarLeido(req.tenant_id, util.entero(req.params.id, 0));
      responder(res, { marcado: ok, sin_leer: await avisos.contarPendientes(req.tenant_id) });
    })
  );

  r.post(
    '/avisos/leidos',
    conSesion,
    permiso('recepcion.ver'),
    asincrono(async (req, res) => {
      const r2 = await bd.consultar(
        'UPDATE vf_avisos SET estado = @estado, leido = SYSDATETIMEOFFSET() ' +
        'WHERE tenant_id = @tenant_id AND leido IS NULL',
        { tenant_id: req.tenant_id, estado: 'leido' }
      );
      responder(res, { marcados: r2.rowsAffected[0], sin_leer: 0 });
    })
  );

  /**
   * Directorio de personas para elegir a quien se visita.
   *
   * Es una ruta aparte de /config/personas a proposito: la necesita el
   * recepcionista al registrar (permiso de registro), no solo quien configura
   * el sistema. Devuelve lo minimo: id, nombre, cargo y departamento.
   */
  r.get(
    '/personas',
    conSesion,
    permiso('registro.ver'),
    asincrono(async (req, res) => {
      const texto = util.limpiar(req.query.texto, 80);
      const depto = util.entero(req.query.departamento_id, 0);

      const filas = await bd.consultar(
        `SELECT TOP 60 p.id, p.nombre, p.cargo, p.correo, p.departamento_id,
                d.nombre AS departamento
           FROM vf_personas p
           LEFT JOIN vf_departamentos d ON d.id = p.departamento_id
          WHERE p.tenant_id = @tenant_id AND p.activo = 1 AND p.recibe_visitas = 1
            ${depto ? 'AND p.departamento_id = @depto' : ''}
            ${texto ? 'AND (p.nombre LIKE @texto OR p.cargo LIKE @texto)' : ''}
          ORDER BY p.nombre`,
        {
          tenant_id: req.tenant_id,
          depto: depto || null,
          texto: texto ? '%' + texto + '%' : null,
        }
      );
      responder(res, { personas: filas.recordset });
    })
  );

  /** Prueba del envio de correo, desde la pantalla de licencia. */
  r.post(
    '/avisos/probar-correo',
    conSesion,
    permiso('config.editar'),
    asincrono(async (req, res) => {
      const destino = util.correo(req.body && req.body.correo) || (req.usuario && req.usuario.correo);
      if (!destino) throw error(400, 'Indique a qué dirección mandar la prueba.');

      const r2 = await avisos.probarCorreo(destino);
      await auditoria.anotar(req, 'correo.probar', {
        entidad: 'correo',
        detalle: (r2.ok ? 'Enviado a ' : 'Falló hacia ') + destino + (r2.ok ? '' : ': ' + r2.motivo),
      });

      responder(res, {
        ok: r2.ok,
        motivo: r2.motivo || null,
        destinatario: destino,
        configurado: Boolean(config.correo.activo && config.correo.host),
      });
    })
  );

  r.get(
    '/gafetes/pendientes',
    conSesion,
    permiso('gafete.imprimir'),
    asincrono(async (req, res) => {
      responder(res, { gafetes: await gafete.pendientes(req.tenant_id) });
    })
  );

  r.get(
    '/gafetes/plantillas',
    conSesion,
    permiso('gafete.imprimir'),
    asincrono(async (req, res) => {
      responder(res, { plantillas: await gafete.plantillas(req.tenant_id), tamanos: gafete.TAMANOS });
    })
  );

  r.post(
    '/gafetes/plantillas',
    conSesion,
    permiso('gafete.disenar'),
    asincrono(async (req, res) => {
      const resultado = await gafete.guardarPlantilla(req.tenant_id, req.body || {}, null);
      await auditoria.anotar(req, 'gafete.plantilla.crear', { entidad: 'plantilla', entidad_id: resultado.id });
      responder(res, resultado, 201);
    })
  );

  r.patch(
    '/gafetes/plantillas/:id',
    conSesion,
    permiso('gafete.disenar'),
    asincrono(async (req, res) => {
      const resultado = await gafete.guardarPlantilla(req.tenant_id, req.body || {}, util.entero(req.params.id, 0));
      await auditoria.anotar(req, 'gafete.plantilla.editar', { entidad: 'plantilla', entidad_id: req.params.id });
      responder(res, resultado);
    })
  );

  r.delete(
    '/gafetes/plantillas/:id',
    conSesion,
    permiso('gafete.disenar'),
    asincrono(async (req, res) => {
      const resultado = await gafete.desactivarPlantilla(req.tenant_id, util.entero(req.params.id, 0));
      await auditoria.anotar(req, 'gafete.plantilla.desactivar', { entidad: 'plantilla', entidad_id: req.params.id });
      responder(res, resultado);
    })
  );

  /* ================================================================== */
  /* Pre-registro                                                       */
  /* ================================================================== */

  r.get(
    '/preregistros',
    conSesion,
    modulo('preregistro'),
    permiso('preregistro.ver'),
    asincrono(async (req, res) => {
      responder(res, {
        listado: await preregistro.listar(req.tenant_id, req.query),
        resumen: await preregistro.resumen(req.tenant_id),
        catalogos: await visitas.catalogosDe(req.tenant_id),
      });
    })
  );

  r.get(
    '/preregistros/codigo/:codigo',
    conSesion,
    permiso('preregistro.ver'),
    asincrono(async (req, res) => {
      const p = await preregistro.porCodigo(req.tenant_id, req.params.codigo);
      if (!p) throw error(404, 'No se encontró ningún pre-registro con ese código.');
      responder(res, { preregistro: p });
    })
  );

  r.post(
    '/preregistros',
    conSesion,
    permiso('preregistro.crear'),
    asincrono(async (req, res) => {
      const resultado = await preregistro.crear(req.tenant_id, req.body || {}, req);
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, resultado, 201);
    })
  );

  r.patch(
    '/preregistros/:id',
    conSesion,
    permiso('preregistro.editar'),
    asincrono(async (req, res) => {
      const resultado = await preregistro.editar(req.tenant_id, util.entero(req.params.id, 0), req.body || {});
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, resultado);
    })
  );

  r.delete(
    '/preregistros/:id',
    conSesion,
    permiso('preregistro.editar'),
    asincrono(async (req, res) => {
      const resultado = await preregistro.cancelar(req.tenant_id, util.entero(req.params.id, 0), req);
      if (!resultado.ok) throw error(400, resultado.motivo);
      responder(res, resultado);
    })
  );

  /* ================================================================== */
  /* Lista de vigilancia                                                */
  /* ================================================================== */

  r.get(
    '/vigilancia',
    conSesion,
    modulo('vigilancia'),
    permiso('vigilancia.ver'),
    asincrono(async (req, res) => {
      responder(res, {
        listado: await vigilancia.listar(req.tenant_id, req.query),
        resumen: await vigilancia.resumen(req.tenant_id),
      });
    })
  );

  r.get(
    '/vigilancia/avisos',
    conSesion,
    permiso('vigilancia.ver'),
    asincrono(async (req, res) => {
      responder(res, { listado: await vigilancia.avisos(req.tenant_id, req.query) });
    })
  );

  /** Consulta puntual: la usa la pantalla de registro al validar una cédula. */
  r.get(
    '/vigilancia/cedula/:cedula',
    conSesion,
    permiso('vigilancia.ver'),
    asincrono(async (req, res) => {
      responder(res, { vigilancia: await vigilancia.consultarCedula(req.tenant_id, req.params.cedula) });
    })
  );

  r.post(
    '/vigilancia',
    conSesion,
    permiso('vigilancia.editar'),
    asincrono(async (req, res) => {
      const resultado = await vigilancia.agregar(req.tenant_id, req.body || {}, req);
      if (!resultado.ok) {
        return res.status(resultado.duplicado ? 409 : 400).json(Object.assign({ ok: false }, resultado));
      }
      await auditoria.anotar(req, 'vigilancia.agregar', {
        entidad: 'vigilancia',
        entidad_id: resultado.id,
        detalle: (req.body || {}).tipo + ': ' + (req.body || {}).motivo,
      });
      responder(res, resultado, 201);
    })
  );

  r.patch(
    '/vigilancia/:id',
    conSesion,
    permiso('vigilancia.editar'),
    asincrono(async (req, res) => {
      const resultado = await vigilancia.editar(req.tenant_id, util.entero(req.params.id, 0), req.body || {});
      if (!resultado.ok) throw error(400, resultado.motivo);
      await auditoria.anotar(req, 'vigilancia.editar', { entidad: 'vigilancia', entidad_id: req.params.id });
      responder(res, resultado);
    })
  );

  /** Levantar un registro: no se borra, queda el historial. */
  r.delete(
    '/vigilancia/:id',
    conSesion,
    permiso('vigilancia.editar'),
    asincrono(async (req, res) => {
      const resultado = await vigilancia.levantar(req.tenant_id, util.entero(req.params.id, 0), req.body || {}, req);
      if (!resultado.ok) throw error(400, resultado.motivo);
      await auditoria.anotar(req, 'vigilancia.levantar', {
        entidad: 'vigilancia',
        entidad_id: req.params.id,
        detalle: (req.body || {}).motivo,
      });
      responder(res, resultado);
    })
  );

  /* ================================================================== */
  /* Reportes                                                           */
  /* ================================================================== */

  r.get(
    '/reportes/resumen',
    conSesion,
    modulo('reportes'),
    permiso('reportes.ver'),
    asincrono(async (req, res) => {
      responder(res, {
        reporte: await reportes.resumen(req.tenant_id, req.query),
        opciones: await reportes.opciones(req.tenant_id),
        largas: await reportes.visitasLargas(req.tenant_id),
      });
    })
  );

  r.get(
    '/reportes/visitas',
    conSesion,
    permiso('reportes.ver'),
    asincrono(async (req, res) => {
      responder(res, { listado: await reportes.detalle(req.tenant_id, req.query) });
    })
  );

  r.get(
    '/reportes/visitantes',
    conSesion,
    permiso('reportes.ver'),
    asincrono(async (req, res) => {
      responder(res, { listado: await reportes.visitantesFrecuentes(req.tenant_id, req.query) });
    })
  );

  r.get(
    '/reportes/visitas.csv',
    conSesion,
    permiso('reportes.exportar'),
    asincrono(async (req, res) => {
      const { csv, filas } = await reportes.exportarCsv(req.tenant_id, req.query);
      await auditoria.anotar(req, 'reportes.exportar', {
        entidad: 'reporte',
        detalle: filas + ' visitas exportadas a CSV',
      });
      const nombre = 'visitas-' + reportes.rango(req.query).desde + '_' + reportes.rango(req.query).hasta + '.csv';
      util.descarga(res, nombre, csv, 'text/csv');
    })
  );

  /* ================================================================== */
  /* Configuracion y personalizacion                                    */
  /* ================================================================== */

  /** Todo lo que necesita la pantalla de configuracion, en una llamada. */
  r.get(
    '/config',
    conSesion,
    permiso('config.ver'),
    asincrono(async (req, res) => {
      responder(res, await configuracionCompleta(req.tenant_id));
    })
  );

  r.patch(
    '/config/ajustes',
    conSesion,
    permiso('config.editar'),
    asincrono(async (req, res) => {
      const n = await mantenimiento.guardarAjustes(req.tenant_id, (req.body || {}).ajustes || req.body || {});
      await auditoria.anotar(req, 'config.ajustes', { entidad: 'ajustes', detalle: n + ' ajustes guardados' });
      responder(res, { guardados: n, config: await configuracionCompleta(req.tenant_id) });
    })
  );

  /** Catalogos: departamentos, motivos, categorias, sedes. */
  const CATALOGOS = {
    departamentos: {
      tabla: 'vf_departamentos',
      permisoVer: 'config.ver',
      permisoEditar: 'config.editar',
      campos: ['nombre', 'encargado', 'correo', 'telefono'],
      obligatorios: ['nombre'],
    },
    motivos: {
      tabla: 'vf_motivos',
      permisoVer: 'config.ver',
      permisoEditar: 'config.editar',
      campos: ['nombre', 'avisa_anfitrion', 'exige_aprobacion', 'exige_documento', 'exige_vehiculo', 'exige_pertenencias', 'exige_temperatura', 'color'],
      obligatorios: ['nombre'],
      booleanos: ['avisa_anfitrion', 'exige_aprobacion', 'exige_documento', 'exige_vehiculo', 'exige_pertenencias', 'exige_temperatura'],
    },
    categorias: {
      tabla: 'vf_categorias',
      permisoVer: 'config.ver',
      permisoEditar: 'config.editar',
      campos: ['nombre', 'exige_documento'],
      obligatorios: ['nombre'],
      booleanos: ['exige_documento'],
    },
    sedes: {
      tabla: 'vf_sedes',
      permisoVer: 'config.ver',
      permisoEditar: 'config.editar',
      campos: ['nombre', 'direccion', 'hora_desde', 'hora_hasta'],
      obligatorios: ['nombre'],
    },
    /* Directorio del personal interno que recibe visitas. Es lo que permite
       elegir a quien se visita de una lista en vez de escribirlo cada vez. */
    personas: {
      tabla: 'vf_personas',
      permisoVer: 'config.ver',
      permisoEditar: 'config.editar',
      campos: ['nombre', 'cargo', 'correo', 'telefono', 'departamento_id', 'recibe_visitas'],
      obligatorios: ['nombre'],
      booleanos: ['recibe_visitas'],
      enteros: ['departamento_id'],
    },
  };

  for (const [nombre, def] of Object.entries(CATALOGOS)) {
    r.get(
      '/config/' + nombre,
      conSesion,
      permiso(def.permisoVer),
      asincrono(async (req, res) => {
        const soloActivos = util.booleano(req.query.activos, false);
        const filas = await bd.consultar(
          `SELECT * FROM ${def.tabla} WHERE tenant_id = @tenant_id ${soloActivos ? 'AND activo = 1' : ''} ORDER BY nombre`,
          { tenant_id: req.tenant_id }
        );
        responder(res, { filas: filas.recordset.map((f) => normalizarBooleanos(f, def.booleanos)) });
      })
    );

    r.post(
      '/config/' + nombre,
      conSesion,
      permiso(def.permisoEditar),
      asincrono(async (req, res) => {
        const valores = tomarCampos(req.body, def);
        for (const campo of def.obligatorios) {
          if (!valores[campo]) throw error(400, 'El campo "' + campo + '" es obligatorio.');
        }
        const campos = Object.keys(valores);
        const r2 = await bd.consultar(
          `INSERT INTO ${def.tabla} (tenant_id, ${campos.join(', ')})
           OUTPUT INSERTED.id
           VALUES (@tenant_id, ${campos.map((c) => '@' + c).join(', ')})`,
          Object.assign({ tenant_id: req.tenant_id }, valores)
        );
        await auditoria.anotar(req, 'config.' + nombre + '.crear', {
          entidad: nombre,
          entidad_id: r2.recordset[0].id,
          detalle: valores.nombre,
        });
        responder(res, { id: r2.recordset[0].id }, 201);
      })
    );

    r.patch(
      '/config/' + nombre + '/:id',
      conSesion,
      permiso(def.permisoEditar),
      asincrono(async (req, res) => {
        const valores = tomarCampos(req.body, def);
        if (!Object.keys(valores).length) throw error(400, 'No hay nada que cambiar.');
        const campos = Object.keys(valores).map((c) => c + ' = @' + c).join(', ');
        const r2 = await bd.consultar(
          `UPDATE ${def.tabla} SET ${campos} WHERE tenant_id = @tenant_id AND id = @id`,
          Object.assign({ tenant_id: req.tenant_id, id: util.entero(req.params.id, 0) }, valores)
        );
        if (!r2.rowsAffected[0]) throw error(404, 'No se encontró ese registro.');
        await auditoria.anotar(req, 'config.' + nombre + '.editar', { entidad: nombre, entidad_id: req.params.id });
        responder(res, { actualizado: r2.rowsAffected[0] });
      })
    );

    /** Baja logica: los registros historicos siguen apuntando a este catalogo. */
    r.delete(
      '/config/' + nombre + '/:id',
      conSesion,
      permiso(def.permisoEditar),
      asincrono(async (req, res) => {
        const r2 = await bd.consultar(
          `UPDATE ${def.tabla} SET activo = 0 WHERE tenant_id = @tenant_id AND id = @id`,
          { tenant_id: req.tenant_id, id: util.entero(req.params.id, 0) }
        );
        if (!r2.rowsAffected[0]) throw error(404, 'No se encontró ese registro.');
        await auditoria.anotar(req, 'config.' + nombre + '.desactivar', { entidad: nombre, entidad_id: req.params.id });
        responder(res, { desactivado: true });
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Personalizacion institucional                                       */
  /* ------------------------------------------------------------------ */

  r.get(
    '/personalizacion',
    conSesion,
    permiso('config.ver'),
    asincrono(async (req, res) => {
      const t = await mantenimiento.porId(req.tenant_id);
      responder(res, {
        institucion: {
          codigo: t.codigo,
          nombre: t.nombre,
          nombre_comercial: t.nombre_comercial,
          logo_url: t.logo_url,
          color_primario: t.color_primario,
          color_secundario: t.color_secundario,
          color_acento: t.color_acento,
          color_texto: t.color_texto,
          tipografia: t.tipografia,
          texto_gafete: t.texto_gafete,
          contacto_nombre: t.contacto_nombre,
          contacto_correo: t.contacto_correo,
          contacto_telefono: t.contacto_telefono,
          zona_horaria: t.zona_horaria,
        },
        marca: await mantenimiento.marca(req.tenant_id),
      });
    })
  );

  r.patch(
    '/personalizacion',
    conSesion,
    permiso('personalizacion.editar'),
    asincrono(async (req, res) => {
      const d = req.body || {};
      const cambios = {};

      if (d.nombre !== undefined) cambios.nombre = util.limpiar(d.nombre, 200);
      if (d.nombre_comercial !== undefined) cambios.nombre_comercial = util.limpiar(d.nombre_comercial, 200);
      if (d.texto_gafete !== undefined) cambios.texto_gafete = util.limpiar(d.texto_gafete, 300);
      if (d.tipografia !== undefined) cambios.tipografia = util.limpiar(d.tipografia, 60);
      if (d.contacto_nombre !== undefined) cambios.contacto_nombre = util.limpiar(d.contacto_nombre, 160);
      if (d.contacto_correo !== undefined) cambios.contacto_correo = util.correo(d.contacto_correo);
      if (d.contacto_telefono !== undefined) cambios.contacto_telefono = util.limpiar(d.contacto_telefono, 40);
      // Los colores se validan: un color invalido rompería el contraste de toda
      // la interfaz, así que se rechaza en vez de aceptarlo tal cual.
      for (const [campo, actual] of [
        ['color_primario', '#1e3a8a'],
        ['color_secundario', '#f59e0b'],
        ['color_acento', '#0ea5e9'],
        ['color_texto', '#0f172a'],
      ]) {
        if (d[campo] === undefined) continue;
        const c = util.color(d[campo], null);
        if (!c) throw error(400, 'El color "' + campo + '" no es un color válido (use #RRGGBB).');
        cambios[campo] = c;
      }

      if (!Object.keys(cambios).length) throw error(400, 'No hay nada que cambiar.');

      const campos = Object.keys(cambios).map((c) => c + ' = @' + c).join(', ');
      await bd.consultar(
        `UPDATE vf_tenants SET ${campos}, actualizado = SYSDATETIMEOFFSET() WHERE id = @id`,
        Object.assign({ id: req.tenant_id }, cambios)
      );
      await auditoria.anotar(req, 'personalizacion.editar', {
        entidad: 'tenant',
        entidad_id: req.tenant_id,
        detalle: Object.keys(cambios).join(', '),
      });
      responder(res, { marca: await mantenimiento.marca(req.tenant_id) });
    })
  );

  /**
   * Carga del logo. Se acepta una imagen en base64 y se guarda en disco, servida
   * despues como archivo estatico. Se valida el tipo real por los primeros bytes,
   * no por la extension: una extension se puede escribir a mano.
   */
  r.post(
    '/personalizacion/logo',
    conSesion,
    permiso('personalizacion.editar'),
    asincrono(async (req, res) => {
      const { imagen, tipo } = req.body || {};
      if (!imagen) throw error(400, 'No llegó ninguna imagen.');

      const limpio = String(imagen).replace(/^data:image\/[a-z+]+;base64,/i, '');
      const buffer = Buffer.from(limpio, 'base64');
      if (!buffer.length) throw error(400, 'La imagen llegó vacía.');
      if (buffer.length > config.archivos.maxLogoBytes) {
        throw error(400, 'El logo no puede pasar de ' + Math.round(config.archivos.maxLogoBytes / 1024) + ' KB.');
      }

      const formato = detectarImagen(buffer);
      if (!formato) throw error(400, 'El archivo no es una imagen PNG, JPEG, GIF ni WEBP.');

      const fs = require('fs');
      const carpeta = path.join(config.archivos.carpeta, 'logos');
      fs.mkdirSync(carpeta, { recursive: true });

      const nombre = 'logo-' + req.tenant_id + '-' + Date.now() + '.' + formato.extension;
      fs.writeFileSync(path.join(carpeta, nombre), buffer);

      const url = '/archivos/logos/' + nombre;
      await bd.consultar('UPDATE vf_tenants SET logo_url = @url, logo_archivo = @archivo WHERE id = @id', {
        id: req.tenant_id,
        url,
        archivo: nombre,
      });
      await auditoria.anotar(req, 'personalizacion.logo', { entidad: 'tenant', entidad_id: req.tenant_id, detalle: nombre });
      responder(res, { logo_url: url, marca: await mantenimiento.marca(req.tenant_id) }, 201);
    })
  );

  r.delete(
    '/personalizacion/logo',
    conSesion,
    permiso('personalizacion.editar'),
    asincrono(async (req, res) => {
      await bd.consultar("UPDATE vf_tenants SET logo_url = NULL, logo_archivo = NULL WHERE id = @id", { id: req.tenant_id });
      await auditoria.anotar(req, 'personalizacion.logo.quitar', { entidad: 'tenant', entidad_id: req.tenant_id });
      responder(res, { marca: await mantenimiento.marca(req.tenant_id) });
    })
  );

  /* ================================================================== */
  /* Usuarios y permisos                                                */
  /* ================================================================== */

  r.get(
    '/usuarios',
    conSesion,
    permiso('usuarios.ver'),
    asincrono(async (req, res) => {
      const r2 = await bd.consultar(
        `SELECT u.id, u.correo, u.nombre, u.rol, u.telefono, u.sede_id, u.activo, u.ultimo_acceso,
                u.ultima_ip, u.creado, s.nombre AS sede
           FROM vf_usuarios u
           LEFT JOIN vf_sedes s ON s.id = u.sede_id
          WHERE u.tenant_id = @tenant_id
          ORDER BY u.activo DESC, u.nombre`,
        { tenant_id: req.tenant_id }
      );
      const roles = await Promise.all(
        permisos.ROLES_VALIDOS.map(async (rol) => ({
          rol,
          nombre: permisos.NOMBRE_ROL[rol],
          permisos: await auth.permisosDe(req.tenant_id, rol),
        }))
      );
      const estado = gestor.estado();
      responder(res, {
        usuarios: r2.recordset.map((u) => ({
          id: u.id,
          correo: u.correo,
          nombre: u.nombre,
          rol: u.rol,
          rol_nombre: permisos.NOMBRE_ROL[u.rol] || u.rol,
          telefono: u.telefono,
          sede_id: u.sede_id,
          sede: u.sede,
          activo: Boolean(u.activo),
          ultimo_acceso: u.ultimo_acceso,
          ultimo_acceso_legible: util.fechaLegible(u.ultimo_acceso),
          ultima_ip: u.ultima_ip,
          creado: u.creado,
        })),
        permisos: permisos.PERMISOS,
        grupos: permisos.GRUPOS,
        roles,
        limite: estado.licencia ? estado.licencia.limites.usuarios : null,
      });
    })
  );

  r.post(
    '/usuarios',
    conSesion,
    permiso('usuarios.editar'),
    asincrono(async (req, res) => {
      const d = req.body || {};
      const correo = util.correo(d.correo);
      if (!correo) throw error(400, 'El correo no es válido.');
      const nombre = util.limpiar(d.nombre, 160);
      if (!nombre) throw error(400, 'El nombre es obligatorio.');
      const rol = permisos.ROLES_VALIDOS.includes(d.rol) ? d.rol : 'operator';
      const problemas = auth.revisarClave(d.clave);
      if (problemas.length) throw error(400, 'La contraseña ' + problemas.join(', ') + '.');

      // Limite de la licencia: no se pueden crear mas usuarios de los permitidos.
      const cabe = await acceso.cabeUsuario(gestor, req.tenant_id);
      if (!cabe.ok) throw error(402, cabe.motivo);

      const existe = await bd.consultar('SELECT id FROM vf_usuarios WHERE tenant_id = @tenant_id AND correo = @correo', {
        tenant_id: req.tenant_id,
        correo,
      });
      if (existe.recordset.length) throw error(409, 'Ya existe un usuario con ese correo en esta institución.');

      const hash = await auth.cifrarClave(d.clave);
      const r2 = await bd.consultar(
        `INSERT INTO vf_usuarios (tenant_id, correo, clave_hash, nombre, rol, telefono, sede_id, activo)
         OUTPUT INSERTED.id
         VALUES (@tenant_id, @correo, @hash, @nombre, @rol, @telefono, @sede_id, 1)`,
        {
          tenant_id: req.tenant_id,
          correo,
          hash,
          nombre,
          rol,
          telefono: util.limpiar(d.telefono, 40),
          sede_id: d.sede_id ? util.entero(d.sede_id, 0) : null,
        }
      );
      await auditoria.anotar(req, 'usuario.crear', { entidad: 'usuario', entidad_id: r2.recordset[0].id, detalle: correo + ' (' + rol + ')' });
      responder(res, { id: r2.recordset[0].id }, 201);
    })
  );

  r.patch(
    '/usuarios/:id',
    conSesion,
    permiso('usuarios.editar'),
    asincrono(async (req, res) => {
      const d = req.body || {};
      const id = util.entero(req.params.id, 0);
      const actual = await bd.consultar('SELECT id, rol, activo FROM vf_usuarios WHERE tenant_id = @tenant_id AND id = @id', {
        tenant_id: req.tenant_id,
        id,
      });
      if (!actual.recordset.length) throw error(404, 'No se encontró ese usuario.');

      // Un operador no puede desactivarse ni cambiarse el rol a si mismo: se
      // quedaria fuera del sistema sin querer.
      if (id === req.usuario.id) {
        if (d.activo === false || d.activo === 0) throw error(400, 'No puede desactivar su propio usuario.');
        if (d.rol && d.rol !== actual.recordset[0].rol) throw error(400, 'No puede cambiarse el rol a sí mismo.');
      }

      const cambios = {};
      if (d.nombre !== undefined) {
        const n = util.limpiar(d.nombre, 160);
        if (!n) throw error(400, 'El nombre no puede quedar vacío.');
        cambios.nombre = n;
      }
      if (d.correo !== undefined) {
        const c = util.correo(d.correo);
        if (!c) throw error(400, 'El correo no es válido.');
        cambios.correo = c;
      }
      if (d.rol !== undefined) {
        if (!permisos.ROLES_VALIDOS.includes(d.rol)) throw error(400, 'Rol desconocido: ' + d.rol);
        cambios.rol = d.rol;
      }
      if (d.telefono !== undefined) cambios.telefono = util.limpiar(d.telefono, 40);
      if (d.sede_id !== undefined) cambios.sede_id = d.sede_id ? util.entero(d.sede_id, 0) : null;
      if (d.activo !== undefined) cambios.activo = util.booleano(d.activo, true) ? 1 : 0;

      if (!Object.keys(cambios).length) throw error(400, 'No hay nada que cambiar.');

      // Si se reactiva un usuario, hay que respetar el limite de la licencia.
      if (cambios.activo === 1 && !actual.recordset[0].activo) {
        const cabe = await acceso.cabeUsuario(gestor, req.tenant_id);
        if (!cabe.ok) throw error(402, cabe.motivo);
      }

      const campos = Object.keys(cambios).map((c) => c + ' = @' + c).join(', ');
      await bd.consultar(
        `UPDATE vf_usuarios SET ${campos}, actualizado = SYSDATETIMEOFFSET() WHERE tenant_id = @tenant_id AND id = @id`,
        Object.assign({ tenant_id: req.tenant_id, id }, cambios)
      );
      await auditoria.anotar(req, 'usuario.editar', { entidad: 'usuario', entidad_id: id, detalle: Object.keys(cambios).join(', ') });
      responder(res, { actualizado: true });
    })
  );

  r.post(
    '/usuarios/:id/clave',
    conSesion,
    permiso('usuarios.editar'),
    asincrono(async (req, res) => {
      const id = util.entero(req.params.id, 0);
      const clave = (req.body || {}).clave;
      const problemas = auth.revisarClave(clave);
      if (problemas.length) throw error(400, 'La contraseña ' + problemas.join(', ') + '.');
      const hash = await auth.cifrarClave(clave);
      const r2 = await bd.consultar(
        `UPDATE vf_usuarios SET clave_hash = @hash, intentos = 0, bloqueado_hasta = NULL,
                reset_token = NULL, reset_expira = NULL, actualizado = SYSDATETIMEOFFSET()
          WHERE tenant_id = @tenant_id AND id = @id`,
        { tenant_id: req.tenant_id, id, hash }
      );
      if (!r2.rowsAffected[0]) throw error(404, 'No se encontró ese usuario.');
      await auditoria.anotar(req, 'usuario.clave', { entidad: 'usuario', entidad_id: id });
      responder(res, { actualizado: true });
    })
  );

  r.delete(
    '/usuarios/:id',
    conSesion,
    permiso('usuarios.editar'),
    asincrono(async (req, res) => {
      const id = util.entero(req.params.id, 0);
      if (id === req.usuario.id) throw error(400, 'No puede desactivar su propio usuario.');

      // No se puede dejar la institucion sin ningun administrador activo.
      const admins = await bd.consultar(
        "SELECT COUNT(*) AS n FROM vf_usuarios WHERE tenant_id = @tenant_id AND rol = 'admin' AND activo = 1 AND id <> @id",
        { tenant_id: req.tenant_id, id }
      );
      const objetivo = await bd.consultar('SELECT rol FROM vf_usuarios WHERE tenant_id = @tenant_id AND id = @id', {
        tenant_id: req.tenant_id,
        id,
      });
      if (!objetivo.recordset.length) throw error(404, 'No se encontró ese usuario.');
      if (objetivo.recordset[0].rol === 'admin' && admins.recordset[0].n === 0) {
        throw error(400, 'No puede dejar la institución sin ningún administrador activo.');
      }

      await bd.consultar(
        'UPDATE vf_usuarios SET activo = 0, actualizado = SYSDATETIMEOFFSET() WHERE tenant_id = @tenant_id AND id = @id',
        { tenant_id: req.tenant_id, id }
      );
      await auditoria.anotar(req, 'usuario.desactivar', { entidad: 'usuario', entidad_id: id });
      responder(res, { desactivado: true });
    })
  );

  /* ------------------------------------------------------------------ */
  /* Permisos por rol                                                    */
  /* ------------------------------------------------------------------ */

  r.put(
    '/usuarios/roles/:rol',
    conSesion,
    permiso('usuarios.editar'),
    asincrono(async (req, res) => {
      const rol = req.params.rol;
      if (!permisos.ROLES_VALIDOS.includes(rol)) throw error(400, 'Rol desconocido: ' + rol);
      if (rol === 'admin') {
        throw error(400, 'El rol administrador conserva todos los permisos por diseño, para no dejar el sistema sin acceso.');
      }
      const lista = Array.isArray((req.body || {}).permisos) ? req.body.permisos : [];
      const desconocidos = lista.filter((p) => !permisos.existe(p));
      if (desconocidos.length) throw error(400, 'Permisos desconocidos: ' + desconocidos.join(', '));

      await bd.transaccion(async (tx) => {
        await tx.consultar('DELETE FROM vf_rol_permisos WHERE tenant_id = @tenant_id AND rol = @rol', {
          tenant_id: req.tenant_id,
          rol,
        });
        for (const clave of lista) {
          await tx.consultar(
            'INSERT INTO vf_rol_permisos (tenant_id, rol, permiso) VALUES (@tenant_id, @rol, @permiso)',
            { tenant_id: req.tenant_id, rol, permiso: clave }
          );
        }
      });
      await auditoria.anotar(req, 'usuario.rol_permisos', {
        entidad: 'rol',
        entidad_id: rol,
        detalle: lista.length + ' permisos',
      });
      responder(res, { rol, permisos: lista });
    })
  );

  /* ------------------------------------------------------------------ */
  /* Auditoria                                                           */
  /* ------------------------------------------------------------------ */

  r.get(
    '/auditoria',
    conSesion,
    permiso('auditoria.ver'),
    asincrono(async (req, res) => {
      responder(res, {
        listado: await auditoria.consultar(req.tenant_id, req.query),
        acciones: await auditoria.acciones(req.tenant_id),
      });
    })
  );

  return r;
}

/** Toda la configuracion de una institucion en una sola respuesta. */
async function configuracionCompleta(tenantId) {
  const [ajustes, deps, motivos, cats, sedes, personas, plantillas, marca] = await Promise.all([
    mantenimiento.ajustes(tenantId),
    bd.consultar('SELECT * FROM vf_departamentos WHERE tenant_id = @tenant_id ORDER BY activo DESC, nombre', { tenant_id: tenantId }),
    bd.consultar('SELECT * FROM vf_motivos WHERE tenant_id = @tenant_id ORDER BY activo DESC, nombre', { tenant_id: tenantId }),
    bd.consultar('SELECT * FROM vf_categorias WHERE tenant_id = @tenant_id ORDER BY activo DESC, nombre', { tenant_id: tenantId }),
    bd.consultar('SELECT * FROM vf_sedes WHERE tenant_id = @tenant_id ORDER BY activo DESC, nombre', { tenant_id: tenantId }),
    /* Las personas vienen con el nombre del departamento ya resuelto: la pantalla
       lo muestra en la lista y no tiene que cruzarlo ella. */
    bd.consultar(
      `SELECT p.*, d.nombre AS departamento
         FROM vf_personas p
         LEFT JOIN vf_departamentos d ON d.id = p.departamento_id
        WHERE p.tenant_id = @tenant_id
        ORDER BY p.activo DESC, p.nombre`,
      { tenant_id: tenantId }
    ),
    gafete.plantillas(tenantId),
    mantenimiento.marca(tenantId),
  ]);

  const bool = (f, campos) => {
    const c = Object.assign({}, f);
    for (const campo of campos) if (campo in c) c[campo] = Boolean(c[campo]);
    return c;
  };

  return {
    ajustes: ajustes.detalle,
    valores: ajustes.valores,
    departamentos: deps.recordset,
    motivos: motivos.recordset.map((m) =>
      bool(m, ['avisa_anfitrion', 'exige_aprobacion', 'exige_documento', 'exige_vehiculo', 'exige_pertenencias', 'exige_temperatura', 'activo'])
    ),
    categorias: cats.recordset.map((c) => bool(c, ['exige_documento', 'activo'])),
    sedes: sedes.recordset.map((s) => bool(s, ['activo'])),
    personas: personas.recordset.map((p) => bool(p, ['recibe_visitas', 'activo'])),
    plantillas,
    marca,
  };
}

/**
 * El código de institución que venga en la petición, si viene.
 *
 * Devuelve cadena vacía cuando no viene, nunca null: `util.limpiar` devuelve
 * null para un valor vacío, y encadenarle .toLowerCase() revienta con un 500.
 * Ese error ya se coló una vez al quitar el selector de institución.
 */
function codigoPedido(valor) {
  const t = util.limpiar(valor, 80);
  return t ? String(t).toLowerCase() : '';
}

/**
 * La institución de ESTA instalación.
 *
 * Una instalación es de un solo cliente: su licencia dice quién es, y esa
 * licencia crea una única institución en la base. Por eso el acceso no necesita
 * preguntar cuál: la toma de aquí.
 *
 * Se resuelve en este orden:
 *   1. La licencia cargada (es la fuente de la verdad: dice qué cliente es).
 *   2. Si no hay licencia, la única institución que exista en la base.
 *   3. Si hay varias o ninguna, null: no se puede entrar y se dice por qué.
 *
 * El caso 3 importa: si por lo que sea hay dos instituciones, entrar "a la
 * primera" sería peor que no dejar entrar, porque el recepcionista podría
 * registrar visitas en la institución equivocada sin darse cuenta.
 */
async function tenantDeLaInstalacion() {
  try {
    const estado = gestor.estado();
    if (estado && estado.valida && estado.licencia && estado.licencia.tenant) {
      return String(estado.licencia.tenant).toLowerCase();
    }
  } catch (e) {
    /* si la licencia no se puede leer, se sigue con la base */
  }

  try {
    const r = await bd.consultar('SELECT codigo FROM vf_tenants WHERE estado = @e', { e: 'activo' });
    if (r.recordset.length === 1) return r.recordset[0].codigo;
  } catch (e) {
    /* la base puede no existir todavía */
  }

  return null;
}

/** Toma del cuerpo solo los campos declarados para ese catalogo. */
/* ------------------------------------------------------------------ */
/* Aviso al anfitrion                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resuelve a quién avisar y avisa.
 *
 * El recepcionista puede registrar la visita de dos formas, y aquí se atienden
 * las dos:
 *
 *   - Eligiendo a la persona del directorio: se avisa a esa persona, a su
 *     correo, y si no tiene correo se usa el del departamento.
 *   - Escribiendo el nombre a mano: se busca en el directorio por nombre
 *     exacto. Si está, se usa su correo. Si no está, se avisa al encargado del
 *     departamento, que es lo mejor que se puede hacer sin saber quién es.
 *
 * No se inventa un correo ni se falla si no hay a quién avisar: el aviso queda
 * guardado igual y se ve en la pantalla de Recepción.
 */
async function notificarAnfitrion(tenantId, visita) {
  if (!visita || !visita.id) return null;

  const nombre = util.limpiar(visita.visitado, 160);
  const deptoId = util.entero(visita.departamento_id, 0);

  // El departamento, que hace falta para el aviso y para las reglas.
  let depto = null;
  if (deptoId) {
    const d = await bd.consultar(
      'SELECT id, nombre, encargado, correo FROM vf_departamentos WHERE tenant_id = @t AND id = @id',
      { t: tenantId, id: deptoId }
    );
    depto = d.recordset[0] || null;
  }

  /* La persona del directorio. Se busca por el id si vino, y si no por el
     nombre exacto dentro del departamento. */
  let persona = null;
  const personaId = util.entero(visita.persona_id, 0);

  if (personaId) {
    const p = await bd.consultar(
      'SELECT id, nombre, cargo, correo FROM vf_personas WHERE tenant_id = @t AND id = @id',
      { t: tenantId, id: personaId }
    );
    persona = p.recordset[0] || null;
  }

  if (!persona && nombre) {
    const p = await bd.consultar(
      `SELECT TOP 1 id, nombre, cargo, correo
         FROM vf_personas
        WHERE tenant_id = @t AND activo = 1 AND nombre = @nombre
          ${deptoId ? 'AND (departamento_id = @depto OR departamento_id IS NULL)' : ''}
        ORDER BY CASE WHEN departamento_id = @depto THEN 0 ELSE 1 END`,
      { t: tenantId, nombre: nombre, depto: deptoId || null }
    );
    persona = p.recordset[0] || null;
  }

  return avisos.avisarDeVisita(tenantId, visita, persona, depto);
}

function tomarCampos(cuerpo, def) {  const d = cuerpo || {};
  const valores = {};
  for (const campo of def.campos) {
    if (d[campo] === undefined) continue;
    if ((def.booleanos || []).includes(campo)) {
      valores[campo] = util.booleano(d[campo], false) ? 1 : 0;
    } else if ((def.enteros || []).includes(campo)) {
      /* Una referencia a otra tabla, como el departamento de una persona.
         Vacio significa "sin departamento", y eso es null, no cero: cero no es
         un id valido y la clave ajena lo rechazaria. */
      const n = util.entero(d[campo], 0);
      valores[campo] = n > 0 ? n : null;
    } else {
      valores[campo] = util.limpiar(d[campo], 300);
    }
  }
  return valores;
}

/** Convierte los campos BIT a booleanos de verdad, para que el JSON sea limpio. */
function normalizarBooleanos(fila, campos) {
  const c = Object.assign({}, fila);
  for (const campo of campos || []) if (campo in c) c[campo] = Boolean(c[campo]);
  return c;
}

/** Identifica el formato real de una imagen por sus primeros bytes. */
function detectarImagen(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { formato: 'png', extension: 'png', tipo: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { formato: 'jpeg', extension: 'jpg', tipo: 'image/jpeg' };
  }
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return { formato: 'gif', extension: 'gif', tipo: 'image/gif' };
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { formato: 'webp', extension: 'webp', tipo: 'image/webp' };
  }
  // SVG: es texto, y se acepta porque los logos vectoriales son lo mas comun.
  const cabeza = buffer.slice(0, 400).toString('utf8').trim();
  if (cabeza.startsWith('<svg') || cabeza.startsWith('<?xml')) {
    return { formato: 'svg', extension: 'svg', tipo: 'image/svg+xml' };
  }
  return null;
}

module.exports = { rutas };

