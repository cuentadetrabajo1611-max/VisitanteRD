/**
 * VisitaFlow - Acceso a SQL Server.
 *
 * Dos pools separados a proposito:
 *   sistema -> base propia del sistema (lectura/escritura), donde vive todo,
 *              con la columna tenant_id separando una institucion de otra.
 *   padron  -> base de cedulas (SOLO LECTURA). Nunca se escribe aqui.
 *
 * Todas las consultas pasan por estas funciones, asi que los tipos de parametro
 * se declaran en un solo sitio. Eso importa: en SQL Server, mandar un NVARCHAR
 * contra una columna VARCHAR anula el uso del indice y convierte una busqueda de
 * 10 ms en un recorrido de tabla de mas de 2 segundos.
 */
'use strict';

const path = require('path');
const config = require('./config');

const sql = require(path.join(config.raiz, 'node_modules', 'mssql'));

let poolSistema = null;
let poolPadron = null;
let estadoPadron = { disponible: false, motivo: 'sin probar', desde: null };

function opcionesPool(cfg) {
  return {
    server: cfg.server,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
      enableArithAbort: true,
      // El padron dominicano guarda cedulas con acentos en los nombres.
      useUTC: false,
    },
    pool: { max: 20, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: cfg.msEspera || 30000,
  };
}

/** Conecta (o reutiliza) el pool del sistema. */
async function conectarSistema() {
  if (poolSistema && poolSistema.connected) return poolSistema;
  poolSistema = await new sql.ConnectionPool(opcionesPool(config.bd.sistema)).connect();
  return poolSistema;
}

/**
 * Conecta el pool del padron. Si la base no existe o esta apagada, NO se cae el
 * sistema: se marca como no disponible y la busqueda por cedula queda
 * deshabilitada, pero registrar visitas manualmente sigue funcionando.
 */
async function conectarPadron() {
  if (poolPadron && poolPadron.connected) return poolPadron;
  if (!config.bd.padronActivo) {
    estadoPadron = { disponible: false, motivo: 'deshabilitado por configuracion', desde: new Date().toISOString() };
    return null;
  }
  try {
    const cfg = opcionesPool(Object.assign({}, config.bd.padron, { msEspera: config.bd.msEsperaPadron }));
    poolPadron = await new sql.ConnectionPool(cfg).connect();
    estadoPadron = { disponible: true, motivo: null, desde: new Date().toISOString() };
    return poolPadron;
  } catch (e) {
    poolPadron = null;
    estadoPadron = { disponible: false, motivo: e.message, desde: new Date().toISOString() };
    return null;
  }
}

/** Estado del padron para /api/salud y para avisar en pantalla. */
function saludPadron() {
  return Object.assign({}, estadoPadron, {
    configurado: config.bd.padronActivo,
    base: config.bd.padron.database,
  });
}

/** Pool del sistema, conectando si hace falta. */
async function bd() {
  return conectarSistema();
}

/** Pool del padron, o null si no esta disponible. */
async function padron() {
  if (!poolPadron || !poolPadron.connected) await conectarPadron();
  if (!poolPadron || !poolPadron.connected) return null;
  return poolPadron;
}

/**
 * Ejecuta una consulta en la base del sistema.
 *   const r = await consultar('SELECT * FROM vf_tenants WHERE id = @id', { id: 1 });
 * Los parametros se tipan solos, salvo que se indique lo contrario.
 */
async function consultar(texto, parametros, opciones) {
  const pool = await bd();
  const req = pool.request();
  aplicarParametros(req, parametros, opciones);
  if (opciones && opciones.espera) req.timeout = opciones.espera;
  return req.query(texto);
}

/** Ejecuta una consulta en la base del padron (solo lectura). */
async function consultarPadron(texto, parametros, opciones) {
  const pool = await padron();
  if (!pool) throw new Error('La base de cédulas no está disponible: ' + (estadoPadron.motivo || 'sin conexión'));
  const req = pool.request();
  aplicarParametros(req, parametros, opciones);
  if (opciones && opciones.espera) req.timeout = opciones.espera;
  return req.query(texto);
}

/**
 * Declara cada parametro con su tipo. Sin esto, el driver manda NVARCHAR y las
 * columnas VARCHAR del padron pierden el indice.
 */
function aplicarParametros(req, parametros, opciones) {
  if (!parametros) return;
  const tipos = (opciones && opciones.tipos) || {};
  for (const [nombre, valor] of Object.entries(parametros)) {
    req.input(nombre, tipos[nombre] || inferirTipo(valor), valor);
  }
}

/**
 * Tipo del parametro, deducido del valor.
 *
 * OJO CON LAS FECHAS. Un objeto Date se envia como DateTimeOffset, NO como
 * DateTime2. La diferencia no es cosmetica: las columnas de fecha del sistema
 * son DATETIMEOFFSET, y al declarar el parametro como DateTime2 el driver manda
 * la hora local del proceso, SQL Server la guarda con offset +00:00, y el
 * instante queda corrido tantas horas como el desfase de la zona. Medido en
 * esta maquina (servidor en UTC-4): la hora de entrada de cada visita quedaba
 * 4 horas atras, con duraciones y reportes equivocados.
 *
 * Se puede comprobar con:  node scripts/probar-insercion-fecha.js
 */
function inferirTipo(valor) {
  if (valor === null || valor === undefined) return sql.NVarChar(sql.MAX);
  if (typeof valor === 'boolean') return sql.Bit;
  if (Number.isInteger(valor)) return sql.Int;
  if (typeof valor === 'number') return sql.Decimal(18, 4);
  if (valor instanceof Date) return sql.DateTimeOffset;
  return sql.NVarChar(sql.MAX);
}

/**
 * Ejecuta una consulta dentro de una transaccion y revierte si algo falla.
 *   await transaccion(async (tx) => { await tx.consultar(...); });
 */
async function transaccion(fn) {
  const pool = await bd();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  const envoltorio = {
    consultar: async (texto, parametros, opciones) => {
      const req = new sql.Request(tx);
      aplicarParametros(req, parametros, opciones);
      return req.query(texto);
    },
  };
  try {
    const resultado = await fn(envoltorio);
    await tx.commit();
    return resultado;
  } catch (e) {
    try {
      await tx.rollback();
    } catch (_) {
      /* si la conexion ya se cayo, el rollback no aporta nada */
    }
    throw e;
  }
}

/** Comprueba si existe un objeto (tabla, vista) en la base del sistema. */
async function existeObjeto(nombre) {
  const r = await consultar('SELECT OBJECT_ID(@nombre, @tipo) AS id', { nombre, tipo: 'U' }, { tipos: { nombre: sql.NVarChar(256), tipo: sql.NVarChar(2) } });
  return Boolean(r.recordset[0] && r.recordset[0].id);
}

/** Lista las tablas de la base del sistema (para diagnostico). */
async function tablasSistema() {
  const r = await consultar(
    "SELECT name, create_date FROM sys.tables WHERE name LIKE 'vf[_]%' ORDER BY name"
  );
  return r.recordset;
}

/** Cierra los pools. Se usa al apagar el servidor y en las pruebas. */
async function cerrar() {
  const cierres = [];
  if (poolSistema) cierres.push(poolSistema.close().catch(() => {}));
  if (poolPadron) cierres.push(poolPadron.close().catch(() => {}));
  poolSistema = null;
  poolPadron = null;
  await Promise.all(cierres);
}

module.exports = {
  sql,
  bd,
  padron,
  consultar,
  consultarPadron,
  transaccion,
  existeObjeto,
  tablasSistema,
  saludPadron,
  conectarSistema,
  conectarPadron,
  cerrar,
  tipos: {
    varChar: (n) => sql.VarChar(n),
    nVarChar: (n) => sql.NVarChar(n),
    int: sql.Int,
    bigint: sql.BigInt,
    bit: sql.Bit,
    decimal: (p, s) => sql.Decimal(p, s),
    date: sql.Date,
    /* Las columnas de fecha y hora del sistema son DATETIMEOFFSET: guardan el
       instante CON su zona. Si se enviaran como DateTime2, el driver y SQL
       Server no se pondrian de acuerdo sobre a que zona pertenece el valor, y
       la hora se correria tantas horas como el desfase del servidor (medido:
       4 horas en esta maquina, que producia duraciones negativas). */
    fechaHora: sql.DateTimeOffset,
    dateTime2: sql.DateTimeOffset,
    texto: sql.NVarChar(sql.MAX),
  },
};
