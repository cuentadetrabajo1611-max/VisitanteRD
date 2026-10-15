/**
 * VisitaFlow - Gestor de licencia de la instalacion.
 *
 * Responsabilidades:
 *   1. Cargar el archivo .vflow (de disco o de una variable de entorno).
 *   2. Verificar la firma con la llave publica incrustada.
 *   3. Evaluar vigencia y modulos habilitados.
 *   4. Traer el tenant de la licencia cuando la base esta vacia (primer arranque).
 *   5. Guardar el estado en la base y en la bitacora de revisiones.
 *   6. Avisar cuando esta por vencer o cuando entro en gracia.
 *
 * IMPORTANTE: la aplicacion NUNCA decide sola que la licencia es valida a
 * partir de lo que diga la base de datos. La base solo guarda una copia del
 * archivo firmado; la verdad se establece verificando la firma cada vez. Asi,
 * editar la tabla de licencias no sirve de nada.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const lic = require('./licencia');
const bd = require('../db');

let estadoActual = {
  cargada: false,
  valida: false,
  estado: 'sin_licencia',
  motivo: 'Todavía no se ha cargado ninguna licencia.',
  contenido: null,
  dias_restantes: 0,
  en_gracia: false,
  modulos: [],
  origen: null,
  revisada: null,
};

let avisos = [];

/* ------------------------------------------------------------------ */
/* Huella de la instalacion                                            */
/* ------------------------------------------------------------------ */

/**
 * Identificador estable del equipo, para amarrar una licencia a una maquina.
 * Se arma con el nombre del equipo y la primera MAC no interna. No es
 * infalible (una maquina virtual se puede clonar), pero es suficiente para el
 * proposito: evitar que una licencia de un equipo se use en varios.
 */
function huella() {
  const partes = [os.hostname(), os.platform(), os.arch()];
  const redes = os.networkInterfaces();
  for (const nombre of Object.keys(redes).sort()) {
    for (const iface of redes[nombre] || []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        partes.push(iface.mac);
        break;
      }
    }
    if (partes.length > 3) break;
  }
  return crypto.createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 32);
}

/** Descripcion legible del equipo, para mostrarla en la pantalla de licencia. */
function descripcionEquipo() {
  return {
    huella: huella(),
    nombre: os.hostname(),
    sistema: os.platform() + ' ' + os.release(),
    arquitectura: os.arch(),
    procesadores: os.cpus().length,
    memoria_gb: Math.round(os.totalmem() / 1073741824),
  };
}

/* ------------------------------------------------------------------ */
/* Carga del archivo                                                   */
/* ------------------------------------------------------------------ */

/** Texto de la licencia: primero la variable de entorno, luego el archivo. */
function textoLicencia() {
  if (process.env.LICENCIA_TEXTO && process.env.LICENCIA_TEXTO.trim()) {
    return { texto: process.env.LICENCIA_TEXTO, origen: 'entorno' };
  }
  const ruta = config.licencia.archivo;
  if (fs.existsSync(ruta)) {
    return { texto: fs.readFileSync(ruta, 'utf8'), origen: 'archivo:' + ruta };
  }
  return null;
}

/** Evalua un texto de licencia sin tocar la base de datos. */
function evaluarTexto(texto, origen) {
  const evaluacion = lic.evaluar(texto, {
    huella: huella(),
    aviso_dias: config.licencia.diasAviso,
  });
  return Object.assign(evaluacion, { origen: origen || 'memoria' });
}

/* ------------------------------------------------------------------ */
/* Carga inicial                                                       */
/* ------------------------------------------------------------------ */

/**
 * Carga la licencia al arrancar. Si no hay archivo, intenta recuperar de la
 * base la ultima licencia guardada (util cuando el contenedor se recrea sin
 * volver a montar el archivo).
 */
async function cargar() {
  let entrada = textoLicencia();

  // Sin archivo ni variable: se busca la ultima licencia guardada en la base.
  if (!entrada) {
    try {
      const r = await bd.consultar(
        'SELECT TOP 1 archivo, licencia_id FROM vf_licencias ORDER BY activada DESC'
      );
      if (r.recordset.length && r.recordset[0].archivo) {
        entrada = { texto: r.recordset[0].archivo, origen: 'base:' + r.recordset[0].licencia_id };
      }
    } catch (e) {
      // La base puede no existir todavia en el primer arranque: no es un error.
    }
  }

  if (!entrada) {
    estadoActual = {
      cargada: false,
      valida: false,
      estado: 'sin_licencia',
      motivo:
        'No se encontró ninguna licencia. Coloque el archivo en ' +
        config.licencia.archivo +
        ' o defina LICENCIA_TEXTO.',
      contenido: null,
      dias_restantes: 0,
      en_gracia: false,
      modulos: [],
      origen: null,
      revisada: new Date().toISOString(),
    };
    avisos = ['El sistema no tiene licencia cargada. Las operaciones comerciales estarán restringidas.'];
    return estadoActual;
  }

  try {
    const evaluacion = evaluarTexto(entrada.texto, entrada.origen);
    estadoActual = Object.assign({}, evaluacion, {
      cargada: true,
      revisada: new Date().toISOString(),
    });
    actualizarAvisos();
    await registrarRevision('local', estadoActual);
    if (estadoActual.valida) await guardarEnBase(entrada.texto, estadoActual);
  } catch (e) {
    estadoActual = {
      cargada: true,
      valida: false,
      estado: 'invalida',
      motivo: e.message,
      contenido: null,
      dias_restantes: 0,
      en_gracia: false,
      modulos: [],
      origen: entrada.origen,
      revisada: new Date().toISOString(),
    };
    avisos = ['La licencia no se pudo leer: ' + e.message];
    await registrarRevision('local', estadoActual);
  }

  return estadoActual;
}

function actualizarAvisos() {
  const a = [];
  if (!estadoActual.valida) {
    a.push(estadoActual.motivo || 'La licencia no es válida.');
  } else if (estadoActual.estado === 'por_vencer') {
    a.push('La licencia vence en ' + estadoActual.dias_restantes + ' día(s). Renuévela para no interrumpir el servicio.');
  } else if (estadoActual.estado === 'gracia') {
    a.push(estadoActual.motivo);
  }
  avisos = a;
}

/* ------------------------------------------------------------------ */
/* Persistencia                                                        */
/* ------------------------------------------------------------------ */

/**
 * Guarda (o actualiza) la licencia de esta instalacion.
 *
 * OJO CON EL NOMBRE DE LA INSTITUCION: solo se escribe al CREARLA. Si ya existe,
 * NO se toca.
 *
 * El motivo es concreto: el nombre de la institucion es un dato que el cliente
 * puede editar en la pantalla de Personalizacion, y ese cambio es el que manda.
 * Si cada activacion o renovacion de licencia reescribiera el nombre con lo que
 * diga el archivo, se perderia lo que el cliente configuro. Paso de verdad: una
 * licencia de prueba emitida para otro nombre dejo la institucion renombrada.
 */
async function guardarEnBase(texto, evaluacion) {
  const c = evaluacion.contenido;
  if (!c) return;

  await bd.consultar(
    `MERGE vf_tenants AS destino
       USING (SELECT @codigo AS codigo) AS origen
          ON destino.codigo = origen.codigo
     WHEN MATCHED THEN
       -- El nombre NO se actualiza: lo manda el cliente desde Personalizacion.
       UPDATE SET actualizado = SYSDATETIMEOFFSET()
     WHEN NOT MATCHED THEN
       INSERT (codigo, nombre, nombre_comercial, contacto_correo, estado)
       VALUES (@codigo, @nombre, @nombre, @correo, 'activo');`,
    {
      codigo: c.tenant,
      nombre: c.cliente || c.tenant_nombre || c.tenant,
      correo: c.contacto || null,
    }
  );

  await bd.consultar(
    `MERGE vf_licencias AS destino
       USING (SELECT @licencia_id AS licencia_id) AS origen
          ON destino.licencia_id = origen.licencia_id
     WHEN MATCHED THEN
       UPDATE SET key_id = @key_id, cliente = @cliente, tipo = @tipo,
                  desde = @desde, hasta = @hasta, gracia_dias = @gracia,
                  modulos = @modulos, limite_usuarios = @lim_usuarios,
                  limite_instalaciones = @lim_instalaciones, huella = @huella,
                  archivo = @archivo, estado = @estado,
                  ultima_revision = SYSDATETIMEOFFSET()
     WHEN NOT MATCHED THEN
       INSERT (tenant_id, licencia_id, key_id, cliente, tipo, desde, hasta,
               gracia_dias, modulos, limite_usuarios, limite_instalaciones,
               huella, archivo, estado, ultima_revision)
       VALUES ((SELECT id FROM vf_tenants WHERE codigo = @tenant),
               @licencia_id, @key_id, @cliente, @tipo, @desde, @hasta,
               @gracia, @modulos, @lim_usuarios, @lim_instalaciones,
               @huella, @archivo, @estado, SYSDATETIMEOFFSET());`,
    {
      tenant: c.tenant,
      licencia_id: c.licencia_id,
      key_id: c.key_id || null,
      cliente: c.cliente || null,
      tipo: c.tipo || null,
      desde: c.desde ? c.desde.slice(0, 10) : null,
      hasta: c.hasta ? c.hasta.slice(0, 10) : null,
      gracia: c.gracia_dias || 15,
      modulos: (c.modulos || []).join(','),
      lim_usuarios: c.limites ? c.limites.usuarios : null,
      lim_instalaciones: c.limites ? c.limites.instalaciones : null,
      huella: c.huella || null,
      archivo: texto,
      estado: evaluacion.estado,
    }
  );
}

/** Anota cada revision de licencia. Sirve para auditar cuando dejo de renovarse. */
async function registrarRevision(origen, evaluacion, mensaje) {
  try {
    let tenantId = null;
    if (evaluacion.contenido && evaluacion.contenido.tenant) {
      const t = await bd.consultar('SELECT id FROM vf_tenants WHERE codigo = @codigo', {
        codigo: evaluacion.contenido.tenant,
      });
      if (t.recordset.length) tenantId = t.recordset[0].id;
    }
    await bd.consultar(
      `INSERT INTO vf_licencias_revisiones (tenant_id, origen, resultado, estado, mensaje, ip)
       VALUES (@tenant_id, @origen, @resultado, @estado, @mensaje, NULL)`,
      {
        tenant_id: tenantId,
        origen,
        resultado: evaluacion.valida ? 'ok' : 'invalida',
        estado: evaluacion.estado,
        mensaje: mensaje || evaluacion.motivo || null,
      }
    );
  } catch (e) {
    // La bitacora no puede tumbar el arranque del sistema.
  }
}

/* ------------------------------------------------------------------ */
/* Guardia de modulos                                                  */
/* ------------------------------------------------------------------ */

/** Si la licencia habilita un modulo. El admin de licencias siempre pasa. */
function tieneModulo(nombre) {
  if (!estadoActual.cargada) return false;
  if (!estadoActual.valida) return false;
  return (estadoActual.modulos || []).includes(nombre);
}

/**
 * Estado publico para la pantalla de licencia.
 * No expone el contenido completo de la licencia, solo lo que se muestra.
 */
function estado() {
  const c = estadoActual.contenido;
  return {
    cargada: estadoActual.cargada,
    valida: estadoActual.valida,
    estado: estadoActual.estado,
    motivo: estadoActual.motivo,
    origen: estadoActual.origen,
    revisada: estadoActual.revisada,
    dias_restantes: estadoActual.dias_restantes,
    en_gracia: estadoActual.en_gracia,
    avisos,
    modulos: estadoActual.modulos || [],
    modulos_disponibles: lic.MODULOS,
    licencia: c
      ? {
          licencia_id: c.licencia_id,
          cliente: c.cliente,
          tenant: c.tenant,
          tipo: c.tipo,
          desde: c.desde,
          hasta: c.hasta,
          gracia_dias: c.gracia_dias,
          limites: c.limites,
          huella: c.huella,
          notas: c.notas,
        }
      : null,
    equipo: descripcionEquipo(),
  };
}

/** Estado interno (con el contenido completo). Solo para uso del propio modulo. */
function estadoInterno() {
  return estadoActual;
}

/**
 * Activa una licencia recibida como texto (desde el servidor de licencias o
 * pegada a mano). Verifica la firma ANTES de guardar nada.
 */
async function activar(texto, origen) {
  const evaluacion = evaluarTexto(texto, origen || 'manual');
  if (!evaluacion.contenido) {
    return { ok: false, motivo: evaluacion.motivo || 'La licencia no es válida.' };
  }
  if (!evaluacion.valida && evaluacion.estado !== 'vencida' && evaluacion.estado !== 'no_vigente') {
    return { ok: false, motivo: evaluacion.motivo || 'La licencia no es válida.' };
  }

  estadoActual = Object.assign({}, evaluacion, { cargada: true, revisada: new Date().toISOString() });
  actualizarAvisos();
  await guardarEnBase(texto, estadoActual);
  await registrarRevision(origen || 'manual', estadoActual);

  // Se deja copia en disco, para que sobreviva a un reinicio del proceso sin
  // volver a activar. La ruta cae dentro de la carpeta de datos, que en el VPS
  // es un volumen: si se escribiera fuera, el redespliegue se llevaria la
  // licencia por delante.
  try {
    fs.mkdirSync(path.dirname(config.licencia.archivo), { recursive: true });
    fs.writeFileSync(config.licencia.archivo, texto, { mode: 0o600 });
  } catch (e) {
    /* si el volumen es de solo lectura, la copia en base es suficiente */
  }

  return { ok: estadoActual.valida, estado: estadoActual.estado, motivo: estadoActual.motivo, evaluacion: estadoActual };
}

/**
 * Consulta al servidor de licencias si hay una licencia mas nueva.
 * Si el servidor no responde, el sistema SIGUE funcionando con lo que tiene:
 * esa es la promesa de que no depende de Internet.
 */
async function renovarDesdeServidor() {
  if (!config.licencia.servidor) {
    return { ok: false, motivo: 'No hay servidor de licencias configurado.' };
  }
  const contenido = estadoActual.contenido;
  if (!contenido) return { ok: false, motivo: 'No hay licencia cargada que renovar.' };

  const url = config.licencia.servidor.replace(/\/+$/, '') + '/api/licencia/consultar';
  const cuerpo = JSON.stringify({
    tenant: contenido.tenant,
    licencia_id: contenido.licencia_id,
    huella: huella(),
    equipo: descripcionEquipo(),
  });

  try {
    const respuesta = await pedir(url, cuerpo);
    if (!respuesta.ok) {
      await registrarRevision('servidor', { valida: false, estado: 'sin_conexion', motivo: respuesta.motivo });
      return { ok: false, motivo: respuesta.motivo };
    }
    const datos = respuesta.datos;
    if (!datos || !datos.licencia) {
      await registrarRevision('servidor', { valida: false, estado: 'ok', motivo: 'sin cambios' });
      return { ok: false, motivo: 'El servidor no devolvió ninguna licencia.', sinCambios: true };
    }
    const resultado = await activar(datos.licencia, 'servidor');
    return resultado;
  } catch (e) {
    await registrarRevision('servidor', { valida: false, estado: 'sin_conexion', motivo: e.message });
    return { ok: false, motivo: 'No se pudo contactar el servidor de licencias: ' + e.message };
  }
}

/**
 * Activa el sistema con el ID de la licencia.
 *
 * ESTA ES LA PUERTA DEL PRIMER ARRANQUE. El cliente instala el sistema y lo
 * unico que tiene es un ID (LIC-XXXX). Con ese ID se pregunta al servidor de
 * licencias, que devuelve la licencia firmada de ESE cliente, y a partir de ahi
 * el sistema crea su institucion, sus catalogos y su administrador.
 *
 * Antes de esto habia que mandarle al cliente un archivo .vflow por correo y que
 * lo pegara a mano. Con el ID no hace falta ningun archivo: se escribe el ID y
 * ya esta.
 *
 * Casos que hay que distinguir bien, porque el cliente esta mirando la pantalla:
 *
 *   - No hay servidor configurado  -> se lo decimos, y que use el archivo.
 *   - El ID no existe              -> el servidor lo dice.
 *   - Esta suspendido              -> el servidor manda el motivo, y se muestra:
 *                                     "no funciona" sin explicacion es lo peor
 *                                     que se le puede decir a alguien.
 *   - El servidor no responde      -> se puede seguir con el archivo .vflow.
 */
async function activarPorId(licenciaId) {
  const id = String(licenciaId || '').trim().toUpperCase();
  if (!id) return { ok: false, motivo: 'Escriba el ID de la licencia.' };

  if (!config.licencia.servidor) {
    return {
      ok: false,
      motivo: 'Esta instalación no tiene configurado el servidor de licencias. ' +
        'Puede activarla pegando el archivo .vflow, o pida que le configuren LICENCIA_SERVIDOR.',
      sinServidor: true,
    };
  }

  const url = config.licencia.servidor.replace(/\/+$/, '') + '/api/licencia/activar-por-id';

  let respuesta;
  try {
    respuesta = await pedir(url, JSON.stringify({ licencia_id: id, huella: huella(), equipo: descripcionEquipo() }));
  } catch (e) {
    return {
      ok: false,
      motivo: 'No se pudo contactar el servidor de licencias (' + e.message + '). ' +
        'Compruebe la conexión, o active el sistema pegando el archivo .vflow.',
      sinConexion: true,
    };
  }

  if (!respuesta.ok) {
    // El servidor explica por que: ID inexistente, suspendida, vencida...
    return { ok: false, motivo: respuesta.motivo || 'El servidor rechazó esa licencia.', rechazada: true };
  }

  const datos = respuesta.datos || {};
  if (!datos.licencia) return { ok: false, motivo: 'El servidor no devolvió ninguna licencia.' };

  // Se activa igual que si viniera de un archivo: misma verificacion de firma,
  // mismo guardado, mismo registro en la base. No hay dos caminos distintos.
  const resultado = await activar(datos.licencia, 'servidor:id');

  if (resultado.ok) {
    // Se deja copia del ID para poder renovar despues sin volver a pedirlo.
    try {
      await guardarIdDeLicencia(id);
    } catch (e) {
      /* si no se puede guardar el ID, la licencia ya quedo activada igual */
    }
  }

  return Object.assign({}, resultado, {
    licencia_id: datos.licencia_id || id,
    cliente: datos.cliente || null,
    hasta: datos.hasta || null,
  });
}

/** Deja el ID anotado, para poder renovar despues sin volver a pedirlo. */
async function guardarIdDeLicencia(id) {
  await bd.consultar(
    `MERGE vf_ajustes AS destino
       USING (SELECT @tenant_id AS tenant_id, 'licencia_id' AS clave) AS origen
          ON destino.tenant_id = origen.tenant_id AND destino.clave = origen.clave
     WHEN MATCHED THEN UPDATE SET valor = @valor
     WHEN NOT MATCHED THEN INSERT (tenant_id, clave, valor) VALUES (@tenant_id, 'licencia_id', @valor);`,
    { tenant_id: estadoActual.contenido ? await idDeTenant(estadoActual.contenido.tenant) : null, valor: id }
  );
}

/** El id interno de una institucion por su codigo. */
async function idDeTenant(codigo) {
  const r = await bd.consultar('SELECT id FROM vf_tenants WHERE codigo = @c', { c: codigo });
  return r.recordset.length ? r.recordset[0].id : null;
}

/** El ID de licencia guardado en esta instalacion, si lo hay. */
async function idGuardado() {
  try {
    const r = await bd.consultar("SELECT TOP 1 valor FROM vf_ajustes WHERE clave = 'licencia_id' ORDER BY id DESC");
    return r.recordset.length ? r.recordset[0].valor : null;
  } catch (e) {
    return null;
  }
}

/** Peticion HTTP sin dependencias externas. */
function pedir(url, cuerpo) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const modulo = u.protocol === 'https:' ? require('https') : require('http');
    const req = modulo.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(cuerpo),
          Authorization: 'Bearer ' + (config.licencia.tokenActivacion || ''),
        },
        timeout: 12000,
      },
      (res) => {
        let datos = '';
        res.on('data', (c) => (datos += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(datos);
          } catch (e) {
            /* respuesta no JSON */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, datos: json });
          } else {
            resolve({ ok: false, motivo: (json && json.mensaje) || 'El servidor respondió ' + res.statusCode });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('tiempo de espera agotado'));
    });
    req.on('error', reject);
    req.write(cuerpo);
    req.end();
  });
}

/**
 * Firma del archivo de licencia: fecha de modificacion y tamano.
 *
 * Sirve para darse cuenta de que el archivo cambio sin tener que leerlo y
 * evaluarlo entero. Es lo que permite revisar la licencia a menudo sin coste.
 */
function firmaDelArchivo() {
  try {
    const st = fs.statSync(config.licencia.archivo);
    return st.mtimeMs + ':' + st.size;
  } catch (e) {
    return 'sin-archivo';
  }
}

/**
 * Revisa la licencia periodicamente. No bloquea el arranque.
 *
 * Se comprueba la firma del archivo en cada vuelta, que es una llamada barata, y
 * solo se recarga cuando de verdad cambio. El intervalo es corto (dos minutos)
 * porque eso ahora no cuesta nada, y en cambio evita lo que pasaba antes: al
 * reemplazar el archivo de licencia, el sistema seguia con el anterior en
 * memoria hasta seis horas despues.
 */
function vigilar(intervaloMinutos) {
  const ms = (intervaloMinutos || 2) * 60000;
  let firma = firmaDelArchivo();

  const t = setInterval(async () => {
    const ahora = firmaDelArchivo();
    if (ahora === firma) return; // el archivo no cambió: no hay nada que hacer
    firma = ahora;
    await cargar();
  }, ms);
  if (t.unref) t.unref();
  return t;
}

module.exports = {
  huella,
  descripcionEquipo,
  cargar,
  estado,
  estadoInterno,
  tieneModulo,
  activar,
  activarPorId,
  idGuardado,
  renovarDesdeServidor,
  vigilar,
  MODULOS: lic.MODULOS,
};
