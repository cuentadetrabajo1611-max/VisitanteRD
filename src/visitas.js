/**
 * VisitaFlow - Servicio de visitas.
 *
 * Aqui vive el flujo completo de recepcion: resolver la identidad, registrar la
 * entrada, detectar al visitante frecuente, avisar de la lista de vigilancia,
 * emitir el gafete y cerrar con la salida.
 *
 * Dos decisiones que atraviesan todo el archivo:
 *
 *  1. La bitacora no depende del padron. Al registrar se guarda una COPIA de los
 *     datos validados dentro de la visita. Si manana cambia el padron (o se cae),
 *     el historial sigue diciendo lo que se verifico ese dia.
 *  2. Nunca se escribe en la base del padron. Solo se lee.
 */
'use strict';

const bd = require('./db');
const util = require('./util');
const config = require('./config');
const padron = require('./identidad/padron');
const mantenimiento = require('./mantenimiento');
const auditoria = require('./auditoria');
const gafete = require('./gafete');
const avisos = require('./avisos');
const vigilancia = require('./vigilancia');

/* preregistro.js importa este módulo, así que aquí la dependencia es circular.
 *
 * Se carga de forma perezosa (dentro de la función que lo usa) en vez de arriba: si
 * se cargara al principio, uno de los dos módulos recibiría el otro a medio construir
 * y sus funciones saldrían undefined. Se hace con una función para que quede claro
 * por qué no está arriba como los demás. */
function moduloPreregistro() {
  return require('./preregistro');
}

/* ------------------------------------------------------------------ */
/* Consultas de apoyo                                                  */
/* ------------------------------------------------------------------ */

/** Ajustes de la institucion, ya tipados. */
async function ajustesDe(tenantId) {
  const a = await mantenimiento.ajustes(tenantId);
  return a.valores;
}

/** Resumen del panel: lo que recepcion necesita ver al entrar. */
async function resumen(tenantId, zona) {
  const ajustes = await ajustesDe(tenantId);
  const minutosLarga = util.entero(ajustes.alerta_visita_larga, 240);

  const r = await bd.consultar(
    `SELECT
        (SELECT COUNT(*) FROM vf_visitas WHERE tenant_id = @tenant_id AND estado = 'dentro') AS dentro,
        (SELECT COUNT(*) FROM vf_visitas
          WHERE tenant_id = @tenant_id AND CAST(entrada AS date) = CAST(SYSDATETIMEOFFSET() AS date)) AS hoy,
        (SELECT COUNT(*) FROM vf_visitas
          WHERE tenant_id = @tenant_id AND estado = 'salida' AND CAST(salida AS date) = CAST(SYSDATETIMEOFFSET() AS date)) AS salidas_hoy,
        (SELECT COUNT(*) FROM vf_visitas
          WHERE tenant_id = @tenant_id AND estado IN ('dentro','anunciada')
            AND DATEDIFF(minute, entrada, SYSDATETIMEOFFSET()) > @minutos) AS largas,
        (SELECT COUNT(*) FROM vf_visitas
          WHERE tenant_id = @tenant_id AND requiere_aprobacion = 1 AND aprobada IS NULL
            AND estado IN ('dentro','anunciada')) AS sin_aprobar,
        (SELECT COUNT(*) FROM vf_preregistros
          WHERE tenant_id = @tenant_id AND estado = 'pendiente'
            AND (vence IS NULL OR vence > SYSDATETIMEOFFSET())) AS preregistros,
        (SELECT COUNT(*) FROM vf_vigilancia
          WHERE tenant_id = @tenant_id AND activo = 1 AND tipo = 'bloqueado'
            AND (vigente_hasta IS NULL OR vigente_hasta > SYSDATETIMEOFFSET())) AS bloqueados`,
    { tenant_id: tenantId, minutos: minutosLarga }
  );

  const datos = r.recordset[0];

  // Ultimas entradas y salidas del dia, para las dos listas del panel.
  const movimientos = await bd.consultar(
    `SELECT TOP 12 id, codigo, nombre_completo, cedula, departamento_txt, visitado, motivo_txt,
            estado, entrada, salida, requiere_aprobacion, aprobada
       FROM vf_visitas
      WHERE tenant_id = @tenant_id AND CAST(entrada AS date) >= CAST(DATEADD(day, -1, SYSDATETIMEOFFSET()) AS date)
      ORDER BY entrada DESC`,
    { tenant_id: tenantId }
  );

  const dentro = await bd.consultar(
    `SELECT TOP 15 id, codigo, nombre_completo, cedula, departamento_txt, visitado,
            entrada, requiere_aprobacion, aprobada,
            DATEDIFF(minute, entrada, SYSDATETIMEOFFSET()) AS minutos_dentro
       FROM vf_visitas
      WHERE tenant_id = @tenant_id AND estado = 'dentro'
      ORDER BY entrada DESC`,
    { tenant_id: tenantId }
  );

  return {
    metricas: {
      dentro: datos.dentro,
      hoy: datos.hoy,
      salidas_hoy: datos.salidas_hoy,
      largas: datos.largas,
      sin_aprobar: datos.sin_aprobar,
      preregistros: datos.preregistros,
      bloqueados: datos.bloqueados,
    },
    minutos_alerta: minutosLarga,
    recientes: movimientos.recordset.map((v) => ({
      id: v.id,
      codigo: v.codigo,
      nombre: v.nombre_completo,
      cedula: v.cedula,
      departamento: v.departamento_txt,
      visitado: v.visitado,
      motivo: v.motivo_txt,
      estado: v.estado,
      entrada: v.entrada,
      salida: v.salida,
      entrada_legible: util.fechaLegible(v.entrada, zona),
      salida_legible: util.fechaLegible(v.salida, zona),
      requiere_aprobacion: v.requiere_aprobacion,
      aprobada: v.aprobada,
    })),
    dentro_detalle: dentro.recordset.map((v) => ({
      id: v.id,
      codigo: v.codigo,
      nombre: v.nombre_completo,
      cedula: v.cedula,
      departamento: v.departamento_txt,
      visitado: v.visitado,
      entrada: v.entrada,
      entrada_legible: util.fechaLegible(v.entrada, zona),
      minutos_dentro: v.minutos_dentro,
      tiempo_dentro: util.duracionLegible(v.minutos_dentro),
      larga: v.minutos_dentro > minutosLarga,
      requiere_aprobacion: v.requiere_aprobacion,
      aprobada: v.aprobada,
    })),
  };
}

/**
 * Busca en la base local un visitante ya conocido por cedula, para recuperar
 * su telefono, correo y empresa sin volver a teclearlos. Esto es lo que hace
 * que la segunda visita de alguien tome segundos.
 */
async function visitanteConocido(tenantId, cedula) {
  const d = padron.soloDigitos(cedula);
  if (!d) return null;
  const r = await bd.consultar(
    `SELECT TOP 1 id, cedula, cedula_formato, nombres, apellidos, nombre_completo,
            fecha_nacimiento, sexo, nacionalidad, estado_civil, ocupacion,
            municipio, provincia, telefono, correo, empresa, notas,
            en_padron, validado, visitas_total
       FROM vf_visitantes
      WHERE tenant_id = @tenant_id AND cedula = @cedula`,
    { tenant_id: tenantId, cedula: d }
  );
  return r.recordset[0] || null;
}

/** Ultima visita de un visitante, para saber a quien suele ver y por que. */
async function ultimaVisita(tenantId, visitanteId) {
  const r = await bd.consultar(
    `SELECT TOP 1 id, entrada, departamento_id, departamento_txt, motivo_id, motivo_txt, visitado, salida_operador
       FROM vf_visitas
      WHERE tenant_id = @tenant_id AND visitante_id = @visitante_id
      ORDER BY entrada DESC`,
    { tenant_id: tenantId, visitante_id: visitanteId }
  );
  return r.recordset[0] || null;
}

/**
 * Arma todo lo necesario para registrar a alguien a partir de su cedula:
 * identidad, historial y avisos. Es la pantalla de registro completa en una
 * sola llamada, para que recepcion no tenga que hacer cinco.
 */
async function prepararRegistro(tenantId, cedula, opciones) {
  const ajustes = await ajustesDe(tenantId);
  const o = opciones || {};

  if (!padron.soloDigitos(cedula)) {
    return {
      ok: false,
      motivo: 'Escriba la cédula para consultar.',
      catalogos: await catalogosDe(tenantId),
      ajustes,
    };
  }

  const resolucion = await padron.resolver({ cedula });
  const conocido = await visitanteConocido(tenantId, cedula);

  // Si el padron no lo tiene pero ya vino antes, se usa lo que sabemos de el.
  if (!resolucion.ciudadano && conocido) {
    resolucion.ciudadano = {
      cedula: conocido.cedula,
      cedula_formato: conocido.cedula_formato || padron.formatear(conocido.cedula),
      nombres: conocido.nombres,
      apellidos: conocido.apellidos,
      nombre_completo: conocido.nombre_completo,
      fecha_nacimiento: conocido.fecha_nacimiento,
      edad: padron.edad(conocido.fecha_nacimiento),
      sexo: conocido.sexo,
      nacionalidad: conocido.nacionalidad,
      estado_civil: conocido.estado_civil,
      ocupacion: conocido.ocupacion,
      municipio: conocido.municipio,
      provincia: conocido.provincia,
      en_padron: Boolean(conocido.en_padron),
      origen: 'historial',
    };
    resolucion.origen = resolucion.origen || 'historial';
  }

  // Aviso de visita abierta: si ya esta dentro, no se registra dos veces.
  let visitaAbierta = null;
  if (conocido) {
    const abierta = await bd.consultar(
      `SELECT TOP 1 id, codigo, entrada, departamento_txt, visitado
         FROM vf_visitas
        WHERE tenant_id = @tenant_id AND visitante_id = @visitante_id AND estado = 'dentro'`,
      { tenant_id: tenantId, visitante_id: conocido.id }
    );
    if (abierta.recordset.length) {
      const v = abierta.recordset[0];
      visitaAbierta = {
        id: v.id,
        codigo: v.codigo,
        entrada: v.entrada,
        entrada_legible: util.fechaLegible(v.entrada),
        departamento: v.departamento_txt,
        visitado: v.visitado,
      };
    }
  }

  // Pre-registro pendiente para esa cedula: se ofrece usarlo.
  let preregistro = null;
  const d = padron.soloDigitos(cedula);
  const pre = await bd.consultar(
    `SELECT TOP 1 id, codigo, nombre_completo, empresa, telefono, correo, departamento_id,
            motivo_id, visitado, fecha_prevista, acompanantes, vehiculo, notas
       FROM vf_preregistros
      WHERE tenant_id = @tenant_id AND cedula = @cedula AND estado = 'pendiente'
        AND (vence IS NULL OR vence > SYSDATETIMEOFFSET())
      ORDER BY fecha_prevista DESC`,
    { tenant_id: tenantId, cedula: d }
  );
  if (pre.recordset.length) preregistro = pre.recordset[0];

  const historial = conocido ? await ultimaVisita(tenantId, conocido.id) : null;

  // Lista de vigilancia: se consulta SIEMPRE, antes de dejar registrar.
  const aviso = d ? await vigilancia.consultarCedula(tenantId, d) : null;

  return {
    ok: resolucion.ok,
    motivo: resolucion.motivo,
    origen: resolucion.origen,
    ciudadano: resolucion.ciudadano,
    conocido: conocido
      ? {
          id: conocido.id,
          visitas_total: conocido.visitas_total,
          telefono: conocido.telefono,
          correo: conocido.correo,
          empresa: conocido.empresa,
          notas: conocido.notas,
          ultima_visita: historial
            ? {
                fecha: historial.entrada,
                fecha_legible: util.fechaLegible(historial.entrada),
                departamento: historial.departamento_txt,
                motivo: historial.motivo_txt,
                visitado: historial.visitado,
              }
            : null,
        }
      : null,
    visita_abierta: visitaAbierta,
    preregistro: preregistro
      ? Object.assign({}, preregistro, { fecha_prevista_legible: util.fechaLegible(preregistro.fecha_prevista) })
      : null,
    vigilancia: aviso,
    catalogos: await catalogosDe(tenantId),
    ajustes,
  };
}

/** Catalogos que necesita el formulario de registro. */
async function catalogosDe(tenantId) {
  const [deps, motivos, cats, sedes] = await Promise.all([
    bd.consultar('SELECT id, nombre, encargado, correo FROM vf_departamentos WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre', { tenant_id: tenantId }),
    bd.consultar(
      `SELECT id, nombre, avisa_anfitrion, exige_aprobacion, exige_documento, exige_vehiculo,
              exige_pertenencias, exige_temperatura, color
         FROM vf_motivos WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre`,
      { tenant_id: tenantId }
    ),
    bd.consultar('SELECT id, nombre, exige_documento FROM vf_categorias WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre', { tenant_id: tenantId }),
    bd.consultar('SELECT id, nombre, hora_desde, hora_hasta FROM vf_sedes WHERE tenant_id = @tenant_id AND activo = 1 ORDER BY nombre', { tenant_id: tenantId }),
  ]);

  return {
    departamentos: deps.recordset,
    motivos: motivos.recordset.map((m) => ({
      id: m.id,
      nombre: m.nombre,
      avisa_anfitrion: Boolean(m.avisa_anfitrion),
      exige_aprobacion: Boolean(m.exige_aprobacion),
      exige_documento: Boolean(m.exige_documento),
      exige_vehiculo: Boolean(m.exige_vehiculo),
      exige_pertenencias: Boolean(m.exige_pertenencias),
      exige_temperatura: Boolean(m.exige_temperatura),
      color: m.color,
    })),
    categorias: cats.recordset.map((c) => ({ id: c.id, nombre: c.nombre, exige_documento: Boolean(c.exige_documento) })),
    sedes: sedes.recordset,
  };
}

/* ------------------------------------------------------------------ */
/* Registro de la entrada                                              */
/* ------------------------------------------------------------------ */

/** Valida los datos que llegan del formulario de registro. */
function validarRegistro(datos, ajustes) {
  const d = datos || {};
  const problemas = [];

  const cedula = padron.soloDigitos(d.cedula);
  if (util.booleano(ajustes.exigir_cedula, true) && !cedula) {
    problemas.push('La cédula es obligatoria.');
  }
  if (cedula && !padron.validarCedula(cedula).valida) {
    problemas.push('La cédula no es válida: ' + padron.validarCedula(cedula).motivo);
  }
  if (util.booleano(ajustes.exigir_motivo, true) && !d.motivo_id) problemas.push('El motivo de la visita es obligatorio.');
  if (util.booleano(ajustes.exigir_visitado, true) && !util.limpiar(d.visitado, 160)) {
    problemas.push('Indique a quién visita.');
  }
  if (util.booleano(ajustes.exigir_telefono, false) && !util.limpiar(d.telefono, 40)) {
    problemas.push('El teléfono es obligatorio.');
  }
  if (util.booleano(ajustes.exigir_empresa, false) && !util.limpiar(d.empresa, 200)) {
    problemas.push('La empresa o procedencia es obligatoria.');
  }
  if (!cedula && !util.limpiar(d.nombre_completo, 200)) {
    problemas.push('Sin cédula, el nombre es obligatorio.');
  }

  const temperatura = d.temperatura === null || d.temperatura === undefined || d.temperatura === '' ? null : Number(d.temperatura);
  if (temperatura !== null && (!Number.isFinite(temperatura) || temperatura < 25 || temperatura > 45)) {
    problemas.push('La temperatura debe estar entre 25 y 45 grados.');
  }

  return { problemas, cedula, temperatura };
}

/**
 * Registra la entrada de un visitante.
 *
 * @returns {{ok:boolean, motivo?:string, visita?:object, gafete?:object, avisos?:array}}
 */
async function registrarEntrada(req, datos) {
  const tenantId = req.tenant_id;
  const ajustes = await ajustesDe(tenantId);

  /* 0. Si viene un CÓDIGO DE VISITA ANUNCIADA, de ahí sale todo lo demás.
   *
   * El sistema sabía buscar el preregistro por cédula (al teclear la cédula ofrecía
   * usarlo), pero NO por código. Así que un visitante que llegaba con su código y sin
   * la cédula a mano no se podía registrar: el sistema pedía la cédula o el nombre, y
   * el nombre lo tenía delante, en el preregistro.
   *
   * Aquí se completa lo que falte con los datos de la visita anunciada: el código es
   * la llave que el visitante trae, y todo lo demás ya se apuntó cuando llamó.
   *
   * Los datos que SÍ vienen en la petición mandan sobre los del preregistro: si el
   * recepcionista corrige algo al recibir (otro motivo, otro a quién visita), su
   * corrección es la que vale. */
  let pre = null;

  if (util.limpiar(datos.codigo_preregistro, 20)) {
    pre = await moduloPreregistro().porCodigo(tenantId, datos.codigo_preregistro);

    if (!pre) {
      return { ok: false, motivo: 'No hay ninguna visita anunciada con el código ' + datos.codigo_preregistro + '.' };
    }

    if (pre.estado === 'usado') {
      return {
        ok: false,
        motivo: 'Ese código ya se usó' + (pre.usado ? ' el ' + util.fechaLegible(pre.usado) : '') + '.',
        preregistro: pre,
      };
    }

    if (pre.estado === 'cancelado') {
      return { ok: false, motivo: 'Esa visita anunciada fue cancelada.', preregistro: pre };
    }

    if (pre.estado === 'vencido' || (pre.vence && new Date(pre.vence) < new Date())) {
      return { ok: false, motivo: 'Esa visita anunciada ya venció. Regístrela como visita normal.', preregistro: pre };
    }

    /* Se rellena solo lo que no venga en la petición. */
    datos = Object.assign({}, datos);
    if (!util.limpiar(datos.cedula, 20) && pre.cedula) datos.cedula = pre.cedula;
    if (!util.limpiar(datos.nombre_completo, 200)) datos.nombre_completo = pre.nombre_completo;
    if (!datos.motivo_id && pre.motivo_id) datos.motivo_id = pre.motivo_id;
    if (!datos.departamento_id && pre.departamento_id) datos.departamento_id = pre.departamento_id;
    if (!util.limpiar(datos.visitado, 160) && pre.visitado) datos.visitado = pre.visitado;
    if (!util.limpiar(datos.empresa, 200) && pre.empresa) datos.empresa = pre.empresa;
    if (!util.limpiar(datos.telefono, 40) && pre.telefono) datos.telefono = pre.telefono;
    if (!util.limpiar(datos.correo, 200) && pre.correo) datos.correo = pre.correo;
    if (!util.limpiar(datos.vehiculo, 60) && pre.vehiculo) datos.vehiculo = pre.vehiculo;
    if (!util.limpiar(datos.observaciones, 600) && pre.notas) datos.observaciones = pre.notas;
    if (!datos.acompanantes && pre.acompanantes) datos.acompanantes = pre.acompanantes;

    /* Y se deja dicho de qué visita anunciada viene, para que quede enlazada. */
    datos.preregistro_id = pre.id;
  }

  const { problemas, cedula, temperatura } = validarRegistro(datos, ajustes);
  if (problemas.length) return { ok: false, motivo: problemas.join(' ') };

  // 1. Lista de vigilancia, ANTES de cualquier otra cosa.
  const aviso = cedula ? await vigilancia.consultarCedula(tenantId, cedula) : null;
  if (aviso && aviso.bloqueado) {
    const autorizado = util.booleano(datos.autorizar_bloqueado, false);

    if (!autorizado) {
      /* Se deja constancia del intento ANTES de negarlo.
       *
       * La tabla de avisos de vigilancia llevaba tiempo en el esquema con su columna
       * `decision` ('avisado' | 'permitido' | 'denegado') y con su pantalla de
       * consulta, pero el registro NUNCA escribia en ella: solo devolvia el error.
       * O sea que el vigilante veia "esta cedula esta bloqueada" en el momento y
       * despues no quedaba rastro de que alguien lo habia intentado, que es
       * justamente lo que sirve para decidir si el bloqueo esta haciendo su trabajo.
       *
       * La constancia se escribe aunque el intento se rechace: el aviso NO lleva
       * visita_id porque no llego a haber visita. */
      try {
        await vigilancia.registrarAviso(req, {
          vigilancia_id: aviso.id,
          cedula,
          decision: 'denegado',
          motivo: aviso.motivo || 'Cédula en la lista de vigilancia',
        });
      } catch (e) {
        /* Que no se pueda anotar no puede impedir el bloqueo: negar la entrada es lo
           importante, y si esto falla se ve en el registro del servidor. */
        console.error('[visitas] No se pudo anotar el intento de entrada de una cédula bloqueada: ' + e.message);
      }

      return {
        ok: false,
        motivo: 'Esta cédula está BLOQUEADA: ' + aviso.motivo,
        vigilancia: aviso,
        requiere_autorizacion: true,
      };
    }

    if (!util.limpiar(datos.motivo_autorizacion, 400)) {
      return {
        ok: false,
        motivo: 'Para dejar entrar a una cédula bloqueada hay que escribir el motivo de la autorización.',
        vigilancia: aviso,
        requiere_autorizacion: true,
      };
    }

    /* Si se autoriza, el aviso lo escribe la RUTA, después de que la visita exista.
     *
     * No se escribe aquí a propósito: aquí todavía no hay visita, y la ruta ya anota
     * la decisión 'permitido' con su visita_id y con el motivo de la autorización.
     * Anotarlo también aquí duplicaba el aviso y dejaba el más nuevo sin visita, que
     * es justo al revés de lo que hace falta. Lo detectó la prueba de la bitácora de
     * avisos, que esperaba 'permitido' y encontraba otra cosa. */
  }

  // 2. Resolver identidad contra el padron (o aceptar lo escrito a mano).
  const resolucion = await padron.resolver({
    cedula,
    nombres: datos.nombres,
    apellidos: datos.apellidos,
    /* El nombre completo escrito de una vez: es como lo escribe quien tiene a la
       persona delante, y sin esto el registro sin cédula se quedaba sin nombre. */
    nombre_completo: datos.nombre_completo,
  });
  if (!resolucion.ok) return { ok: false, motivo: resolucion.motivo };

  const ciudadano = resolucion.ciudadano;
  if (!ciudadano.nombre_completo) ciudadano.nombre_completo = util.limpiar(datos.nombre_completo, 200);
  if (!ciudadano.nombre_completo) {
    return { ok: false, motivo: 'No se pudo determinar el nombre del visitante.' };
  }

  // 3. Motivo: de el salen las reglas (avisar al anfitrion, exigir aprobacion).
  let motivo = null;
  if (datos.motivo_id) {
    const m = await bd.consultar(
      'SELECT id, nombre, avisa_anfitrion, exige_aprobacion, exige_vehiculo, exige_pertenencias, exige_temperatura FROM vf_motivos WHERE tenant_id = @tenant_id AND id = @id AND activo = 1',
      { tenant_id: tenantId, id: util.entero(datos.motivo_id, 0) }
    );
    if (!m.recordset.length) return { ok: false, motivo: 'El motivo de visita no existe o está desactivado.' };
    motivo = m.recordset[0];
  }

  let departamento = null;
  if (datos.departamento_id) {
    const dep = await bd.consultar(
      'SELECT id, nombre, encargado, correo FROM vf_departamentos WHERE tenant_id = @tenant_id AND id = @id AND activo = 1',
      { tenant_id: tenantId, id: util.entero(datos.departamento_id, 0) }
    );
    if (dep.recordset.length) departamento = dep.recordset[0];
  }

  // 4. Visita abierta: evita registrar dos veces a la misma persona.
  if (cedula) {
    const abierta = await bd.consultar(
      `SELECT TOP 1 v.id, v.codigo FROM vf_visitas v
         JOIN vf_visitantes vi ON vi.id = v.visitante_id
        WHERE v.tenant_id = @tenant_id AND vi.cedula = @cedula AND v.estado = 'dentro'`,
      { tenant_id: tenantId, cedula }
    );
    if (abierta.recordset.length && !util.booleano(datos.permitir_duplicado, false)) {
      return {
        ok: false,
        motivo: 'Este visitante ya está dentro de las instalaciones (visita ' + abierta.recordset[0].codigo + '). Registre primero su salida.',
        visita_abierta: abierta.recordset[0],
        duplicado: true,
      };
    }
  }

  // 5. Guardar visitante (alta o actualizacion) y la visita.
  const codigo = util.codigoVisita();

  /* Fecha de entrada. Normalmente es "ahora". Solo en desarrollo se acepta una
     fecha distinta, para que el generador de datos de demostracion pueda
     repartir visitas en varios dias y los reportes tengan algo que mostrar.
     En produccion este parametro se ignora por completo.

     Una entrada en el FUTURO no se acepta nunca, ni en desarrollo: dejaria
     tiempos negativos en las pantallas y descuadraria los reportes. Una entrada
     de hace un rato si (unos segundos de diferencia entre el reloj del
     navegador y el del servidor son normales). */
  let entrada = new Date();
  if (!config.esProduccion() && datos.fecha_entrada) {
    const f = new Date(datos.fecha_entrada);
    const margen = 60000; // un minuto de tolerancia
    if (!Number.isNaN(f.getTime()) && f.getTime() <= Date.now() + margen) entrada = f;
  }

  const resultado = await bd.transaccion(async (tx) => {
    const visitanteId = await guardarVisitante(tx, tenantId, ciudadano, datos, resolucion.origen === 'padron');

    const preId = datos.preregistro_id ? util.entero(datos.preregistro_id, 0) : null;

    const ins = await tx.consultar(
      `INSERT INTO vf_visitas
         (tenant_id, visitante_id, codigo, cedula, nombre_completo, fecha_nacimiento, sexo,
          empresa, telefono, correo, departamento_id, persona_id, motivo_id, categoria_id, sede_id,
          departamento_txt, motivo_txt, visitado, acompanantes, vehiculo, placa, pertenencias,
          temperatura, observaciones, estado, requiere_aprobacion, entrada, preregistro_id,
          operador_id, operador_nombre)
       OUTPUT INSERTED.id
       VALUES
         (@tenant_id, @visitante_id, @codigo, @cedula, @nombre, @fecha_nac, @sexo,
          @empresa, @telefono, @correo, @departamento_id, @persona_id, @motivo_id, @categoria_id, @sede_id,
          @departamento_txt, @motivo_txt, @visitado, @acompanantes, @vehiculo, @placa, @pertenencias,
          @temperatura, @observaciones, 'dentro', @requiere_aprobacion, @entrada, @preregistro_id,
          @operador_id, @operador_nombre)`,
      {
        tenant_id: tenantId,
        visitante_id: visitanteId,
        codigo,
        cedula: ciudadano.cedula || null,
        nombre: ciudadano.nombre_completo,
        fecha_nac: ciudadano.fecha_nacimiento || null,
        sexo: ciudadano.sexo || null,
        empresa: util.limpiar(datos.empresa, 200),
        telefono: util.limpiar(datos.telefono, 40) || (datos.telefono_previo ? util.limpiar(datos.telefono_previo, 40) : null),
        correo: util.correo(datos.correo),
        departamento_id: departamento ? departamento.id : null,
        /* La persona del directorio, si el recepcionista la eligio de la lista.
           Es opcional: tambien se puede escribir el nombre a mano. */
        persona_id: datos.persona_id ? util.entero(datos.persona_id, 0) || null : null,
        motivo_id: motivo ? motivo.id : null,
        categoria_id: datos.categoria_id ? util.entero(datos.categoria_id, 0) : null,
        sede_id: datos.sede_id ? util.entero(datos.sede_id, 0) : req.usuario && req.usuario.sede_id ? req.usuario.sede_id : null,
        departamento_txt: departamento ? departamento.nombre : util.limpiar(datos.departamento_txt, 160),
        motivo_txt: motivo ? motivo.nombre : util.limpiar(datos.motivo_txt, 160),
        visitado: util.limpiar(datos.visitado, 160),
        acompanantes: util.entero(datos.acompanantes, 0, 0, 50),
        vehiculo: util.limpiar(datos.vehiculo, 60),
        placa: util.limpiar(datos.placa, 20),
        pertenencias: util.limpiar(datos.pertenencias, 400),
        temperatura: temperatura,
        observaciones: observaciones(datos, aviso),
        requiere_aprobacion: motivo && motivo.exige_aprobacion ? 1 : 0,
        entrada,
        preregistro_id: preId || null,
        operador_id: req.usuario ? req.usuario.id : null,
        operador_nombre: req.usuario ? req.usuario.nombre : null,
      }
    );

    const visitaId = ins.recordset[0].id;

    // El pre-registro queda usado y enlazado a la visita.
    if (preId) {
      await tx.consultar(
        `UPDATE vf_preregistros SET estado = 'usado', usado = SYSDATETIMEOFFSET(), visita_id = @visita_id
          WHERE tenant_id = @tenant_id AND id = @id AND estado = 'pendiente'`,
        { tenant_id: tenantId, id: preId, visita_id: visitaId }
      );
    }

    // Gafete: se emite siempre; se imprime cuando recepcion lo pida.
    const g = await gafete.emitir(tx, tenantId, visitaId, req.usuario ? req.usuario.nombre : null, datos.plantilla_id);

    return { visitaId, gafete: g, visitanteId };
  });

  // 6. Dejar constancia del aviso de vigilancia y de la decision tomada.
  if (aviso) {
    await vigilancia.registrarAviso(req, {
      vigilancia_id: aviso.id,
      cedula,
      visita_id: resultado.visitaId,
      decision: aviso.bloqueado ? 'permitido' : 'avisado',
      motivo: aviso.bloqueado ? util.limpiar(datos.motivo_autorizacion, 400) : aviso.motivo,
    });
  }

  await auditoria.anotar(req, 'visita.registrar', {
    entidad: 'visita',
    entidad_id: resultado.visitaId,
    detalle:
      ciudadano.nombre_completo +
      (cedula ? ' (' + padron.formatear(cedula) + ')' : '') +
      (departamento ? ' -> ' + departamento.nombre : '') +
      (resolucion.origen === 'padron' ? ' [identidad verificada]' : ' [identidad NO verificada]'),
  });

  const visita = await detalle(tenantId, resultado.visitaId);

  return {
    ok: true,
    visita,
    gafete: resultado.gafete,
    avisos: armarAvisos({ aviso, resolucion, motivo, ciudadano, ajustes }),
  };
}

/** Observaciones de la visita, incluyendo la autorizacion de un bloqueo. */
function observaciones(datos, aviso) {
  const partes = [];
  const obs = util.limpiar(datos.observaciones, 400);
  if (obs) partes.push(obs);
  if (aviso && aviso.bloqueado) {
    partes.push(
      'AUTORIZADO pese a bloqueo. Motivo del bloqueo: ' + aviso.motivo + '. Autorización: ' + util.limpiar(datos.motivo_autorizacion, 300)
    );
  }
  return util.limpiar(partes.join(' | '), 600);
}

/** Avisos que recepcion debe ver despues de registrar. */
function armarAvisos({ aviso, resolucion, motivo, ciudadano, ajustes }) {
  const avisos = [];
  if (aviso && aviso.bloqueado) {
    avisos.push({ nivel: 'peligro', texto: 'Cédula bloqueada, autorizada expresamente: ' + aviso.motivo });
  } else if (aviso && aviso.observado) {
    avisos.push({ nivel: 'aviso', texto: 'Visitante observado: ' + aviso.motivo });
  }
  if (resolucion.origen !== 'padron') {
    avisos.push({
      nivel: 'aviso',
      texto: 'La identidad NO se pudo verificar contra la base de cédulas. Quedó registrada como no verificada.',
    });
  }
  if (motivo && motivo.avisa_anfitrion) {
    avisos.push({ nivel: 'info', texto: 'Este motivo avisa al anfitrión: ' + (motivo.nombre || '') });
  }
  if (motivo && motivo.exige_aprobacion) {
    avisos.push({ nivel: 'aviso', texto: 'Esta visita queda pendiente de aprobación antes de la entrada definitiva.' });
  }
  if (ciudadano && ciudadano.edad !== null && ciudadano.edad < 18) {
    avisos.push({ nivel: 'aviso', texto: 'El visitante es menor de edad (' + ciudadano.edad + ' años).' });
  }
  return avisos;
}

/** Alta o actualizacion del visitante dentro de una transaccion. */
async function guardarVisitante(tx, tenantId, ciudadano, datos, verificado) {
  const cedula = ciudadano.cedula || '';
  const existente = cedula
    ? await tx.consultar('SELECT id FROM vf_visitantes WHERE tenant_id = @tenant_id AND cedula = @cedula', {
        tenant_id: tenantId,
        cedula,
      })
    : { recordset: [] };

  if (existente.recordset.length) {
    const id = existente.recordset[0].id;
    await tx.consultar(
      `UPDATE vf_visitantes
          SET nombres = COALESCE(@nombres, nombres),
              apellidos = COALESCE(@apellidos, apellidos),
              nombre_completo = COALESCE(@nombre_completo, nombre_completo),
              fecha_nacimiento = COALESCE(@fecha_nac, fecha_nacimiento),
              sexo = COALESCE(@sexo, sexo),
              nacionalidad = COALESCE(@nacionalidad, nacionalidad),
              estado_civil = COALESCE(@estado_civil, estado_civil),
              ocupacion = COALESCE(@ocupacion, ocupacion),
              municipio = COALESCE(@municipio, municipio),
              provincia = COALESCE(@provincia, provincia),
              telefono = COALESCE(@telefono, telefono),
              correo = COALESCE(@correo, correo),
              empresa = COALESCE(@empresa, empresa),
              en_padron = CASE WHEN @verificado = 1 THEN 1 ELSE en_padron END,
              validado = CASE WHEN @verificado = 1 THEN SYSDATETIMEOFFSET() ELSE validado END,
              visitas_total = visitas_total + 1,
              actualizado = SYSDATETIMEOFFSET()
        WHERE id = @id`,
      {
        id,
        nombres: ciudadano.nombres,
        apellidos: ciudadano.apellidos,
        nombre_completo: ciudadano.nombre_completo,
        fecha_nac: ciudadano.fecha_nacimiento || null,
        sexo: ciudadano.sexo || null,
        nacionalidad: ciudadano.nacionalidad || null,
        estado_civil: ciudadano.estado_civil || null,
        ocupacion: ciudadano.ocupacion || null,
        municipio: ciudadano.municipio || null,
        provincia: ciudadano.provincia || null,
        telefono: util.limpiar(datos.telefono, 40),
        correo: util.correo(datos.correo),
        empresa: util.limpiar(datos.empresa, 200),
        verificado: verificado ? 1 : 0,
      }
    );
    return id;
  }

  const ins = await tx.consultar(
    `INSERT INTO vf_visitantes
       (tenant_id, cedula, cedula_formato, nombres, apellidos, nombre_completo, fecha_nacimiento,
        sexo, nacionalidad, estado_civil, ocupacion, municipio, provincia, telefono, correo,
        empresa, en_padron, validado, visitas_total)
     OUTPUT INSERTED.id
     VALUES
       (@tenant_id, @cedula, @cedula_formato, @nombres, @apellidos, @nombre_completo, @fecha_nac,
        @sexo, @nacionalidad, @estado_civil, @ocupacion, @municipio, @provincia, @telefono, @correo,
        @empresa, @en_padron, @validado, 1)`,
    {
      tenant_id: tenantId,
      cedula,
      cedula_formato: ciudadano.cedula_formato || (cedula ? padron.formatear(cedula) : null),
      nombres: ciudadano.nombres,
      apellidos: ciudadano.apellidos,
      nombre_completo: ciudadano.nombre_completo,
      fecha_nac: ciudadano.fecha_nacimiento || null,
      sexo: ciudadano.sexo || null,
      nacionalidad: ciudadano.nacionalidad || null,
      estado_civil: ciudadano.estado_civil || null,
      ocupacion: ciudadano.ocupacion || null,
      municipio: ciudadano.municipio || null,
      provincia: ciudadano.provincia || null,
      telefono: util.limpiar(datos.telefono, 40),
      correo: util.correo(datos.correo),
      empresa: util.limpiar(datos.empresa, 200),
      en_padron: verificado ? 1 : 0,
      validado: verificado ? new Date() : null,
    }
  );
  return ins.recordset[0].id;
}

/* ------------------------------------------------------------------ */
/* Salida                                                              */
/* ------------------------------------------------------------------ */

/** Registra la salida de una visita. */
async function registrarSalida(req, visitaId, datos) {
  const tenantId = req.tenant_id;
  const r = await bd.consultar(
    'SELECT id, codigo, estado, entrada, nombre_completo FROM vf_visitas WHERE tenant_id = @tenant_id AND id = @id',
    { tenant_id: tenantId, id: visitaId }
  );
  if (!r.recordset.length) return { ok: false, motivo: 'No se encontró esa visita.' };

  const v = r.recordset[0];
  if (v.estado === 'salida') return { ok: false, motivo: 'Esa visita ya tiene la salida registrada.' };
  if (v.estado === 'anulada' || v.estado === 'denegada') {
    return { ok: false, motivo: 'Esa visita está ' + v.estado + ' y no admite salida.' };
  }

  const obs = util.limpiar(datos && datos.observaciones, 400);

  /* Hora de salida. Normalmente es "ahora"; en desarrollo se puede indicar otra
     para que el generador de demostracion cierre visitas de dias anteriores.
     Nunca se acepta una salida ANTERIOR a la entrada: eso dejaria duraciones
     negativas en los reportes. */
  let salida = new Date();
  if (!config.esProduccion() && datos && datos.fecha_salida) {
    const f = new Date(datos.fecha_salida);
    if (!Number.isNaN(f.getTime()) && f.getTime() > new Date(v.entrada).getTime()) salida = f;
  }

  await bd.consultar(
    `UPDATE vf_visitas
        SET estado = 'salida',
            salida = @salida,
            salida_operador = @operador,
            observaciones = CASE WHEN @obs IS NULL THEN observaciones
                                 ELSE LEFT(COALESCE(observaciones + ' | ', '') + @obs, 600) END
      WHERE tenant_id = @tenant_id AND id = @id`,
    { tenant_id: tenantId, id: visitaId, operador: req.usuario ? req.usuario.nombre : null, obs, salida }
  );

  // El gafete se marca como devuelto si estaba pendiente.
  await gafete.marcarDevuelto(tenantId, visitaId);

  /* Y se cierran los avisos de esa visita.
     Un aviso dice "llegó alguien a verle". Cuando esa persona ya se fue, el
     aviso no sirve para nada y solo ensucia la pantalla de Recepcion: si no se
     cierra, despues de una semana de trabajo hay cientos de avisos antiguos
     tapando los del dia. */
  try {
    await avisos.marcarLeidosDeVisita(tenantId, visitaId);
  } catch (e) {
    // Que no se pueda cerrar el aviso no puede impedir registrar la salida.
  }

  await auditoria.anotar(req, 'visita.salida', {
    entidad: 'visita',
    entidad_id: visitaId,
    detalle: v.nombre_completo + ' (' + v.codigo + ')',
  });

  return { ok: true, visita: await detalle(tenantId, visitaId) };
}

/** Cierra por codigo de gafete o de visita (lector de barras / QR). */
async function salidaPorCodigo(req, codigo) {
  const tenantId = req.tenant_id;
  const c = util.limpiar(codigo, 40);
  if (!c) return { ok: false, motivo: 'Indique el código del gafete.' };

  const r = await bd.consultar(
    `SELECT TOP 1 id FROM vf_visitas
      WHERE tenant_id = @tenant_id AND codigo = @codigo AND estado = 'dentro'`,
    { tenant_id: tenantId, codigo: c }
  );
  if (!r.recordset.length) {
    return { ok: false, motivo: 'No hay ninguna visita abierta con el código ' + c + '.' };
  }
  return registrarSalida(req, r.recordset[0].id, {});
}

/* ------------------------------------------------------------------ */
/* Consultas                                                           */
/* ------------------------------------------------------------------ */

/** Detalle completo de una visita. */
async function detalle(tenantId, id) {
  const r = await bd.consultar(
    `SELECT v.*, u.nombre AS operador, t.zona_horaria
       FROM vf_visitas v
       LEFT JOIN vf_usuarios u ON u.id = v.operador_id
       LEFT JOIN vf_tenants t ON t.id = v.tenant_id
      WHERE v.tenant_id = @tenant_id AND v.id = @id`,
    { tenant_id: tenantId, id }
  );
  const v = r.recordset[0];
  if (!v) return null;

  const zona = v.zona_horaria;
  const minutos = v.salida ? util.minutosEntre(v.entrada, v.salida) : util.minutosEntre(v.entrada, new Date());

  return {
    id: v.id,
    codigo: v.codigo,
    cedula: v.cedula,
    cedula_formato: v.cedula ? padron.formatear(v.cedula) : null,
    nombre_completo: v.nombre_completo,
    fecha_nacimiento: util.fechaISO(v.fecha_nacimiento),
    edad: padron.edad(v.fecha_nacimiento),
    sexo: v.sexo,
    empresa: v.empresa,
    telefono: v.telefono,
    correo: v.correo,
    departamento: v.departamento_txt,
    /* Los identificadores de los catalogos, no solo el texto. Los necesita el
       aviso al anfitrion para saber a quien avisar, y los reportes para agrupar
       por persona o por departamento. */
    departamento_id: v.departamento_id,
    motivo_id: v.motivo_id,
    persona_id: v.persona_id,
    motivo: v.motivo_txt,
    visitado: v.visitado,
    acompanantes: v.acompanantes,
    vehiculo: v.vehiculo,
    placa: v.placa,
    pertenencias: v.pertenencias,
    temperatura: v.temperatura,
    observaciones: v.observaciones,
    estado: v.estado,
    requiere_aprobacion: Boolean(v.requiere_aprobacion),
    aprobada: v.aprobada,
    aprobada_por: v.aprobada_por,
    entrada: v.entrada,
    entrada_legible: util.fechaLegible(v.entrada, zona),
    salida: v.salida,
    salida_legible: util.fechaLegible(v.salida, zona),
    minutos: minutos,
    duracion: util.duracionLegible(minutos),
    operador: v.operador_nombre || v.operador,
    salida_operador: v.salida_operador,
  };
}

/**
 * Lista de visitas con filtros. Es la consulta que usan la bitacora, el panel
 * de "visitantes dentro" y los reportes.
 */
async function listar(tenantId, filtros) {
  const f = filtros || {};
  const p = util.paginacion(f);
  const condiciones = ['v.tenant_id = @tenant_id'];
  const parametros = { tenant_id: tenantId };

  if (f.estado) {
    const estados = String(f.estado).split(',').map((e) => e.trim()).filter(Boolean);
    if (estados.length === 1) {
      condiciones.push('v.estado = @estado');
      parametros.estado = estados[0];
    } else if (estados.length > 1) {
      condiciones.push('v.estado IN (' + estados.map((e, i) => '@estado' + i).join(', ') + ')');
      estados.forEach((e, i) => (parametros['estado' + i] = e));
    }
  }
  if (f.desde) {
    condiciones.push('v.entrada >= @desde');
    parametros.desde = f.desde;
  }
  if (f.hasta) {
    condiciones.push('v.entrada < DATEADD(day, 1, @hasta)');
    parametros.hasta = f.hasta;
  }
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
  if (f.texto) {
    condiciones.push('(v.nombre_completo LIKE @texto OR v.cedula LIKE @texto OR v.codigo LIKE @texto OR v.visitado LIKE @texto OR v.empresa LIKE @texto)');
    parametros.texto = '%' + String(f.texto).trim() + '%';
  }
  if (f.cedula) {
    condiciones.push('v.cedula = @cedula');
    parametros.cedula = padron.soloDigitos(f.cedula);
  }
  if (util.booleano(f.largas, false)) {
    const ajustes = await ajustesDe(tenantId);
    condiciones.push("v.estado = 'dentro' AND DATEDIFF(minute, v.entrada, SYSDATETIMEOFFSET()) > @minutos");
    parametros.minutos = util.entero(ajustes.alerta_visita_larga, 240);
  }
  if (util.booleano(f.sin_aprobar, false)) {
    condiciones.push('v.requiere_aprobacion = 1 AND v.aprobada IS NULL');
  }

  const donde = condiciones.join(' AND ');
  const orden = ordenSeguro(f.orden);

  const total = await bd.consultar(`SELECT COUNT(*) AS n FROM vf_visitas v WHERE ${donde}`, parametros);
  const filas = await bd.consultar(
    `SELECT v.id, v.codigo, v.cedula, v.nombre_completo, v.empresa, v.departamento_txt, v.motivo_txt,
            v.departamento_id, v.motivo_id, v.persona_id,
            v.visitado, v.estado, v.entrada, v.salida, v.requiere_aprobacion, v.aprobada,
            v.acompanantes, v.vehiculo, t.zona_horaria,
            DATEDIFF(minute, v.entrada, COALESCE(v.salida, SYSDATETIMEOFFSET())) AS minutos
       FROM vf_visitas v
       JOIN vf_tenants t ON t.id = v.tenant_id
      WHERE ${donde}
      ORDER BY ${orden}
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
      codigo: v.codigo,
      cedula: v.cedula,
      cedula_formato: v.cedula ? padron.formatear(v.cedula) : null,
      nombre: v.nombre_completo,
      empresa: v.empresa,
      departamento: v.departamento_txt,
      departamento_id: v.departamento_id,
      motivo_id: v.motivo_id,
      persona_id: v.persona_id,
      motivo: v.motivo_txt,
      visitado: v.visitado,
      estado: v.estado,
      entrada: v.entrada,
      salida: v.salida,
      entrada_legible: util.fechaLegible(v.entrada, v.zona_horaria),
      salida_legible: util.fechaLegible(v.salida, v.zona_horaria),
      minutos: v.minutos,
      duracion: util.duracionLegible(v.minutos),
      requiere_aprobacion: Boolean(v.requiere_aprobacion),
      aprobada: v.aprobada,
      acompanantes: v.acompanantes,
      vehiculo: v.vehiculo,
    })),
  };
}

/** Orden permitido, para no interpolar texto del navegador en el SQL. */
function ordenSeguro(valor) {
  const opciones = {
    recientes: 'v.entrada DESC',
    antiguas: 'v.entrada ASC',
    nombre: 'v.nombre_completo ASC',
    duracion: 'minutos DESC',
  };
  return opciones[String(valor || 'recientes')] || opciones.recientes;
}

/** Aprobar una visita que exige autorizacion. */
async function aprobar(req, visitaId, datos) {
  const tenantId = req.tenant_id;
  const r = await bd.consultar(
    'SELECT id, codigo, nombre_completo, requiere_aprobacion, aprobada FROM vf_visitas WHERE tenant_id = @tenant_id AND id = @id',
    { tenant_id: tenantId, id: visitaId }
  );
  if (!r.recordset.length) return { ok: false, motivo: 'No se encontró esa visita.' };
  const v = r.recordset[0];
  if (!v.requiere_aprobacion) return { ok: false, motivo: 'Esa visita no requiere aprobación.' };
  if (v.aprobada) return { ok: false, motivo: 'Esa visita ya estaba aprobada.' };

  const quien = util.limpiar(datos && datos.aprobada_por, 160) || (req.usuario ? req.usuario.nombre : null);
  await bd.consultar(
    'UPDATE vf_visitas SET aprobada = SYSDATETIMEOFFSET(), aprobada_por = @quien WHERE tenant_id = @tenant_id AND id = @id',
    { tenant_id: tenantId, id: visitaId, quien }
  );
  await auditoria.anotar(req, 'visita.aprobar', {
    entidad: 'visita',
    entidad_id: visitaId,
    detalle: v.nombre_completo + ' (' + v.codigo + ') aprobada por ' + quien,
  });
  return { ok: true, visita: await detalle(tenantId, visitaId) };
}

/** Anular o denegar una visita. */
async function anular(req, visitaId, datos) {
  const tenantId = req.tenant_id;
  const estado = (datos && datos.estado === 'denegada' ? 'denegada' : 'anulada');
  const motivo = util.limpiar(datos && datos.motivo, 400);
  if (estado === 'denegada' && !motivo) return { ok: false, motivo: 'Indique el motivo de la denegación.' };

  const r = await bd.consultar(
    'SELECT id, codigo, nombre_completo, estado FROM vf_visitas WHERE tenant_id = @tenant_id AND id = @id',
    { tenant_id: tenantId, id: visitaId }
  );
  if (!r.recordset.length) return { ok: false, motivo: 'No se encontró esa visita.' };
  if (r.recordset[0].estado === 'salida') return { ok: false, motivo: 'No se puede anular una visita que ya salió.' };

  await bd.consultar(
    `UPDATE vf_visitas
        SET estado = @estado,
            salida = COALESCE(salida, SYSDATETIMEOFFSET()),
            salida_operador = @operador,
            observaciones = LEFT(COALESCE(observaciones + ' | ', '') + @motivo, 600)
      WHERE tenant_id = @tenant_id AND id = @id`,
    {
      tenant_id: tenantId,
      id: visitaId,
      estado,
      operador: req.usuario ? req.usuario.nombre : null,
      motivo: '[' + estado.toUpperCase() + '] ' + (motivo || 'sin motivo indicado'),
    }
  );
  await gafete.marcarDevuelto(tenantId, visitaId);
  await auditoria.anotar(req, 'visita.' + estado, {
    entidad: 'visita',
    entidad_id: visitaId,
    detalle: r.recordset[0].nombre_completo + ' - ' + (motivo || 'sin motivo'),
  });
  return { ok: true, visita: await detalle(tenantId, visitaId) };
}

/**
 * Cierra las visitas que quedaron abiertas de dias anteriores.
 * Pasa todos los dias y evita que el panel amanezca con gente "dentro" que en
 * realidad se fue sin registrar la salida.
 */
async function cerrarVisitasVencidas(tenantId, horas) {
  const limite = util.entero(horas, 16, 1, 240);
  const r = await bd.consultar(
    `UPDATE vf_visitas
        SET estado = 'salida',
            salida = DATEADD(minute, @limite, entrada),
            salida_operador = 'cierre automático',
            observaciones = LEFT(COALESCE(observaciones + ' | ', '') + 'Salida no registrada: cerrada automáticamente.', 600)
      WHERE tenant_id = @tenant_id
        AND estado = 'dentro'
        AND entrada < DATEADD(hour, -@limite, SYSDATETIMEOFFSET())`,
    { tenant_id: tenantId, limite }
  );
  return { cerradas: r.rowsAffected[0] || 0, horas: limite };
}

module.exports = {
  ajustesDe,
  resumen,
  prepararRegistro,
  catalogosDe,
  visitanteConocido,
  ultimaVisita,
  registrarEntrada,
  registrarSalida,
  salidaPorCodigo,
  detalle,
  listar,
  aprobar,
  anular,
  cerrarVisitasVencidas,
  validarRegistro,
};
