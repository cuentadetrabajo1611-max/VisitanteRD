/**
 * VisitaFlow - Reportes.
 *
 * Se calcula todo en SQL Server y se devuelve ya listo para pintar: el
 * navegador no deberia tener que agregar nada, porque los datos de un ano de
 * visitas no caben comodos en una pantalla.
 */
'use strict';

const bd = require('./db');
const util = require('./util');
const padron = require('./identidad/padron');
const visitas = require('./visitas');

/** Rango de fechas por defecto: los ultimos 30 dias. */
function rango(filtros) {
  const f = filtros || {};
  const hoy = util.hoyISO();
  const hasta = f.hasta || hoy;
  let desde = f.desde;
  if (!desde) {
    const d = new Date(hasta + 'T12:00:00');
    d.setDate(d.getDate() - 29);
    desde = d.toISOString().slice(0, 10);
  }
  return { desde, hasta };
}

/** Condiciones comunes a todos los reportes. */
function condicionesDe(tenantId, f, parametros) {
  const condiciones = ['v.tenant_id = @tenant_id'];
  const r = rango(f);

  condiciones.push('v.entrada >= @desde AND v.entrada < DATEADD(day, 1, @hasta)');
  parametros.desde = r.desde;
  parametros.hasta = r.hasta;

  if (f.departamento_id) {
    condiciones.push('v.departamento_id = @departamento_id');
    parametros.departamento_id = util.entero(f.departamento_id, 0);
  }
  if (f.motivo_id) {
    condiciones.push('v.motivo_id = @motivo_id');
    parametros.motivo_id = util.entero(f.motivo_id, 0);
  }
  if (f.categoria_id) {
    condiciones.push('v.categoria_id = @categoria_id');
    parametros.categoria_id = util.entero(f.categoria_id, 0);
  }
  if (f.estado) {
    condiciones.push('v.estado = @estado');
    parametros.estado = f.estado;
  }
  if (f.texto) {
    condiciones.push('(v.nombre_completo LIKE @texto OR v.cedula LIKE @texto OR v.codigo LIKE @texto OR v.empresa LIKE @texto)');
    parametros.texto = '%' + String(f.texto).trim() + '%';
  }

  return { donde: condiciones.join(' AND '), rango: r };
}

/** Panel de reportes: metricas, series y repartos. */
async function resumen(tenantId, filtros) {
  const parametros = { tenant_id: tenantId };
  const { donde, rango: r } = condicionesDe(tenantId, filtros || {}, parametros);

  const metricas = await bd.consultar(
    `SELECT
        COUNT(*) AS visitas,
        COUNT(DISTINCT v.cedula) AS visitantes_distintos,
        SUM(CASE WHEN v.estado = 'dentro' THEN 1 ELSE 0 END) AS dentro,
        SUM(CASE WHEN v.estado = 'salida' THEN 1 ELSE 0 END) AS con_salida,
        SUM(CASE WHEN v.requiere_aprobacion = 1 AND v.aprobada IS NULL THEN 1 ELSE 0 END) AS sin_aprobar,
        SUM(CASE WHEN v.acompanantes > 0 THEN v.acompanantes ELSE 0 END) AS acompanantes,
        AVG(CASE WHEN v.salida IS NOT NULL THEN CAST(DATEDIFF(minute, v.entrada, v.salida) AS float) END) AS promedio_minutos,
        MAX(CASE WHEN v.salida IS NOT NULL THEN DATEDIFF(minute, v.entrada, v.salida) END) AS maximo_minutos
       FROM vf_visitas v WHERE ${donde}`,
    parametros
  );
  const m = metricas.recordset[0] || {};

  // Serie por dia, para el grafico.
  const porDia = await bd.consultar(
    `SELECT CAST(v.entrada AS date) AS dia, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY CAST(v.entrada AS date) ORDER BY dia`,
    parametros
  );

  // Distribucion por hora: dice cuando hay que tener mas gente en recepcion.
  const porHora = await bd.consultar(
    `SELECT DATEPART(hour, v.entrada) AS hora, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY DATEPART(hour, v.entrada) ORDER BY hora`,
    parametros
  );

  const porMotivo = await bd.consultar(
    `SELECT COALESCE(v.motivo_txt, 'Sin motivo') AS etiqueta, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY COALESCE(v.motivo_txt, 'Sin motivo') ORDER BY n DESC`,
    parametros
  );

  const porDepartamento = await bd.consultar(
    `SELECT COALESCE(v.departamento_txt, 'Sin departamento') AS etiqueta, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY COALESCE(v.departamento_txt, 'Sin departamento') ORDER BY n DESC`,
    parametros
  );

  const porEstado = await bd.consultar(
    `SELECT v.estado AS etiqueta, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY v.estado ORDER BY n DESC`,
    parametros
  );

  const porEmpresa = await bd.consultar(
    `SELECT TOP 10 v.empresa AS etiqueta, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde} AND v.empresa IS NOT NULL AND v.empresa <> ''
      GROUP BY v.empresa ORDER BY n DESC`,
    parametros
  );

  const porDiaSemana = await bd.consultar(
    `SELECT DATEPART(weekday, v.entrada) AS dia, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY DATEPART(weekday, v.entrada) ORDER BY dia`,
    parametros
  );

  const personas = await bd.consultar(
    `SELECT TOP 10 COALESCE(NULLIF(v.visitado, ''), 'Sin indicar') AS etiqueta, COUNT(*) AS n
       FROM vf_visitas v WHERE ${donde}
      GROUP BY COALESCE(NULLIF(v.visitado, ''), 'Sin indicar') ORDER BY n DESC`,
    parametros
  );

  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  return {
    rango: r,
    metricas: {
      visitas: m.visitas || 0,
      visitantes_distintos: m.visitantes_distintos || 0,
      dentro: m.dentro || 0,
      con_salida: m.con_salida || 0,
      sin_aprobar: m.sin_aprobar || 0,
      acompanantes: m.acompanantes || 0,
      promedio_minutos: m.promedio_minutos ? Math.round(m.promedio_minutos) : null,
      promedio_legible: util.duracionLegible(m.promedio_minutos ? Math.round(m.promedio_minutos) : null),
      maximo_minutos: m.maximo_minutos || null,
      maximo_legible: util.duracionLegible(m.maximo_minutos || null),
      // Cuantas visitas hubo por dia laborable del periodo.
      promedio_diario: porDia.recordset.length
        ? Math.round(((m.visitas || 0) / porDia.recordset.length) * 10) / 10
        : 0,
    },
    series: {
      por_dia: porDia.recordset.map((d) => ({ etiqueta: String(d.dia).slice(0, 10), valor: d.n })),
      por_hora: rellenarHoras(porHora.recordset),
      por_dia_semana: dias.map((nombre, i) => ({
        etiqueta: nombre,
        valor: (porDiaSemana.recordset.find((d) => d.dia === i + 1) || {}).n || 0,
      })),
    },
    repartos: {
      por_motivo: porMotivo.recordset,
      por_departamento: porDepartamento.recordset,
      por_estado: porEstado.recordset,
      por_empresa: porEmpresa.recordset,
      personas_mas_visitadas: personas.recordset,
    },
  };
}

/** Completa las 24 horas, para que el grafico no tenga huecos. */
function rellenarHoras(filas) {
  const salida = [];
  for (let h = 0; h < 24; h++) {
    const f = filas.find((x) => x.hora === h);
    salida.push({ etiqueta: String(h).padStart(2, '0') + ':00', valor: f ? f.n : 0 });
  }
  return salida;
}

/** Detalle paginado de visitas. */
async function detalle(tenantId, filtros) {
  return visitas.listar(tenantId, filtros);
}

/** Ranking de visitantes frecuentes. */
async function visitantesFrecuentes(tenantId, filtros) {
  const f = filtros || {};
  const p = util.paginacion(f);
  const parametros = { tenant_id: tenantId };
  const { donde, rango: r } = condicionesDe(tenantId, f, parametros);

  const total = await bd.consultar(
    `SELECT COUNT(DISTINCT v.cedula) AS n FROM vf_visitas v WHERE ${donde} AND v.cedula IS NOT NULL AND v.cedula <> ''`,
    parametros
  );
  const filas = await bd.consultar(
    `SELECT v.cedula, MAX(v.nombre_completo) AS nombre, COUNT(*) AS visitas,
            MIN(v.entrada) AS primera, MAX(v.entrada) AS ultima,
            MAX(v.empresa) AS empresa
       FROM vf_visitas v
      WHERE ${donde} AND v.cedula IS NOT NULL AND v.cedula <> ''
      GROUP BY v.cedula
      ORDER BY COUNT(*) DESC, MAX(v.entrada) DESC
     OFFSET @salto ROWS FETCH NEXT @tamano ROWS ONLY`,
    Object.assign({}, parametros, { salto: p.salto, tamano: p.tamano })
  );

  return {
    rango: r,
    total: total.recordset[0].n,
    pagina: p.pagina,
    filas: filas.recordset.map((v) => ({
      cedula: v.cedula,
      cedula_formato: padron.formatear(v.cedula),
      nombre: v.nombre,
      empresa: v.empresa,
      visitas: v.visitas,
      primera: v.primera,
      primera_legible: util.fechaLegible(v.primera),
      ultima: v.ultima,
      ultima_legible: util.fechaLegible(v.ultima),
    })),
  };
}

/** Opciones para llenar los filtros de la pantalla. */
async function opciones(tenantId) {
  const [deps, motivos, cats] = await Promise.all([
    bd.consultar('SELECT id, nombre FROM vf_departamentos WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre', { tenant_id: tenantId }),
    bd.consultar('SELECT id, nombre FROM vf_motivos WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre', { tenant_id: tenantId }),
    bd.consultar('SELECT id, nombre FROM vf_categorias WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre', { tenant_id: tenantId }),
  ]);
  return {
    departamentos: deps.recordset,
    motivos: motivos.recordset,
    categorias: cats.recordset,
    estados: [
      { valor: 'dentro', etiqueta: 'Dentro' },
      { valor: 'salida', etiqueta: 'Salió' },
      { valor: 'anulada', etiqueta: 'Anulada' },
      { valor: 'denegada', etiqueta: 'Denegada' },
    ],
    periodos: [
      { valor: 'hoy', etiqueta: 'Hoy' },
      { valor: '7', etiqueta: 'Últimos 7 días' },
      { valor: '30', etiqueta: 'Últimos 30 días' },
      { valor: '90', etiqueta: 'Últimos 90 días' },
      { valor: '365', etiqueta: 'Último año' },
    ],
  };
}

/** Visitas que llevan demasiado tiempo abiertas. */
async function visitasLargas(tenantId) {
  const ajustes = await visitas.ajustesDe(tenantId);
  const minutos = util.entero(ajustes.alerta_visita_larga, 240);
  const r = await bd.consultar(
    `SELECT v.id, v.codigo, v.nombre_completo, v.cedula, v.departamento_txt, v.visitado,
            v.entrada, DATEDIFF(minute, v.entrada, SYSDATETIMEOFFSET()) AS minutos, t.zona_horaria
       FROM vf_visitas v JOIN vf_tenants t ON t.id = v.tenant_id
      WHERE v.tenant_id = @tenant_id AND v.estado = 'dentro'
        AND DATEDIFF(minute, v.entrada, SYSDATETIMEOFFSET()) > @minutos
      ORDER BY v.entrada`,
    { tenant_id: tenantId, minutos }
  );
  return {
    minutos_alerta: minutos,
    filas: r.recordset.map((v) => ({
      id: v.id,
      codigo: v.codigo,
      nombre: v.nombre_completo,
      cedula_formato: v.cedula ? padron.formatear(v.cedula) : null,
      departamento: v.departamento_txt,
      visitado: v.visitado,
      entrada_legible: util.fechaLegible(v.entrada, v.zona_horaria),
      minutos: v.minutos,
      tiempo: util.duracionLegible(v.minutos),
    })),
  };
}

/** Columnas de la exportacion a CSV. */
const COLUMNAS_CSV = [
  { titulo: 'Código', valor: 'codigo' },
  { titulo: 'Cédula', valor: 'cedula_formato' },
  { titulo: 'Nombre', valor: 'nombre' },
  { titulo: 'Empresa', valor: 'empresa' },
  { titulo: 'Departamento', valor: 'departamento' },
  { titulo: 'Motivo', valor: 'motivo' },
  { titulo: 'Persona visitada', valor: 'visitado' },
  { titulo: 'Estado', valor: 'estado' },
  { titulo: 'Entrada', valor: 'entrada_legible' },
  { titulo: 'Salida', valor: 'salida_legible' },
  { titulo: 'Duración', valor: 'duracion' },
  { titulo: 'Acompañantes', valor: 'acompanantes' },
  { titulo: 'Vehículo', valor: 'vehiculo' },
];

/**
 * Exporta a CSV. Se pagina por dentro para no traer 50.000 filas de una vez:
 * se leen de a mil y se van escribiendo.
 */
async function exportarCsv(tenantId, filtros) {
  const f = Object.assign({}, filtros, { pagina: 1, tamano: 200 });
  const primera = await visitas.listar(tenantId, f);
  const paginas = primera.paginas;

  let filas = primera.filas.slice();
  for (let p = 2; p <= paginas; p++) {
    const siguiente = await visitas.listar(tenantId, Object.assign({}, f, { pagina: p }));
    filas = filas.concat(siguiente.filas);
  }
  return { csv: util.csv(filas, COLUMNAS_CSV), filas: filas.length };
}

module.exports = {
  COLUMNAS_CSV,
  rango,
  resumen,
  detalle,
  visitantesFrecuentes,
  opciones,
  visitasLargas,
  exportarCsv,
};
