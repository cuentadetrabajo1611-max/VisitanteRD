/**
 * VisitaFlow - Mantenimiento de una institucion.
 *
 * Cuando una institucion se activa por primera vez hay que dejarla usable sin
 * que nadie tenga que escribir SQL: su administrador, sus permisos por rol y
 * sus ajustes con valores razonables. Todo lo de aqui es idempotente: se puede
 * ejecutar en cada arranque sin duplicar nada.
 */
'use strict';

const bd = require('./db');
const util = require('./util');
const permisos = require('./permisos');
const auth = require('./auth');

/* Ajustes que trae toda institucion nueva. */
const AJUSTES_INICIALES = [
  { clave: 'exigir_cedula', valor: '1', tipo: 'booleano', grupo: 'registro', descripcion: 'Exigir la cédula para registrar a un visitante' },
  { clave: 'exigir_telefono', valor: '0', tipo: 'booleano', grupo: 'registro', descripcion: 'Exigir el teléfono del visitante' },
  { clave: 'exigir_empresa', valor: '0', tipo: 'booleano', grupo: 'registro', descripcion: 'Exigir la empresa o procedencia' },
  { clave: 'exigir_motivo', valor: '1', tipo: 'booleano', grupo: 'registro', descripcion: 'Exigir el motivo de la visita' },
  { clave: 'exigir_visitado', valor: '1', tipo: 'booleano', grupo: 'registro', descripcion: 'Exigir a quién visita' },
  { clave: 'pedir_acompanantes', valor: '1', tipo: 'booleano', grupo: 'registro', descripcion: 'Preguntar por acompañantes' },
  { clave: 'pedir_vehiculo', valor: '1', tipo: 'booleano', grupo: 'registro', descripcion: 'Preguntar por vehículo y placa' },
  { clave: 'pedir_pertenencias', valor: '1', tipo: 'booleano', grupo: 'registro', descripcion: 'Preguntar por pertenencias' },
  { clave: 'pedir_temperatura', valor: '0', tipo: 'booleano', grupo: 'registro', descripcion: 'Registrar la temperatura' },
  { clave: 'imprimir_automatico', valor: '0', tipo: 'booleano', grupo: 'gafete', descripcion: 'Abrir la impresión del gafete al registrar' },
  { clave: 'gafete_plantilla', valor: '', tipo: 'texto', grupo: 'gafete', descripcion: 'Plantilla de gafete que se usa por defecto' },
  { clave: 'alerta_visita_larga', valor: '240', tipo: 'numero', grupo: 'recepcion', descripcion: 'Minutos a partir de los cuales una visita abierta se marca como larga' },
  { clave: 'cerrar_visitas_auto', valor: '1', tipo: 'booleano', grupo: 'recepcion', descripcion: 'Cerrar automáticamente las visitas que quedaron abiertas de días anteriores' },
  { clave: 'preregistro_vigencia_horas', valor: '24', tipo: 'numero', grupo: 'preregistro', descripcion: 'Horas que vale un pre-registro antes de vencer' },
  { clave: 'codigo_prefijo', valor: 'VF', tipo: 'texto', grupo: 'general', descripcion: 'Prefijo de los códigos de visita' },
  { clave: 'formato_fecha', valor: 'dd/mm/aaaa', tipo: 'texto', grupo: 'general', descripcion: 'Formato de fecha en pantalla' },
];

/* Catalogos con los que arranca una institucion nueva. */
const DEPARTAMENTOS = [
  { nombre: 'Administración', encargado: null },
  { nombre: 'Recursos Humanos', encargado: null },
  { nombre: 'Contabilidad', encargado: null },
  { nombre: 'Operaciones', encargado: null },
  { nombre: 'Mantenimiento', encargado: null },
];

const MOTIVOS = [
  { nombre: 'Visita personal', avisa: 0, aprobacion: 0, documento: 1 },
  { nombre: 'Entrega de documentos', avisa: 0, aprobacion: 0, documento: 1 },
  { nombre: 'Proveedor', avisa: 1, aprobacion: 0, documento: 1 },
  { nombre: 'Mantenimiento o servicio técnico', avisa: 1, aprobacion: 0, documento: 1 },
  { nombre: 'Entrevista de trabajo', avisa: 1, aprobacion: 1, documento: 1 },
  { nombre: 'Reunión con la directiva', avisa: 1, aprobacion: 1, documento: 1 },
  { nombre: 'Entrega de paquete', avisa: 0, aprobacion: 0, documento: 0 },
];

const CATEGORIAS = [
  { nombre: 'Visitante', documento: 1 },
  { nombre: 'Proveedor', documento: 1 },
  { nombre: 'Contratista', documento: 1 },
  { nombre: 'Personal interno', documento: 0 },
  { nombre: 'Autoridad', documento: 1 },
];

const SEDES = [{ nombre: 'Sede principal', direccion: null, desde: '08:00', hasta: '18:00' }];

/**
 * Deja lista una institucion: permisos, ajustes, catalogos y su administrador.
 *
 * @param {number}  tenantId
 * @param {object}  opciones  { nombre, correo, clave, sembrarCatalogos }
 */
async function prepararTenant(tenantId, opciones) {
  const o = opciones || {};
  const resultado = { permisos: 0, ajustes: 0, departamentos: 0, motivos: 0, categorias: 0, sedes: 0, plantilla: 0, usuario: null };

  resultado.permisos = await sembrarPermisos(tenantId);
  resultado.ajustes = await sembrarAjustes(tenantId);

  if (o.sembrarCatalogos !== false) {
    resultado.departamentos = await sembrarDepartamentos(tenantId);
    resultado.motivos = await sembrarMotivos(tenantId);
    resultado.categorias = await sembrarCategorias(tenantId);
    resultado.sedes = await sembrarSedes(tenantId);
    resultado.plantilla = await sembrarPlantillaGafete(tenantId);
  }

  if (o.correo && o.clave) {
    resultado.usuario = await crearAdmin(tenantId, o);
  }

  return resultado;
}

/**
 * Permisos por rol. El admin siempre los tiene todos, por diseno.
 *
 * SOLO SE SIEMBRA LA PRIMERA VEZ, cuando ese rol no tiene ningun permiso guardado.
 *
 * Antes se reponia lo que faltara en CADA arranque, y eso tenia un efecto que nadie
 * esperaba: el administrador puede editar los permisos de un rol desde la pantalla de
 * Usuarios (PUT /api/usuarios/roles/:rol), y al reiniciar el contenedor —cosa que pasa
 * en cada actualizacion— el sistema le devolvia en silencio los permisos que habia
 * quitado. Los cambios del cliente desaparecian sin avisar.
 *
 * Si un rol no tiene ningun permiso guardado, es que nunca se sembro: se siembra. Si ya
 * tiene, lo que hay es lo que el cliente decidio, aunque sea menos de lo que trae el
 * codigo por defecto.
 */
async function sembrarPermisos(tenantId) {
  let n = 0;

  for (const [rol, claves] of Object.entries(permisos.ROLES)) {
    const ya = await bd.consultar(
      'SELECT COUNT(*) AS n FROM vf_rol_permisos WHERE tenant_id = @tenant_id AND rol = @rol',
      { tenant_id: tenantId, rol }
    );

    /* Ya configurado por el cliente (o ya sembrado antes): no se toca. */
    if (ya.recordset[0].n > 0) continue;

    for (const clave of claves) {
      const r = await bd.consultar(
        `INSERT INTO vf_rol_permisos (tenant_id, rol, permiso) VALUES (@tenant_id, @rol, @permiso)`,
        { tenant_id: tenantId, rol, permiso: clave }
      );
      n += r.rowsAffected[0] || 0;
    }
  }

  return n;
}

/** Ajustes iniciales, solo los que falten (no pisa lo que el cliente cambio). */
async function sembrarAjustes(tenantId) {
  let n = 0;
  for (const a of AJUSTES_INICIALES) {
    const r = await bd.consultar(
      `IF NOT EXISTS (SELECT 1 FROM vf_ajustes WHERE tenant_id = @tenant_id AND clave = @clave)
         INSERT INTO vf_ajustes (tenant_id, clave, valor, tipo, grupo, descripcion)
         VALUES (@tenant_id, @clave, @valor, @tipo, @grupo, @descripcion);`,
      { tenant_id: tenantId, clave: a.clave, valor: a.valor, tipo: a.tipo, grupo: a.grupo, descripcion: a.descripcion }
    );
    n += r.rowsAffected[0] || 0;
  }
  return n;
}

async function sembrarDepartamentos(tenantId) {
  let n = 0;
  for (const d of DEPARTAMENTOS) {
    const r = await bd.consultar(
      `IF NOT EXISTS (SELECT 1 FROM vf_departamentos WHERE tenant_id = @tenant_id AND nombre = @nombre)
         INSERT INTO vf_departamentos (tenant_id, nombre, encargado) VALUES (@tenant_id, @nombre, @encargado);`,
      { tenant_id: tenantId, nombre: d.nombre, encargado: d.encargado }
    );
    n += r.rowsAffected[0] || 0;
  }
  return n;
}

async function sembrarMotivos(tenantId) {
  let n = 0;
  for (const m of MOTIVOS) {
    const r = await bd.consultar(
      `IF NOT EXISTS (SELECT 1 FROM vf_motivos WHERE tenant_id = @tenant_id AND nombre = @nombre)
         INSERT INTO vf_motivos (tenant_id, nombre, avisa_anfitrion, exige_aprobacion, exige_documento)
         VALUES (@tenant_id, @nombre, @avisa, @aprobacion, @documento);`,
      { tenant_id: tenantId, nombre: m.nombre, avisa: m.avisa, aprobacion: m.aprobacion, documento: m.documento }
    );
    n += r.rowsAffected[0] || 0;
  }
  return n;
}

async function sembrarCategorias(tenantId) {
  let n = 0;
  for (const c of CATEGORIAS) {
    const r = await bd.consultar(
      `IF NOT EXISTS (SELECT 1 FROM vf_categorias WHERE tenant_id = @tenant_id AND nombre = @nombre)
         INSERT INTO vf_categorias (tenant_id, nombre, exige_documento) VALUES (@tenant_id, @nombre, @documento);`,
      { tenant_id: tenantId, nombre: c.nombre, documento: c.documento }
    );
    n += r.rowsAffected[0] || 0;
  }
  return n;
}

async function sembrarSedes(tenantId) {
  let n = 0;
  for (const s of SEDES) {
    const r = await bd.consultar(
      `IF NOT EXISTS (SELECT 1 FROM vf_sedes WHERE tenant_id = @tenant_id AND nombre = @nombre)
         INSERT INTO vf_sedes (tenant_id, nombre, direccion, hora_desde, hora_hasta)
         VALUES (@tenant_id, @nombre, @direccion, @desde, @hasta);`,
      { tenant_id: tenantId, nombre: s.nombre, direccion: s.direccion, desde: s.desde, hasta: s.hasta }
    );
    n += r.rowsAffected[0] || 0;
  }
  return n;
}

/** Plantilla de gafete por defecto: media carta, con QR. */
async function sembrarPlantillaGafete(tenantId) {
  const r = await bd.consultar(
    `IF NOT EXISTS (SELECT 1 FROM vf_plantillas_gafete WHERE tenant_id = @tenant_id AND es_predeterminada = 1)
       INSERT INTO vf_plantillas_gafete
         (tenant_id, nombre, tamano, ancho_mm, alto_mm, orientacion, mostrar_qr, mostrar_barras, es_predeterminada, pie)
       VALUES (@tenant_id, 'Gafete estándar', 'carta-4', 105.0, 74.0, 'horizontal', 1, 0, 1, NULL);`,
    { tenant_id: tenantId }
  );
  return r.rowsAffected[0] || 0;
}

/** Crea el administrador de la institucion si no existe ninguno. */
async function crearAdmin(tenantId, datos) {
  const correo = util.correo(datos.correo);
  if (!correo) throw util.error(400, 'El correo del administrador no es válido.');
  const problemas = auth.revisarClave(datos.clave);
  if (problemas.length) throw util.error(400, 'La contraseña ' + problemas.join(', ') + '.');

  const existente = await bd.consultar(
    'SELECT id FROM vf_usuarios WHERE tenant_id = @tenant_id AND correo = @correo',
    { tenant_id: tenantId, correo }
  );
  if (existente.recordset.length) return { id: existente.recordset[0].id, creado: false };

  const hash = await auth.cifrarClave(datos.clave);
  const r = await bd.consultar(
    `INSERT INTO vf_usuarios (tenant_id, correo, clave_hash, nombre, rol, activo)
     OUTPUT INSERTED.id
     VALUES (@tenant_id, @correo, @hash, @nombre, 'admin', 1)`,
    {
      tenant_id: tenantId,
      correo,
      hash,
      nombre: util.limpiar(datos.nombre, 160) || 'Administrador',
    }
  );
  return { id: r.recordset[0].id, creado: true };
}

/* ------------------------------------------------------------------ */
/* Consultas de la institucion                                         */
/* ------------------------------------------------------------------ */

/** Datos de una institucion por codigo. */
async function porCodigo(codigo) {
  const r = await bd.consultar('SELECT * FROM vf_tenants WHERE codigo = @codigo', {
    codigo: String(codigo || '').trim().toLowerCase(),
  });
  return r.recordset[0] || null;
}

/** Datos de una institucion por id. */
async function porId(id) {
  const r = await bd.consultar('SELECT * FROM vf_tenants WHERE id = @id', { id });
  return r.recordset[0] || null;
}

/** Instituciones activas, para la pantalla de acceso. */
async function activas() {
  const r = await bd.consultar(
    "SELECT codigo, nombre, nombre_comercial, logo_url, color_primario FROM vf_tenants WHERE estado = 'activo' ORDER BY nombre"
  );
  return r.recordset;
}

/**
 * Marca de la institucion: lo que el frontend necesita para pintarse.
 * Incluye los colores ya resueltos para contraste, para que la marca no rompa
 * la legibilidad.
 */
async function marca(tenantId) {
  const t = await porId(tenantId);
  if (!t) return null;

  const primario = util.color(t.color_primario, '#1e3a8a');
  const secundario = util.color(t.color_secundario, '#f59e0b');
  const acento = util.color(t.color_acento, '#0ea5e9');
  const texto = util.color(t.color_texto, '#0f172a');

  const barra = primario;
  const barraOscura = util.mezclar(primario, -0.45);

  return {
    tenant_id: t.id,
    codigo: t.codigo,
    nombre: t.nombre,
    nombre_comercial: t.nombre_comercial || t.nombre,
    logo_url: t.logo_url,
    textos_gafete: t.texto_gafete,
    zona_horaria: t.zona_horaria || 'America/Santo_Domingo',
    tipografia: t.tipografia || 'Inter',
    colores: {
      primario,
      secundario,
      acento,
      texto,
      // Variantes derivadas: el frontend no tiene que calcular nada.
      primario_oscuro: barraOscura,
      primario_claro: util.mezclar(primario, 0.85),
      barra_lateral: barra,
      barra_lateral_oscura: barraOscura,
      texto_sobre_primario: util.textoSobre(primario, '#ffffff', '#0f172a'),
      texto_sobre_secundario: util.textoSobre(secundario, '#ffffff', '#0f172a'),
      borde: util.mezclar(primario, 0.88),
      contraste_primario: Number(util.contraste(primario, '#ffffff').toFixed(2)),
    },
  };
}

/** Lee los ajustes de una institucion como objeto plano ya tipado. */
async function ajustes(tenantId) {
  const r = await bd.consultar('SELECT clave, valor, tipo, grupo, descripcion FROM vf_ajustes WHERE tenant_id = @tenant_id ORDER BY grupo, clave', {
    tenant_id: tenantId,
  });
  const salida = {};
  const detalle = [];
  for (const f of r.recordset) {
    let v = f.valor;
    if (f.tipo === 'booleano') v = util.booleano(f.valor, false);
    else if (f.tipo === 'numero') v = util.entero(f.valor, 0);
    salida[f.clave] = v;
    detalle.push({ clave: f.clave, valor: f.valor, tipo: f.tipo, grupo: f.grupo, descripcion: f.descripcion });
  }
  return { valores: salida, detalle };
}

/** Guarda ajustes. Solo se aceptan claves que ya existan para esa institucion. */
async function guardarAjustes(tenantId, cambios) {
  let n = 0;
  for (const [clave, valor] of Object.entries(cambios || {})) {
    const r = await bd.consultar(
      'UPDATE vf_ajustes SET valor = @valor WHERE tenant_id = @tenant_id AND clave = @clave',
      { tenant_id: tenantId, clave: String(clave).slice(0, 80), valor: valor === null || valor === undefined ? null : String(valor).slice(0, 400) }
    );
    n += r.rowsAffected[0] || 0;
  }
  return n;
}

/** Cuenta los usuarios activos: sirve para vigilar el limite de la licencia. */
async function usuariosActivos(tenantId) {
  const r = await bd.consultar('SELECT COUNT(*) AS n FROM vf_usuarios WHERE tenant_id = @tenant_id AND activo = 1', {
    tenant_id: tenantId,
  });
  return r.recordset[0].n;
}

module.exports = {
  AJUSTES_INICIALES,
  DEPARTAMENTOS,
  MOTIVOS,
  CATEGORIAS,
  SEDES,
  prepararTenant,
  sembrarPermisos,
  sembrarAjustes,
  sembrarDepartamentos,
  sembrarMotivos,
  sembrarCategorias,
  sembrarSedes,
  sembrarPlantillaGafete,
  crearAdmin,
  porCodigo,
  porId,
  activas,
  marca,
  ajustes,
  guardarAjustes,
  usuariosActivos,
};
