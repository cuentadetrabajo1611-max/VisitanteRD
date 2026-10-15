/**
 * VisitaFlow - Lista de vigilancia (bloqueados y observados).
 *
 * La regla de oro: un registro de vigilancia NO se borra, se LEVANTA. Queda el
 * historial de que alguien estuvo bloqueado y por que, que es justo lo que hay
 * que poder demostrar despues.
 *
 * Y la otra: una cedula bloqueada NO puede registrar entrada sin que alguien
 * escriba expresamente por que la autoriza. Esa decision queda guardada.
 */
'use strict';

const bd = require('./db');
const util = require('./util');
const padron = require('./identidad/padron');

const TIPOS = ['bloqueado', 'observado'];
const SEVERIDADES = ['baja', 'media', 'alta'];

/**
 * Consulta la lista para una cedula concreta. Devuelve null si no hay nada.
 * Se llama en CADA validacion de identidad, asi que tiene que ser barata.
 */
async function consultarCedula(tenantId, cedula) {
  const d = padron.soloDigitos(cedula);
  if (!d) return null;

  const r = await bd.consultar(
    `SELECT id, cedula, nombre, tipo, motivo, severidad, autorizado_por, vigente_desde, vigente_hasta
       FROM vf_vigilancia
      WHERE tenant_id = @tenant_id AND cedula = @cedula AND activo = 1
        AND (vigente_hasta IS NULL OR vigente_hasta > SYSDATETIMEOFFSET())
      ORDER BY CASE tipo WHEN 'bloqueado' THEN 0 ELSE 1 END,
               CASE severidad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END`,
    { tenant_id: tenantId, cedula: d }
  );
  if (!r.recordset.length) return null;

  const registros = r.recordset.map((v) => ({
    id: v.id,
    cedula: v.cedula,
    cedula_formato: padron.formatear(v.cedula),
    nombre: v.nombre,
    tipo: v.tipo,
    motivo: v.motivo,
    severidad: v.severidad,
    autorizado_por: v.autorizado_por,
    vigente_desde: v.vigente_desde,
    vigente_hasta: v.vigente_hasta,
    vigente_hasta_legible: util.fechaLegible(v.vigente_hasta),
  }));

  const bloqueados = registros.filter((v) => v.tipo === 'bloqueado');
  const observados = registros.filter((v) => v.tipo === 'observado');

  return {
    hay: true,
    bloqueado: bloqueados.length > 0,
    observado: observados.length > 0,
    registros,
    // Resumen en una linea, que es lo que se pinta en la ficha del visitante.
    motivo: bloqueados.length ? bloqueados[0].motivo : observados.length ? observados[0].motivo : null,
    severidad: bloqueados.length ? bloqueados[0].severidad : observados.length ? observados[0].severidad : null,
    id: bloqueados.length ? bloqueados[0].id : observados.length ? observados[0].id : null,
  };
}

/** Lista con filtros, para la pantalla de vigilancia. */
async function listar(tenantId, filtros) {
  const f = filtros || {};
  const p = util.paginacion(f);
  const condiciones = ['v.tenant_id = @tenant_id'];
  const parametros = { tenant_id: tenantId };

  if (f.tipo && TIPOS.includes(f.tipo)) {
    condiciones.push('v.tipo = @tipo');
    parametros.tipo = f.tipo;
  }
  if (f.severidad && SEVERIDADES.includes(f.severidad)) {
    condiciones.push('v.severidad = @severidad');
    parametros.severidad = f.severidad;
  }
  // Por defecto solo los vigentes: el historial se pide a proposito.
  if (!util.booleano(f.historial, false)) {
    condiciones.push('v.activo = 1 AND (v.vigente_hasta IS NULL OR v.vigente_hasta > SYSDATETIMEOFFSET())');
  }
  if (f.texto) {
    condiciones.push('(v.cedula LIKE @texto OR v.nombre LIKE @texto OR v.motivo LIKE @texto)');
    parametros.texto = '%' + String(f.texto).trim() + '%';
  }

  const donde = condiciones.join(' AND ');
  const total = await bd.consultar(`SELECT COUNT(*) AS n FROM vf_vigilancia v WHERE ${donde}`, parametros);
  const filas = await bd.consultar(
    `SELECT v.id, v.cedula, v.nombre, v.tipo, v.motivo, v.severidad, v.autorizado_por,
            v.vigente_desde, v.vigente_hasta, v.activo, v.creado, v.levantado, v.levantado_por,
            v.levantado_motivo,
            (SELECT COUNT(*) FROM vf_vigilancia_avisos a WHERE a.vigilancia_id = v.id) AS avisos
       FROM vf_vigilancia v
      WHERE ${donde}
      ORDER BY CASE v.tipo WHEN 'bloqueado' THEN 0 ELSE 1 END,
               CASE v.severidad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
               v.creado DESC
     OFFSET @salto ROWS FETCH NEXT @tamano ROWS ONLY`,
    Object.assign({}, parametros, { salto: p.salto, tamano: p.tamano })
  );

  return {
    total: total.recordset[0].n,
    pagina: p.pagina,
    tamano: p.tamano,
    paginas: Math.max(1, Math.ceil(total.recordset[0].n / p.tamano)),
    filas: filas.recordset.map((v) => ({
      id: v.id,
      cedula: v.cedula,
      cedula_formato: padron.formatear(v.cedula),
      nombre: v.nombre,
      tipo: v.tipo,
      motivo: v.motivo,
      severidad: v.severidad,
      autorizado_por: v.autorizado_por,
      vigente_desde: v.vigente_desde,
      vigente_desde_legible: util.fechaLegible(v.vigente_desde),
      vigente_hasta: v.vigente_hasta,
      vigente_hasta_legible: util.fechaLegible(v.vigente_hasta),
      activo: Boolean(v.activo),
      creado: v.creado,
      creado_legible: util.fechaLegible(v.creado),
      levantado: v.levantado,
      levantado_legible: util.fechaLegible(v.levantado),
      levantado_por: v.levantado_por,
      levantado_motivo: v.levantado_motivo,
      avisos: v.avisos,
    })),
  };
}

/**
 * Agrega una cedula a la lista.
 * La cedula se verifica contra el padron antes de guardarla: bloquear por un
 * error de tecleo dejaria a una persona inocente sin poder entrar.
 */
async function agregar(tenantId, datos, req) {
  const d = datos || {};
  const cedula = padron.soloDigitos(d.cedula);
  const revision = padron.validarCedula(cedula);
  if (!revision.valida) return { ok: false, motivo: revision.motivo };

  const tipo = TIPOS.includes(d.tipo) ? d.tipo : 'observado';
  const motivo = util.limpiar(d.motivo, 400);
  if (!motivo) return { ok: false, motivo: 'Hay que escribir el motivo: es lo que verá recepción.' };

  const severidad = SEVERIDADES.includes(d.severidad) ? d.severidad : 'media';

  // Verificacion contra el padron (avisa, no impide: puede ser alguien que no
  // esta en el padron y aun asi deba bloquearse).
  const consulta = await padron.porCedula(cedula);
  const nombre = consulta.ciudadano ? consulta.ciudadano.nombre_completo : util.limpiar(d.nombre, 200);

  const existente = await bd.consultar(
    `SELECT id FROM vf_vigilancia
      WHERE tenant_id = @tenant_id AND cedula = @cedula AND activo = 1
        AND (vigente_hasta IS NULL OR vigente_hasta > SYSDATETIMEOFFSET())`,
    { tenant_id: tenantId, cedula }
  );
  if (existente.recordset.length) {
    return {
      ok: false,
      motivo: 'Esa cédula ya está en la lista de vigilancia.',
      id: existente.recordset[0].id,
      duplicado: true,
    };
  }

  const r = await bd.consultar(
    `INSERT INTO vf_vigilancia
       (tenant_id, cedula, nombre, tipo, motivo, severidad, autorizado_por, vigente_hasta)
     OUTPUT INSERTED.id
     VALUES (@tenant_id, @cedula, @nombre, @tipo, @motivo, @severidad, @autorizado_por, @vigente_hasta)`,
    {
      tenant_id: tenantId,
      cedula,
      nombre,
      tipo,
      motivo,
      severidad,
      autorizado_por: util.limpiar(d.autorizado_por, 160) || (req && req.usuario ? req.usuario.nombre : null),
      vigente_hasta: d.vigente_hasta || null,
    }
  );

  return {
    ok: true,
    id: r.recordset[0].id,
    en_padron: consulta.disponible && consulta.encontrado,
    nombre,
    aviso: consulta.disponible && !consulta.encontrado
      ? 'Esa cédula no aparece en la base de datos. Se agregó igualmente, con el nombre escrito a mano.'
      : null,
  };
}

/** Edita un registro vigente. */
async function editar(tenantId, id, datos) {
  const d = datos || {};
  const actual = await bd.consultar('SELECT id, activo FROM vf_vigilancia WHERE tenant_id = @tenant_id AND id = @id', {
    tenant_id: tenantId,
    id,
  });
  if (!actual.recordset.length) return { ok: false, motivo: 'No se encontró ese registro.' };

  const cambios = {};
  if (d.tipo && TIPOS.includes(d.tipo)) cambios.tipo = d.tipo;
  if (d.severidad && SEVERIDADES.includes(d.severidad)) cambios.severidad = d.severidad;
  if (d.motivo !== undefined) cambios.motivo = util.limpiar(d.motivo, 400);
  if (d.nombre !== undefined) cambios.nombre = util.limpiar(d.nombre, 200);
  if (d.autorizado_por !== undefined) cambios.autorizado_por = util.limpiar(d.autorizado_por, 160);
  if (d.vigente_hasta !== undefined) cambios.vigente_hasta = d.vigente_hasta || null;

  if (!Object.keys(cambios).length) return { ok: false, motivo: 'No hay nada que cambiar.' };
  if (cambios.motivo === null) return { ok: false, motivo: 'El motivo no puede quedar vacío.' };

  const campos = Object.keys(cambios).map((c) => c + ' = @' + c).join(', ');
  await bd.consultar(
    `UPDATE vf_vigilancia SET ${campos} WHERE tenant_id = @tenant_id AND id = @id`,
    Object.assign({ tenant_id: tenantId, id }, cambios)
  );
  return { ok: true };
}

/**
 * Levanta un registro. No se borra: se marca quién lo levantó, cuándo y por qué.
 */
async function levantar(tenantId, id, datos, req) {
  const d = datos || {};
  const motivo = util.limpiar(d.motivo, 400);
  if (!motivo) return { ok: false, motivo: 'Indique por qué se levanta el registro.' };

  const r = await bd.consultar(
    `UPDATE vf_vigilancia
        SET activo = 0, levantado = SYSDATETIMEOFFSET(), levantado_por = @quien, levantado_motivo = @motivo
      WHERE tenant_id = @tenant_id AND id = @id AND activo = 1`,
    {
      tenant_id: tenantId,
      id,
      quien: req && req.usuario ? req.usuario.nombre : null,
      motivo,
    }
  );
  if (!r.rowsAffected[0]) return { ok: false, motivo: 'Ese registro ya estaba levantado o no existe.' };
  return { ok: true };
}

/** Registra que se mostro un aviso y que decidio recepcion. */
async function registrarAviso(req, datos) {
  const d = datos || {};
  await bd.consultar(
    `INSERT INTO vf_vigilancia_avisos (tenant_id, vigilancia_id, cedula, visita_id, decision, motivo, operador)
     VALUES (@tenant_id, @vigilancia_id, @cedula, @visita_id, @decision, @motivo, @operador)`,
    {
      tenant_id: req.tenant_id,
      vigilancia_id: d.vigilancia_id || null,
      cedula: padron.soloDigitos(d.cedula),
      visita_id: d.visita_id || null,
      decision: ['avisado', 'permitido', 'denegado'].includes(d.decision) ? d.decision : 'avisado',
      motivo: util.limpiar(d.motivo, 400),
      operador: req.usuario ? req.usuario.nombre : null,
    }
  );
}

/** Bitacora de avisos mostrados. */
async function avisos(tenantId, filtros) {
  const f = filtros || {};
  const p = util.paginacion(f);
  const condiciones = ['a.tenant_id = @tenant_id'];
  const parametros = { tenant_id: tenantId };

  if (f.cedula) {
    condiciones.push('a.cedula = @cedula');
    parametros.cedula = padron.soloDigitos(f.cedula);
  }
  if (f.decision) {
    condiciones.push('a.decision = @decision');
    parametros.decision = f.decision;
  }
  if (f.desde) {
    condiciones.push('a.creado >= @desde');
    parametros.desde = f.desde;
  }
  if (f.hasta) {
    condiciones.push('a.creado < DATEADD(day, 1, @hasta)');
    parametros.hasta = f.hasta;
  }

  const donde = condiciones.join(' AND ');
  const total = await bd.consultar(`SELECT COUNT(*) AS n FROM vf_vigilancia_avisos a WHERE ${donde}`, parametros);
  const filas = await bd.consultar(
    `SELECT a.id, a.cedula, a.decision, a.motivo, a.operador, a.creado, a.visita_id,
            v.codigo AS visita_codigo, v.nombre_completo
       FROM vf_vigilancia_avisos a
       LEFT JOIN vf_visitas v ON v.id = a.visita_id
      WHERE ${donde}
      ORDER BY a.creado DESC
     OFFSET @salto ROWS FETCH NEXT @tamano ROWS ONLY`,
    Object.assign({}, parametros, { salto: p.salto, tamano: p.tamano })
  );

  return {
    total: total.recordset[0].n,
    pagina: p.pagina,
    filas: filas.recordset.map((a) => ({
      id: a.id,
      cedula: a.cedula,
      cedula_formato: padron.formatear(a.cedula),
      nombre: a.nombre_completo,
      decision: a.decision,
      motivo: a.motivo,
      operador: a.operador,
      visita_id: a.visita_id,
      visita_codigo: a.visita_codigo,
      fecha: a.creado,
      fecha_legible: util.fechaLegible(a.creado),
    })),
  };
}

/** Metricas de la pantalla de vigilancia. */
async function resumen(tenantId) {
  const r = await bd.consultar(
    `SELECT
        SUM(CASE WHEN tipo = 'bloqueado' THEN 1 ELSE 0 END) AS bloqueados,
        SUM(CASE WHEN tipo = 'observado' THEN 1 ELSE 0 END) AS observados,
        SUM(CASE WHEN severidad = 'alta' THEN 1 ELSE 0 END) AS alta,
        (SELECT COUNT(*) FROM vf_vigilancia_avisos a
          WHERE a.tenant_id = @tenant_id AND a.creado >= DATEADD(day, -7, SYSDATETIMEOFFSET())) AS avisos_semana,
        (SELECT COUNT(*) FROM vf_vigilancia_avisos a
          WHERE a.tenant_id = @tenant_id AND a.decision = 'permitido'
            AND a.creado >= DATEADD(day, -30, SYSDATETIMEOFFSET())) AS permitidos_mes
       FROM vf_vigilancia
      WHERE tenant_id = @tenant_id AND activo = 1
        AND (vigente_hasta IS NULL OR vigente_hasta > SYSDATETIMEOFFSET())`,
    { tenant_id: tenantId }
  );
  const d = r.recordset[0] || {};
  return {
    bloqueados: d.bloqueados || 0,
    observados: d.observados || 0,
    severidad_alta: d.alta || 0,
    avisos_semana: d.avisos_semana || 0,
    permitidos_mes: d.permitidos_mes || 0,
  };
}

module.exports = {
  TIPOS,
  SEVERIDADES,
  consultarCedula,
  listar,
  agregar,
  editar,
  levantar,
  registrarAviso,
  avisos,
  resumen,
};
