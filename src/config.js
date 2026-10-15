/**
 * VisitaFlow - Configuracion centralizada.
 *
 * Todo se lee del entorno (.env en local, variables de Docker/Dokploy en el
 * VPS). Ningun secreto queda escrito en el codigo.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const RAIZ = path.resolve(__dirname, '..');

function texto(nombre, porDefecto) {
  const v = process.env[nombre];
  return v === undefined || v === '' ? porDefecto : v;
}

function numero(nombre, porDefecto) {
  const v = Number(process.env[nombre]);
  return Number.isFinite(v) ? v : porDefecto;
}

function booleano(nombre, porDefecto) {
  const v = process.env[nombre];
  if (v === undefined || v === '') return porDefecto;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(v).toLowerCase());
}

/** Arma la configuracion de un pool de SQL Server a partir de un prefijo. */
function poolSql(prefijo, porDefecto) {
  const d = porDefecto || {};
  return {
    server: texto(prefijo + '_SERVER', d.server || 'localhost'),
    port: numero(prefijo + '_PORT', d.port || 1433),
    user: texto(prefijo + '_USER', d.user || 'sa'),
    password: texto(prefijo + '_PASSWORD', d.password || ''),
    database: texto(prefijo + '_DATABASE', d.database || ''),
    encrypt: booleano(prefijo + '_ENCRYPT', false),
    trustServerCertificate: booleano(prefijo + '_TRUST_CERT', true),
  };
}

const config = {
  raiz: RAIZ,

  servidor: {
    puerto: numero('PORT', 3000),
    host: texto('HOST', '0.0.0.0'),
    entorno: texto('NODE_ENV', 'development'),
    // Detras de nginx/Traefik en el VPS hace falta confiar en el proxy para
    // que la IP real del visitante quede en la bitacora.
    detrasDeProxy: booleano('DETRAS_DE_PROXY', true),
    urlPublica: texto('URL_PUBLICA', ''),
  },

  sesion: {
    secreto: texto('JWT_SECRET', 'cambie-este-secreto-en-produccion'),
    expira: texto('JWT_EXPIRA', '12h'),
    // Minutos que dura la sesion sin actividad antes de exigir de nuevo la clave.
    minutosInactividad: numero('SESION_MINUTOS_INACTIVIDAD', 0),
  },

  bd: {
    sistema: poolSql('DB', { database: 'VisitaFlow' }),
    // Base del padron, ya sin fotografias. Es opcional: si no esta configurada,
    // el sistema funciona igual y solo pierde el autocompletado por cedula.
    padron: poolSql('PADRON_DB', {
      server: texto('DB_SERVER', 'localhost'),
      port: numero('DB_PORT', 1433),
      user: texto('DB_USER', 'sa'),
      password: texto('DB_PASSWORD', ''),
      database: texto('PADRON_DATABASE', 'PadronLigero'),
    }),
    padronActivo: booleano('PADRON_ACTIVO', true),
    tablaPadron: texto('PADRON_TABLA', 'dbo.CIUDADANOS'),
    // Tiempo maximo que puede tardar una consulta al padron antes de rendirse.
    msEsperaPadron: numero('PADRON_MS_ESPERA', 15000),
    cifrarConexion: booleano('DB_ENCRYPT', false),
  },

  licencia: {
    /* Archivo .vflow que carga la instalacion.
       Vive dentro de la carpeta de datos, que en el VPS es un volumen: la
       licencia tiene que sobrevivir a los redespliegues. */
    archivo: texto('LICENCIA_ARCHIVO', path.join(RAIZ, 'datos', 'licencia.vflow')),
    privadaArchivo: texto('LICENCIA_LLAVE_PRIVADA_ARCHIVO', path.join(RAIZ, 'licencias-keys', 'privada.pem')),
    publicaArchivo: texto('LICENCIA_LLAVE_PUBLICA_ARCHIVO', path.join(RAIZ, 'licencias-keys', 'publica.pem')),
    // Servidor de licencias: para activar y para renovar.
    servidor: texto('LICENCIA_SERVIDOR', ''),
    tokenActivacion: texto('LICENCIA_TOKEN_ACTIVACION', ''),
    // Si no hay servidor alcanzable, cuanto tiempo se sigue operando con la
    // ultima licencia buena que se verifico.
    horasSinServidor: numero('LICENCIA_HORAS_SIN_SERVIDOR', 72),
    diasAviso: numero('LICENCIA_DIAS_AVISO', 30),
  },

  // Llave que protege las rutas de administracion del servidor de licencias.
  adminToken: texto('ADMIN_TOKEN', ''),

  identidad: {
    // Que datos del padron se pueden mostrar en pantalla.
    mostrarNombres: booleano('IDENTIDAD_MOSTRAR_NOMBRES', true),
    mostrarFechaNacimiento: booleano('IDENTIDAD_MOSTRAR_FECHA_NACIMIENTO', true),
    mostrarSexo: booleano('IDENTIDAD_MOSTRAR_SEXO', true),
    mostrarMunicipio: booleano('IDENTIDAD_MOSTRAR_MUNICIPIO', true),
    // Exigir que la cedula exista en el padron para poder registrar la visita.
    exigirEnPadron: booleano('IDENTIDAD_EXIGIR_EN_PADRON', false),
    // Edad minima y maxima aceptada al registrar un visitante.
    edadMinima: numero('IDENTIDAD_EDAD_MINIMA', 0),
  },

  archivos: {
    /* Carpeta base donde el sistema guarda lo suyo: los logos subidos y, por
       defecto, la licencia y las credenciales iniciales.

       En el VPS esta carpeta es un VOLUMEN de Docker. Por eso la licencia vive
       aqui dentro y no en la raiz del proyecto: lo que se escribe fuera del
       volumen se pierde en cada redespliegue, y perder la licencia obliga a
       activar el sistema otra vez. */
    datos: texto('DATOS_CARPETA', path.join(RAIZ, 'datos')),
    carpeta: texto('ARCHIVOS_CARPETA', path.join(RAIZ, 'datos', 'archivos')),
    // Limite del logo institucional: 2 MB es mas que suficiente.
    maxLogoBytes: numero('ARCHIVOS_MAX_LOGO_BYTES', 2 * 1024 * 1024),
  },

  correo: {
    activo: booleano('CORREO_ACTIVO', false),
    host: texto('SMTP_HOST', ''),
    puerto: numero('SMTP_PORT', 587),
    usuario: texto('SMTP_USER', ''),
    clave: texto('SMTP_PASS', ''),
    remitente: texto('MAIL_FROM', 'VisitaFlow <no-responder@visitaflow.local>'),
  },

  auditoria: {
    activa: booleano('AUDITORIA_ACTIVA', true),
    diasRetencion: numero('AUDITORIA_DIAS_RETENCION', 730),
  },

  esProduccion() {
    return config.servidor.entorno === 'production';
  },
};

/** Avisos de configuracion peligrosa. Se muestran al arrancar. */
config.revisar = function revisar() {
  const avisos = [];
  if (config.esProduccion() && config.sesion.secreto === 'cambie-este-secreto-en-produccion') {
    avisos.push('JWT_SECRET sigue con el valor de ejemplo. Cambielo antes de publicar el sistema.');
  }
  if (config.esProduccion() && !config.adminToken) {
    avisos.push('ADMIN_TOKEN esta vacio: las rutas de administracion del servidor de licencias quedan abiertas.');
  }
  if (!config.bd.sistema.password) {
    avisos.push('DB_PASSWORD esta vacio: no se podra conectar a SQL Server.');
  }
  return avisos;
};

module.exports = config;
