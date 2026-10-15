/**
 * VisitaFlow - Pre-registro de visitas.
 *
 * El anfitrion anuncia la visita antes de que la persona llegue, con un codigo
 * de confirmacion que se puede dictar por telefono. Cuando el visitante llega,
 * recepcion lo busca por el codigo o por la cedula y el formulario se completa
 * solo: no se teclea dos veces lo que ya se sabia.
 *
 * La cedula es opcional al anunciar (a veces solo se conoce el nombre) y se
 * exige al hacer el check-in, que es cuando se valida contra el padron.
 */
'use strict';

const bd = require('./db');
const util = require('./util');
const padron = require('./identidad/padron');
const visitas = require('./visitas');
const auditoria = require('./auditoria');

/**
 * Convierte una fecha del navegador a Date, o null.
 *
 * El campo <input type="datetime-local"> devuelve "2026-10-16T14:51" (sin
 * segundos ni zona). SQL Server NO puede convertir ese texto a datetime, asi
 * que hay que convertirlo aqui: si se pasa el texto tal cual, el alta falla con
 * "Conversion failed when converting date and/or time from character string".
 */
function aFecha(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Crea un pre-registro y devuelve su codigo. */
async function crear(tenantId, datos, req) {
  const d = datos || {};
  const nombre = util.limpiar(d.nombre_completo, 200);
  if (!nombre) return { ok: false, motivo: 'Indique el nombre de la persona que va a venir.' };

  const cedula = padron.soloDigitos(d.cedula);
  if (cedula && !padron.validarCedula(cedula).valida) {
    return { ok: false, motivo: 'La cédula no es válida: ' + padron.validarCedula(cedula).motivo };
  }

  const fechaPrevista = aFecha(d.fecha_prevista);
  if (d.fecha_prevista && !fechaPrevista) {
    return { ok: false, motivo: 'La fecha prevista no es válida.' };
  }

  const ajustes = await visitas.ajustesDe(tenantId);
  const horas = util.entero(ajustes.preregistro_vigencia_horas, 24, 1, 24 * 30);
  const vence = new Date(Date.now() + horas * 3600000);

  // El codigo se genera y se comprueba que no choque con otro vigente.
  let codigo = null;
  for (let intento = 0; intento < 8 && !codigo; intento++) {
    const candidato = util.codigoLegible(ajustes.codigo_prefijo || 'VF');
    const choque = await bd.consultar(
      'SELECT 1 AS x FROM vf_preregistros WHERE tenant_id = @tenant_id AND codigo = @codigo',
      { tenant_id: tenantId, codigo: candidato }
    );
    if (!choque.recordset.length) codigo = candidato;
  }
  if (!codigo) return { ok: false, motivo: 'No se pudo generar un código único. Intente de nuevo.' };

  const r = await bd.consultar(
    `INSERT INTO vf_preregistros
       (tenant_id, codigo, cedula, nombre_completo, empresa, telefono, correo, departamento_id,
        motivo_id, visitado, fecha_prevista, acompanantes, vehiculo, notas, creado_por, vence)
     OUTPUT INSERTED.id
     VALUES
       (@tenant_id, @codigo, @cedula, @nombre, @empresa, @telefono, @correo, @departamento_id,
        @motivo_id, @visitado, @fecha_prevista, @acompanantes, @vehiculo, @notas, @creado_por, @vence)`,
    {
      tenant_id: tenantId,
      codigo,
      cedula: cedula || null,
      nombre,
      empresa: util.limpiar(d.empresa, 200),
      telefono: util.limpiar(d.telefono, 40),
      correo: util.correo(d.correo),
      departamento_id: d.departamento_id ? util.entero(d.departamento_id, 0) : null,
      motivo_id: d.motivo_id ? util.entero(d.motivo_id, 0) : null,
      visitado: util.limpiar(d.visitado, 160),
      fecha_prevista: fechaPrevista,
      acompanantes: util.entero(d.acompanantes, 0, 0, 50),
      vehiculo: util.limpiar(d.vehiculo, 60),
      notas: util.limpiar(d.notas, 600),
      creado_por: req && req.usuario ? req.usuario.nombre : null,
      vence,
    }
  );

  await auditoria.anotar(req, 'preregistro.crear', {
    entidad: 'preregistro',
    entidad_id: r.recordset[0].id,
    detalle: nombre + ' (' + codigo + ') vence ' + vence.toISOString().slice(0, 16),
  });

  return { ok: true, id: r.recordset[0].id, codigo, vence, vigencia_horas: horas };
}

/**
 * Marca como vencidos los pre-registros cuya vigencia paso.
 * Se ejecuta al listar, para no necesitar un proceso aparte.
 */
async function vencer(tenantId) {
  const r = await bd.consultar(
    `UPDATE vf_preregistros SET estado = 'vencido'
      WHERE tenant_id = @tenant_id AND estado = 'pendiente' AND vence IS NOT NULL AND vence < SYSDATETIMEOFFSET()`,
    { tenant_id: tenantId }
  );
  return r.rowsAffected[0] || 0;
}

/** Lista con filtros. */
async function listar(tenantId, filtros) {
  const f = filtros || {};
  await vencer(tenantId);

  const p = util.paginacion(f);
  const condiciones = ['p.tenant_id = @tenant_id'];
  const parametros = { tenant_id: tenantId };

  if (f.estado) {
    condiciones.push('p.estado = @estado');
    parametros.estado = f.estado;
  }
  if (f.desde) {
    condiciones.push('p.fecha_prevista >= @desde');
    parametros.desde = f.desde;
  }
  if (f.hasta) {
    condiciones.push('p.fecha_prevista < DATEADD(day, 1, @hasta)');
    parametros.hasta = f.hasta;
  }
  if (f.departamento_id) {
    condiciones.push('p.departamento_id = @departamento_id');
    parametros.departamento_id = util.entero(f.departamento_id, 0);
  }
  if (f.texto) {
    condiciones.push('(p.nombre_completo LIKE @texto OR p.codigo LIKE @texto OR p.cedula LIKE @texto OR p.empresa LIKE @texto OR p.visitado LIKE @texto)');
    parametros.texto = '%' + String(f.texto).trim() + '%';
  }

  const donde = condiciones.join(' AND ');
  const total = await bd.consultar(`SELECT COUNT(*) AS n FROM vf_preregistros p WHERE ${donde}`, parametros);
  const filas = await bd.consultar(
    `SELECT p.*, d.nombre AS departamento, m.nombre AS motivo, s.zona_horaria
       FROM vf_preregistros p
       LEFT JOIN vf_departamentos d ON d.id = p.departamento_id
       LEFT JOIN vf_motivos m ON m.id = p.motivo_id
       JOIN vf_tenants s ON s.id = p.tenant_id
      WHERE ${donde}
      ORDER BY CASE p.estado WHEN 'pendiente' THEN 0 ELSE 1 END, p.fecha_prevista DESC, p.creado DESC
     OFFSET @salto ROWS FETCH NEXT @tamano ROWS ONLY`,
    Object.assign({}, parametros, { salto: p.salto, tamano: p.tamano })
  );

  return {
    total: total.recordset[0].n,
    pagina: p.pagina,
    paginas: Math.max(1, Math.ceil(total.recordset[0].n / p.tamano)),
    filas: filas.recordset.map((p2) => ({
      id: p2.id,
      codigo: p2.codigo,
      cedula: p2.cedula,
      cedula_formato: p2.cedula ? padron.formatear(p2.cedula) : null,
      nombre: p2.nombre_completo,
      empresa: p2.empresa,
      telefono: p2.telefono,
      correo: p2.correo,
      departamento: p2.departamento,
      motivo: p2.motivo,
      visitado: p2.visitado,
      fecha_prevista: p2.fecha_prevista,
      fecha_prevista_legible: util.fechaLegible(p2.fecha_prevista, p2.zona_horaria),
      acompanantes: p2.acompanantes,
      vehiculo: p2.vehiculo,
      notas: p2.notas,
      estado: p2.estado,
      visita_id: p2.visita_id,
      creado: p2.creado,
      creado_por: p2.creado_por,
      vence: p2.vence,
      vence_legible: util.fechaLegible(p2.vence, p2.zona_horaria),
    })),
  };
}

/** Busca un pre-registro por su codigo. */
async function porCodigo(tenantId, codigo) {
  const c = util.limpiar(codigo, 20);
  if (!c) return null;
  await vencer(tenantId);
  const r = await bd.consultar(
    `SELECT p.*, d.nombre AS departamento, m.nombre AS motivo
       FROM vf_preregistros p
       LEFT JOIN vf_departamentos d ON d.id = p.departamento_id
       LEFT JOIN vf_motivos m ON m.id = p.motivo_id
      WHERE p.tenant_id = @tenant_id AND p.codigo = @codigo`,
    { tenant_id: tenantId, codigo: c.toUpperCase() }
  );
  return r.recordset[0] || null;
}

/** Edita un pre-registro pendiente. */
async function editar(tenantId, id, datos) {
  const d = datos || {};
  const actual = await bd.consultar('SELECT id, estado FROM vf_preregistros WHERE tenant_id = @tenant_id AND id = @id', {
    tenant_id: tenantId,
    id,
  });
  if (!actual.recordset.length) return { ok: false, motivo: 'No se encontró ese pre-registro.' };
  if (actual.recordset[0].estado !== 'pendiente') {
    return { ok: false, motivo: 'Solo se pueden editar los pre-registros pendientes.' };
  }

  const cambios = {};
  if (d.nombre_completo !== undefined) {
    const n = util.limpiar(d.nombre_completo, 200);
    if (!n) return { ok: false, motivo: 'El nombre no puede quedar vacío.' };
    cambios.nombre_completo = n;
  }
  if (d.cedula !== undefined) {
    const c = padron.soloDigitos(d.cedula);
    if (c && !padron.validarCedula(c).valida) return { ok: false, motivo: 'La cédula no es válida.' };
    cambios.cedula = c || null;
  }
  if (d.empresa !== undefined) cambios.empresa = util.limpiar(d.empresa, 200);
  if (d.telefono !== undefined) cambios.telefono = util.limpiar(d.telefono, 40);
  if (d.correo !== undefined) cambios.correo = util.correo(d.correo);
  if (d.departamento_id !== undefined) cambios.departamento_id = d.departamento_id ? util.entero(d.departamento_id, 0) : null;
  if (d.motivo_id !== undefined) cambios.motivo_id = d.motivo_id ? util.entero(d.motivo_id, 0) : null;
  if (d.visitado !== undefined) cambios.visitado = util.limpiar(d.visitado, 160);
  if (d.fecha_prevista !== undefined) {
    const f = aFecha(d.fecha_prevista);
    if (d.fecha_prevista && !f) return { ok: false, motivo: 'La fecha prevista no es válida.' };
    cambios.fecha_prevista = f;
  }
  if (d.acompanantes !== undefined) cambios.acompanantes = util.entero(d.acompanantes, 0, 0, 50);
  if (d.vehiculo !== undefined) cambios.vehiculo = util.limpiar(d.vehiculo, 60);
  if (d.notas !== undefined) cambios.notas = util.limpiar(d.notas, 600);

  if (!Object.keys(cambios).length) return { ok: false, motivo: 'No hay nada que cambiar.' };

  const campos = Object.keys(cambios).map((c) => c + ' = @' + c).join(', ');
  await bd.consultar(`UPDATE vf_preregistros SET ${campos} WHERE tenant_id = @tenant_id AND id = @id`, Object.assign({ tenant_id: tenantId, id }, cambios));
  return { ok: true };
}

/** Cancela un pre-registro. */
async function cancelar(tenantId, id, req) {
  const r = await bd.consultar(
    `UPDATE vf_preregistros SET estado = 'cancelado'
      WHERE tenant_id = @tenant_id AND id = @id AND estado = 'pendiente'`,
    { tenant_id: tenantId, id }
  );
  if (!r.rowsAffected[0]) return { ok: false, motivo: 'Ese pre-registro no está pendiente.' };
  await auditoria.anotar(req, 'preregistro.cancelar', { entidad: 'preregistro', entidad_id: id });
  return { ok: true };
}

/** Metricas de la pantalla de pre-registro. */
async function resumen(tenantId) {
  await vencer(tenantId);
  const r = await bd.consultar(
    `SELECT
        SUM(CASE WHEN estado = 'pendiente' THEN 1 ELSE 0 END) AS pendientes,
        SUM(CASE WHEN estado = 'pendiente' AND CAST(fecha_prevista AS date) = CAST(SYSDATETIMEOFFSET() AS date) THEN 1 ELSE 0 END) AS hoy,
        SUM(CASE WHEN estado = 'usado' THEN 1 ELSE 0 END) AS usados,
        SUM(CASE WHEN estado = 'vencido' THEN 1 ELSE 0 END) AS vencidos,
        SUM(CASE WHEN estado = 'cancelado' THEN 1 ELSE 0 END) AS cancelados
       FROM vf_preregistros WHERE tenant_id = @tenant_id`,
    { tenant_id: tenantId }
  );
  const d = r.recordset[0] || {};
  return {
    pendientes: d.pendientes || 0,
    hoy: d.hoy || 0,
    usados: d.usados || 0,
    vencidos: d.vencidos || 0,
    cancelados: d.cancelados || 0,
  };
}

module.exports = { crear, listar, porCodigo, editar, cancelar, vencer, resumen };
