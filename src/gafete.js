/**
 * VisitaFlow - Gafetes.
 *
 * Un gafete es la cara visible del sistema: lo lleva puesto una persona que
 * camina por las instalaciones. Por eso el contenido se arma en el servidor y
 * no en el navegador: el codigo QR y el de barras se generan aqui, con las
 * mismas reglas, y el gafete impreso dice exactamente lo que el sistema tiene
 * registrado.
 *
 * El QR codifica el codigo de la visita (VF-AAAAMMDD-XXXX). Es lo que se lee
 * con un lector para registrar la salida.
 */
'use strict';

const bd = require('./db');
const util = require('./util');
const qr = require('./qr');
const code128 = require('./code128');
const padron = require('./identidad/padron');

/** Emite el gafete de una visita. Idempotente: si ya existe, lo devuelve. */
async function emitir(tx, tenantId, visitaId, operador, plantillaId) {
  const ejecutar = (texto, params) => (tx ? tx.consultar(texto, params) : bd.consultar(texto, params));

  // Si ya hay gafete para esa visita, se reutiliza: no se emiten duplicados por
  // recargar la pantalla.
  const existente = await ejecutar(
    'SELECT id, codigo, emitido, veces_impreso FROM vf_gafetes WHERE tenant_id = @tenant_id AND visita_id = @visita_id',
    { tenant_id: tenantId, visita_id: visitaId }
  );
  if (existente.recordset.length) return existente.recordset[0];

  const v = await ejecutar('SELECT codigo FROM vf_visitas WHERE tenant_id = @tenant_id AND id = @id', {
    tenant_id: tenantId,
    id: visitaId,
  });
  if (!v.recordset.length) throw util.error(404, 'No se encontró la visita para emitir el gafete.');

  const plantilla = await plantillaDe(tenantId, plantillaId);

  const ins = await ejecutar(
    `INSERT INTO vf_gafetes (tenant_id, visita_id, plantilla_id, codigo, operador)
     OUTPUT INSERTED.id, INSERTED.codigo, INSERTED.emitido, INSERTED.veces_impreso
     VALUES (@tenant_id, @visita_id, @plantilla_id, @codigo, @operador)`,
    {
      tenant_id: tenantId,
      visita_id: visitaId,
      plantilla_id: plantilla ? plantilla.id : null,
      codigo: v.recordset[0].codigo,
      operador: operador || null,
    }
  );
  return ins.recordset[0];
}

/** Plantilla de gafete: la pedida, la marcada por defecto, o la primera. */
async function plantillaDe(tenantId, plantillaId) {
  if (plantillaId) {
    const r = await bd.consultar(
      'SELECT * FROM vf_plantillas_gafete WHERE tenant_id = @tenant_id AND id = @id AND activo = 1',
      { tenant_id: tenantId, id: util.entero(plantillaId, 0) }
    );
    if (r.recordset.length) return r.recordset[0];
  }
  const r = await bd.consultar(
    `SELECT TOP 1 * FROM vf_plantillas_gafete
      WHERE tenant_id = @tenant_id AND activo = 1
      ORDER BY es_predeterminada DESC, id`,
    { tenant_id: tenantId }
  );
  return r.recordset[0] || null;
}

/** Lista de plantillas de la institucion. */
async function plantillas(tenantId) {
  const r = await bd.consultar(
    'SELECT * FROM vf_plantillas_gafete WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY es_predeterminada DESC, nombre',
    { tenant_id: tenantId }
  );
  return r.recordset.map(comoPlantilla);
}

function comoPlantilla(p) {
  return {
    id: p.id,
    nombre: p.nombre,
    tamano: p.tamano,
    ancho_mm: p.ancho_mm ? Number(p.ancho_mm) : null,
    alto_mm: p.alto_mm ? Number(p.alto_mm) : null,
    orientacion: p.orientacion,
    mostrar_qr: Boolean(p.mostrar_qr),
    mostrar_barras: Boolean(p.mostrar_barras),
    mostrar_foto: Boolean(p.mostrar_foto),
    color_fondo: p.color_fondo,
    color_texto: p.color_texto,
    pie: p.pie,
    es_predeterminada: Boolean(p.es_predeterminada),
  };
}

/* ------------------------------------------------------------------ */
/* Contenido del gafete                                                */
/* ------------------------------------------------------------------ */

/**
 * Arma todo lo que se imprime en el gafete, ya resuelto.
 * El navegador solo tiene que pintarlo.
 */
async function contenido(tenantId, visitaId, opciones) {
  const o = opciones || {};
  const v = await bd.consultar(
    `SELECT v.id, v.codigo, v.cedula, v.nombre_completo, v.fecha_nacimiento, v.sexo, v.empresa,
            v.departamento_txt, v.motivo_txt, v.visitado, v.acompanantes, v.vehiculo, v.placa,
            v.entrada, v.salida, v.estado, v.observaciones, v.operador_nombre,
            t.nombre AS tenant_nombre, t.nombre_comercial, t.logo_url, t.texto_gafete,
            t.color_primario, t.color_secundario, t.color_acento, t.color_texto, t.zona_horaria
       FROM vf_visitas v
       JOIN vf_tenants t ON t.id = v.tenant_id
      WHERE v.tenant_id = @tenant_id AND v.id = @id`,
    { tenant_id: tenantId, id: visitaId }
  );
  if (!v.recordset.length) return null;
  const d = v.recordset[0];

  const plantilla = await plantillaDe(tenantId, o.plantilla_id);

  const primario = util.color(d.color_primario, '#1e3a8a');
  const acento = util.color(d.color_acento, '#0ea5e9');

  const textoQr = d.codigo;
  const svgQr = plantilla && plantilla.mostrar_qr ? qr.generarSvg(textoQr, { nivel: 'M', modulo: 4, margen: 1 }) : null;
  const svgBarras =
    plantilla && plantilla.mostrar_barras && code128.esCodificable(textoQr)
      ? code128.generarSvg(textoQr, { alto: 44, grosorModulo: 1.4, mostrarTexto: false })
      : null;

  const contenidoGafete = {
    visita_id: d.id,
    codigo: d.codigo,
    // El gafete lleva el nombre completo y, si existe, la cedula formateada.
    nombre: d.nombre_completo,
    cedula: d.cedula ? padron.formatear(d.cedula) : null,
    empresa: d.empresa,
    departamento: d.departamento_txt,
    motivo: d.motivo_txt,
    visitado: d.visitado,
    acompanantes: d.acompanantes,
    vehiculo: d.vehiculo ? d.vehiculo + (d.placa ? ' (' + d.placa + ')' : '') : null,
    entrada: d.entrada,
    entrada_legible: util.fechaLegible(d.entrada, d.zona_horaria),
    valido_hasta: finDelDia(d.entrada, d.zona_horaria),
    estado: d.estado,
    operador: d.operador_nombre,
    institucion: {
      nombre: d.tenant_nombre,
      nombre_comercial: d.nombre_comercial || d.tenant_nombre,
      logo_url: d.logo_url,
      texto_pie: (plantilla && plantilla.pie) || d.texto_gafete,
    },
    colores: {
      primario,
      acento,
      secundario: util.color(d.color_secundario, '#f59e0b'),
      texto: util.color(d.color_texto, '#0f172a'),
      texto_sobre_primario: util.textoSobre(primario, '#ffffff', '#0f172a'),
      fondo: (plantilla && plantilla.color_fondo) || '#ffffff',
      texto_plantilla: (plantilla && plantilla.color_texto) || null,
    },
    plantilla: plantilla ? comoPlantilla(plantilla) : null,
    codigos: {
      qr_svg: svgQr,
      barras_svg: svgBarras,
      contenido_qr: textoQr,
    },
  };

  return contenidoGafete;
}

/** Fin del dia de la entrada, como texto: hasta cuando vale el pase. */
function finDelDia(entrada, zona) {
  const d = new Date(entrada);
  if (Number.isNaN(d.getTime())) return null;
  const fecha = d.toLocaleDateString('en-CA', { timeZone: zona || 'America/Santo_Domingo' });
  return fecha + ' 23:59';
}

/** Marca el gafete como impreso y sube el contador. */
async function marcarImpreso(tenantId, visitaId) {
  const r = await bd.consultar(
    `UPDATE vf_gafetes
        SET impreso = SYSDATETIMEOFFSET(), veces_impreso = veces_impreso + 1
      WHERE tenant_id = @tenant_id AND visita_id = @visita_id`,
    { tenant_id: tenantId, visita_id: visitaId }
  );
  return { actualizado: r.rowsAffected[0] || 0 };
}

/** Marca el gafete como devuelto (al registrar la salida). */
async function marcarDevuelto(tenantId, visitaId) {
  const r = await bd.consultar(
    `UPDATE vf_gafetes SET devuelto = SYSDATETIMEOFFSET()
      WHERE tenant_id = @tenant_id AND visita_id = @visita_id AND devuelto IS NULL`,
    { tenant_id: tenantId, visita_id: visitaId }
  );
  return { actualizado: r.rowsAffected[0] || 0 };
}

/** Gafetes emitidos y no devueltos: los que deberian estar fisicamente ahi. */
async function pendientes(tenantId) {
  const r = await bd.consultar(
    `SELECT g.id, g.codigo, g.emitido, g.impreso, g.veces_impreso, g.operador,
            v.id AS visita_id, v.nombre_completo, v.estado
       FROM vf_gafetes g
       JOIN vf_visitas v ON v.id = g.visita_id
      WHERE g.tenant_id = @tenant_id AND g.devuelto IS NULL
      ORDER BY g.emitido DESC`,
    { tenant_id: tenantId }
  );
  return r.recordset.map((g) => ({
    id: g.id,
    codigo: g.codigo,
    visita_id: g.visita_id,
    nombre: g.nombre_completo,
    estado_visita: g.estado,
    emitido: g.emitido,
    emitido_legible: util.fechaLegible(g.emitido),
    impreso: Boolean(g.impreso),
    veces_impreso: g.veces_impreso,
    operador: g.operador,
  }));
}

/* ------------------------------------------------------------------ */
/* Plantillas                                                          */
/* ------------------------------------------------------------------ */

const TAMANOS = {
  'carta-4': { etiqueta: 'Media carta (2 por hoja)', ancho_mm: 105, alto_mm: 74 },
  'carta-8': { etiqueta: 'Tarjeta (8 por hoja)', ancho_mm: 67, alto_mm: 48 },
  carta: { etiqueta: 'Carta completa', ancho_mm: 210, alto_mm: 148 },
  termica: { etiqueta: 'Impresora térmica de gafetes', ancho_mm: 90, alto_mm: 60 },
  credencial: { etiqueta: 'Credencial vertical (85×54 mm)', ancho_mm: 85, alto_mm: 54 },
};

const CAMPOS_EDITABLES = [
  'nombre',
  'tamano',
  'ancho_mm',
  'alto_mm',
  'orientacion',
  'mostrar_qr',
  'mostrar_barras',
  'mostrar_foto',
  'color_fondo',
  'color_texto',
  'pie',
  'es_predeterminada',
];

/** Crea o edita una plantilla de gafete. */
async function guardarPlantilla(tenantId, datos, id) {
  const d = datos || {};
  const nombre = util.limpiar(d.nombre, 120);
  if (!nombre) throw util.error(400, 'La plantilla necesita un nombre.');

  const tamano = TAMANOS[d.tamano] ? d.tamano : 'carta-4';
  const medidas = TAMANOS[tamano];
  const ancho = Number(d.ancho_mm) || medidas.ancho_mm;
  const alto = Number(d.alto_mm) || medidas.alto_mm;
  const orientacion = d.orientacion === 'horizontal' ? 'horizontal' : 'vertical';

  const valores = {
    nombre,
    tamano,
    ancho_mm: ancho,
    alto_mm: alto,
    orientacion,
    mostrar_qr: util.booleano(d.mostrar_qr, true) ? 1 : 0,
    mostrar_barras: util.booleano(d.mostrar_barras, false) ? 1 : 0,
    mostrar_foto: util.booleano(d.mostrar_foto, false) ? 1 : 0,
    color_fondo: util.color(d.color_fondo, null),
    color_texto: util.color(d.color_texto, null),
    pie: util.limpiar(d.pie, 300),
    es_predeterminada: util.booleano(d.es_predeterminada, false) ? 1 : 0,
  };

  // Solo puede haber una plantilla predeterminada.
  if (valores.es_predeterminada) {
    await bd.consultar('UPDATE vf_plantillas_gafete SET es_predeterminada = 0 WHERE tenant_id = @tenant_id', {
      tenant_id: tenantId,
    });
  }

  if (id) {
    const campos = CAMPOS_EDITABLES.map((c) => c + ' = @' + c).join(', ');
    const r = await bd.consultar(
      `UPDATE vf_plantillas_gafete SET ${campos} WHERE tenant_id = @tenant_id AND id = @id`,
      Object.assign({ tenant_id: tenantId, id }, valores)
    );
    if (!r.rowsAffected[0]) throw util.error(404, 'No se encontró esa plantilla.');
    return { id, creada: false };
  }

  const r = await bd.consultar(
    `INSERT INTO vf_plantillas_gafete
       (tenant_id, nombre, tamano, ancho_mm, alto_mm, orientacion, mostrar_qr, mostrar_barras,
        mostrar_foto, color_fondo, color_texto, pie, es_predeterminada)
     OUTPUT INSERTED.id
     VALUES (@tenant_id, @nombre, @tamano, @ancho_mm, @alto_mm, @orientacion, @mostrar_qr, @mostrar_barras,
             @mostrar_foto, @color_fondo, @color_texto, @pie, @es_predeterminada)`,
    Object.assign({ tenant_id: tenantId }, valores)
  );
  return { id: r.recordset[0].id, creada: true };
}

/** Desactiva una plantilla (baja logica: los gafetes ya emitidos la referencian). */
async function desactivarPlantilla(tenantId, id) {
  const r = await bd.consultar(
    'UPDATE vf_plantillas_gafete SET activo = 0, es_predeterminada = 0 WHERE tenant_id = @tenant_id AND id = @id',
    { tenant_id: tenantId, id }
  );
  return { actualizado: r.rowsAffected[0] || 0 };
}

module.exports = {
  TAMANOS,
  emitir,
  plantillaDe,
  plantillas,
  comoPlantilla,
  contenido,
  marcarImpreso,
  marcarDevuelto,
  pendientes,
  guardarPlantilla,
  desactivarPlantilla,
};
