/**
 * VisitaFlow - Auditoria.
 *
 * Toda accion que cambia algo o que expone datos personales queda anotada.
 * Se escribe en la misma transaccion logica que la accion, pero sin bloquearla:
 * si la auditoria falla, la operacion de recepcion no se cae.
 */
'use strict';

const config = require('./config');
const bd = require('./db');
const util = require('./util');

/**
 * Anota una accion.
 * @param {object} req      Peticion, para sacar usuario, institucion e IP.
 * @param {string} accion   Verbo corto: 'visita.registrar', 'usuario.crear'...
 * @param {object} datos    { entidad, entidad_id, detalle }
 */
async function anotar(req, accion, datos) {
  if (!config.auditoria.activa) return;
  const d = datos || {};
  const usuario = req && req.usuario ? req.usuario : null;
  const tenantId = req && req.tenant_id ? req.tenant_id : null;

  try {
    await bd.consultar(
      `INSERT INTO vf_auditoria (tenant_id, usuario_id, usuario, accion, entidad, entidad_id, detalle, ip, agente)
       VALUES (@tenant_id, @usuario_id, @usuario, @accion, @entidad, @entidad_id, @detalle, @ip, @agente)`,
      {
        tenant_id: tenantId,
        usuario_id: usuario ? usuario.id : null,
        usuario: usuario ? usuario.nombre : d.usuario || null,
        accion: util.limpiar(accion, 60),
        entidad: util.limpiar(d.entidad, 60),
        entidad_id: d.entidad_id !== undefined && d.entidad_id !== null ? String(d.entidad_id).slice(0, 60) : null,
        detalle: util.limpiar(d.detalle, 800),
        ip: req ? util.ip(req) : null,
        agente: req ? util.agente(req) : null,
      }
    );
  } catch (e) {
    console.error('[auditoria] no se pudo anotar', accion, e.message);
  }
}

/**
 * Consulta la bitacora de una institucion, con filtros.
 */
async function consultar(tenantId, filtros) {
  const f = filtros || {};
  const p = util.paginacion(f);
  const condiciones = ['tenant_id = @tenant_id'];
  const parametros = { tenant_id: tenantId };

  if (f.accion) {
    condiciones.push('accion = @accion');
    parametros.accion = f.accion;
  }
  if (f.usuario) {
    condiciones.push('usuario LIKE @usuario');
    parametros.usuario = '%' + f.usuario + '%';
  }
  if (f.desde) {
    condiciones.push('creado >= @desde');
    parametros.desde = f.desde;
  }
  if (f.hasta) {
    condiciones.push('creado < DATEADD(day, 1, @hasta)');
    parametros.hasta = f.hasta;
  }
  if (f.texto) {
    condiciones.push('(detalle LIKE @texto OR entidad LIKE @texto OR accion LIKE @texto)');
    parametros.texto = '%' + f.texto + '%';
  }

  const donde = condiciones.join(' AND ');
  const total = await bd.consultar(`SELECT COUNT(*) AS n FROM vf_auditoria WHERE ${donde}`, parametros);
  const filas = await bd.consultar(
    `SELECT id, usuario, accion, entidad, entidad_id, detalle, ip, creado
       FROM vf_auditoria
      WHERE ${donde}
      ORDER BY creado DESC, id DESC
     OFFSET @salto ROWS FETCH NEXT @tamano ROWS ONLY`,
    Object.assign({}, parametros, { salto: p.salto, tamano: p.tamano })
  );

  return {
    total: total.recordset[0].n,
    pagina: p.pagina,
    tamano: p.tamano,
    filas: filas.recordset.map((f2) => ({
      id: f2.id,
      usuario: f2.usuario,
      accion: f2.accion,
      entidad: f2.entidad,
      entidad_id: f2.entidad_id,
      detalle: f2.detalle,
      ip: f2.ip,
      fecha: f2.creado,
      fecha_legible: util.fechaLegible(f2.creado),
    })),
  };
}

/** Acciones distintas registradas, para el filtro de la pantalla. */
async function acciones(tenantId) {
  const r = await bd.consultar(
    'SELECT DISTINCT accion FROM vf_auditoria WHERE tenant_id = @tenant_id ORDER BY accion',
    { tenant_id: tenantId }
  );
  return r.recordset.map((f) => f.accion);
}

/** Borra la bitacora mas vieja que la retencion configurada. */
async function limpiar() {
  const dias = config.auditoria.diasRetencion;
  if (!dias || dias <= 0) return { borradas: 0 };
  const r = await bd.consultar('DELETE FROM vf_auditoria WHERE creado < DATEADD(day, -@dias, SYSDATETIMEOFFSET())', {
    dias,
  });
  return { borradas: r.rowsAffected[0] || 0, dias };
}

module.exports = { anotar, consultar, acciones, limpiar };
