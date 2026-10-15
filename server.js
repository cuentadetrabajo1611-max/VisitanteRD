/**
 * VisitaFlow - Servidor principal.
 *
 * Arranque:
 *   node server.js            (o npm start)
 *   node server-licencias.js  (servidor de licencias, en el VPS)
 *
 * La aplicacion NO necesita Internet para funcionar. La red solo se usa para
 * dos cosas opcionales: activar o renovar la licencia contra el servidor de
 * licencias.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const bd = require('./src/db');
const util = require('./src/util');
const gestor = require('./src/licencias/gestor');
const { rutas } = require('./src/rutas');
const mantenimiento = require('./src/mantenimiento');

const app = express();

/* ------------------------------------------------------------------ */
/* Ajustes generales                                                   */
/* ------------------------------------------------------------------ */

// Detras de nginx/Traefik en el VPS: sin esto, la IP de la bitacora seria la
// del proxy y no la del visitante.
if (config.servidor.detrasDeProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cors({ origin: true, credentials: true }));

/* Limite de intentos en las rutas sensibles. Es un contador en memoria: si el
   sistema corre en un solo proceso (como aqui y en el VPS con Dokploy), basta
   y no hace falta una dependencia mas.

   Solo se cuentan los intentos FALLIDOS. Contar tambien los exitosos castigaria
   a una recepcion legitima que entra y sale varias veces al dia, que es
   exactamente lo que hace este sistema. */
const intentos = new Map();
function limitar(clave, maximo, ventanaMs) {
  return (req, res, next) => {
    const id = clave + ':' + util.ip(req);
    const ahora = Date.now();
    const registro = intentos.get(id) || { n: 0, desde: ahora };
    if (ahora - registro.desde > ventanaMs) {
      registro.n = 0;
      registro.desde = ahora;
    }

    if (registro.n >= maximo) {
      const segundos = Math.max(1, Math.ceil((ventanaMs - (ahora - registro.desde)) / 1000));
      res.setHeader('Retry-After', String(segundos));
      return res.status(429).json({ ok: false, mensaje: 'Demasiados intentos fallidos. Espere ' + segundos + ' segundos.' });
    }

    // El intento se anota solo cuando la respuesta sale mal.
    res.on('finish', () => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        registro.n++;
        intentos.set(id, registro);
      } else if (res.statusCode < 400) {
        // Un acceso correcto limpia el contador de esa IP.
        registro.n = 0;
        registro.desde = ahora;
        intentos.set(id, registro);
      }
    });

    next();
  };
}

// Se limpia el mapa de vez en cuando para que no crezca sin fin.
const limpieza = setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of intentos) if (ahora - v.desde > 3600000) intentos.delete(k);
}, 600000);
if (limpieza.unref) limpieza.unref();

/* Registro de peticiones, breve, sin datos personales. */
app.use((req, res, next) => {
  const inicio = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') && res.statusCode >= 400) {
      console.log(
        '[visitaflow] ' + req.method + ' ' + req.path + ' -> ' + res.statusCode + ' (' + (Date.now() - inicio) + ' ms)'
      );
    }
  });
  next();
});

/* ------------------------------------------------------------------ */
/* Estaticos                                                           */
/* ------------------------------------------------------------------ */

/* En desarrollo NO se cachea: mientras se trabaja en la interfaz, recargar la
   pagina tiene que traer los archivos nuevos. En produccion si se cachea, que
   es lo que conviene cuando el sistema ya esta en uso. */
const cacheEstaticos = config.esProduccion() ? '1h' : 0;
app.use(express.static(path.join(config.raiz, 'public'), { extensions: ['html'], maxAge: cacheEstaticos }));

// Archivos subidos (logos de cada institucion). Se sirven sin cache larga para
// que cambiar el logo se vea al recargar.
const carpetaArchivos = config.archivos.carpeta;
fs.mkdirSync(carpetaArchivos, { recursive: true });
app.use('/archivos', express.static(carpetaArchivos, { maxAge: '10m' }));

/* ------------------------------------------------------------------ */
/* Rutas de la API                                                     */
/* ------------------------------------------------------------------ */

/* Los limitadores se construyen UNA sola vez. Si se construyeran en cada
   peticion se crearia un objeto nuevo cada vez, que es trabajo tirado. */
const limiteLicencia = require('./src/acceso').licencia(gestor);
const limiteEntrar = limitar('entrar', 12, 5 * 60000);
const limiteRecuperar = limitar('recuperar', 6, 15 * 60000);

const api = rutas({ gestor });

// Los limites se aplican antes que el enrutador para esas dos rutas concretas.
app.use('/api/acceso/entrar', limiteEntrar);
app.use('/api/acceso/recuperar', limiteRecuperar);

// Todas las rutas pasan por la comprobacion de licencia.
app.use('/api', limiteLicencia);

app.use('/api', api);

/* Cualquier otra direccion de la API es un 404 en JSON, no en HTML. */
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, mensaje: 'Esa dirección no existe en la API: ' + req.method + ' ' + req.originalUrl });
});

/* El resto de direcciones sirven la aplicacion (rutas del navegador). */
app.get('*', (req, res, next) => {
  const index = path.join(config.raiz, 'public', 'index.html');
  if (!fs.existsSync(index)) return next();
  res.sendFile(index);
});

/* ------------------------------------------------------------------ */
/* Manejo de errores                                                   */
/* ------------------------------------------------------------------ */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return util.responderError(res, util.error(413, 'El contenido enviado es demasiado grande.'));
  }
  if (err && err.type === 'entity.parse.failed') {
    return util.responderError(res, util.error(400, 'El contenido enviado no es JSON válido.'));
  }
  util.responderError(res, err);
});

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function prepararBase() {
  // El usuario de la licencia es la fuente de la verdad del tenant. Al guardar
  // la licencia se crea o actualiza su institucion.
  const estado = await gestor.cargar();

  if (!estado.contenido) {
    console.warn('[visitaflow] Arrancando SIN licencia válida: ' + estado.motivo);
    console.warn('[visitaflow] El sistema queda en modo de solo lectura hasta que active una licencia.');
    return;
  }

  // Si la base no existe, aqui se va a fallar. No es motivo para tumbar el
  // servidor: se avisa y se sigue, para poder crearla con el contenedor arriba.
  let t;
  try {
    t = await mantenimiento.porCodigo(estado.contenido.tenant);
  } catch (e) {
    console.error('[visitaflow] No se pudo preparar la institución: la base del sistema no responde.');
    console.error('[visitaflow] Créela con: node sql/01-crear.js');
    return;
  }

  if (!t) {
    console.warn('[visitaflow] La licencia es de "' + estado.contenido.tenant + '" pero la institución no se pudo crear.');
    return;
  }

  // Primer arranque: se deja la institucion usable sin tocar SQL a mano.
  const resumen = await mantenimiento.prepararTenant(t.id, { sembrarCatalogos: true });
  const creados = resumen.permisos + resumen.ajustes + resumen.departamentos + resumen.motivos + resumen.categorias + resumen.sedes + resumen.plantilla;
  if (creados > 0) {
    console.log('[visitaflow] Institución "' + t.codigo + '" preparada (' + creados + ' registros iniciales).');
  }

  // Un administrador con clave por defecto es un agujero. Se avisa fuerte y se
  // deja la clave en un archivo local para que la cambien.
  const admins = await bd.consultar(
    "SELECT COUNT(*) AS n FROM vf_usuarios WHERE tenant_id = @tenant_id AND rol = 'admin' AND activo = 1",
    { tenant_id: t.id }
  );
  if (!admins.recordset[0].n) {
    const clave = generarClaveInicial();
    const admin = await mantenimiento.crearAdmin(t.id, {
      correo: process.env.ADMIN_CORREO || 'admin@' + t.codigo + '.local',
      clave,
      nombre: 'Administrador',
    });
    /* Las credenciales se dejan DENTRO de la carpeta de datos, que en el VPS es
       un volumen. Si se escribieran en la raiz del proyecto, un redespliegue se
       las llevaria y habria que restablecer la contrasena a mano. */
    const ruta = path.join(config.archivos.datos, 'CLAVE-ADMINISTRADOR.txt');
    try {
      fs.mkdirSync(config.archivos.datos, { recursive: true });
      fs.writeFileSync(
        ruta,
        'VisitaFlow - credenciales iniciales de la institución "' + t.codigo + '"\n' +
          '=========================================================\n\n' +
          '  Dirección  : ' + (config.servidor.urlPublica || 'http://localhost:' + config.servidor.puerto) + '\n' +
          '  Institución: ' + t.codigo + '\n' +
          '  Usuario    : ' + (process.env.ADMIN_CORREO || 'admin@' + t.codigo + '.local') + '\n' +
          '  Contraseña : ' + clave + '\n\n' +
          'CAMBie esta contraseña al entrar (Usuarios → restablecer) y BORRE este archivo.\n',
        { mode: 0o600 }
      );
      const relativa = path.relative(config.raiz, ruta) || ruta;
      // El recuadro se arma con la ruta ya recortada, para que los bordes
      // queden alineados aunque el nombre de la institucion sea largo.
      const aviso = 'La contraseña quedó en: ' + relativa;
      console.log('');
      console.log('  ┌──────────────────────────────────────────────────────────────┐');
      console.log('  │  Se creó el administrador inicial de la institución.         │');
      console.log('  │  Usuario: ' + (process.env.ADMIN_CORREO || 'admin@' + t.codigo + '.local').padEnd(51).slice(0, 51) + '│');
      console.log('  │  ' + aviso.padEnd(60).slice(0, 60) + '│');
      console.log('  │  Cámbiela y borre ese archivo.                             │');
      console.log('  └──────────────────────────────────────────────────────────────┘');
      console.log('');
    } catch (e) {
      // Si no se puede escribir, la clave se muestra una sola vez y queda claro
      // que hay que anotarla: es mejor que dejarla en un archivo que no existe.
      console.warn('');
      console.warn('  Se creó el administrador inicial de la institución "' + t.codigo + '".');
      console.warn('  Usuario   : ' + (process.env.ADMIN_CORREO || 'admin@' + t.codigo + '.local'));
      console.warn('  Contraseña: ' + clave);
      console.warn('  (no se pudo escribir el archivo de credenciales: ' + e.message + ')');
      console.warn('  ANOTE la contraseña ahora: no se vuelve a mostrar.');
      console.warn('');
    }
  }
}

/** Clave inicial legible pero no adivinable. */
function generarClaveInicial() {
  const crypto = require('crypto');
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let clave = '';
  for (let i = 0; i < 14; i++) clave += alfabeto[bytes[i] % alfabeto.length];
  return clave + '!7';
}

async function arrancar() {
  const avisos = config.revisar();
  for (const a of avisos) console.warn('[visitaflow] AVISO: ' + a);

  // Conexion a la base del sistema.
  //
  // Si la base no existe todavia (despliegue nuevo), el servidor NO se cae: se
  // levanta y responde, avisando de lo que falta. Asi la reparacion se puede
  // hacer con el contenedor en marcha:
  //
  //     docker exec -it visitaflow-app node sql/01-crear.js
  //
  // Caerse aqui dejaba el contenedor reiniciandose en bucle y sin forma de
  // entrar a arreglarlo. La comprobacion de salud reporta el problema, que es
  // lo que necesitan ver Docker y Dokploy.
  try {
    await bd.conectarSistema();
    console.log('[visitaflow] Base de datos conectada: ' + config.bd.sistema.server + '/' + config.bd.sistema.database);
  } catch (e) {
    console.error('');
    console.error('  ATENCION: no se pudo conectar a la base del sistema.');
    console.error('  Motivo: ' + e.message);
    console.error('');
    console.error('  El servidor arranca igual, pero /api/salud reportará la falla y no se');
    console.error('  podrá registrar nada hasta que la base exista. Para crearla:');
    console.error('');
    console.error('    node sql/01-crear.js                    (local)');
    console.error('    docker exec -it visitaflow-app node sql/01-crear.js   (en el VPS)');
    console.error('');
    console.error('  Revise DB_SERVER, DB_USER, DB_PASSWORD y DB_DATABASE en el archivo .env');
    console.error('');
  }

  // Base de cedulas (opcional).
  await bd.conectarPadron();
  const salud = bd.saludPadron();
  if (salud.disponible) {
    console.log('[visitaflow] Base de cédulas conectada: ' + salud.base + ' (' + config.bd.tablaPadron + ')');
  } else {
    console.warn('[visitaflow] Base de cédulas NO disponible (' + salud.motivo + ').');
    console.warn('[visitaflow] El registro funcionará con datos escritos a mano.');
  }

  await prepararBase();

  /* Revision periodica de la licencia.
     Cada dos minutos se mira la FECHA del archivo, que es barato, y solo se
     recarga si cambio. Antes se revisaba cada seis horas y recargando siempre:
     al reemplazar la licencia, el sistema seguia con la anterior en memoria
     buena parte del dia. */
  gestor.vigilar(2);

  const servidor = http.createServer(app);
  servidor.listen(config.servidor.puerto, config.servidor.host, () => {
    const url = config.servidor.urlPublica || 'http://localhost:' + config.servidor.puerto;
    console.log('');
    console.log('  VisitaFlow en marcha');
    console.log('  ─────────────────────────────────────────────');
    console.log('  Dirección : ' + url);
    console.log('  Entorno   : ' + config.servidor.entorno);
    console.log('  Licencia  : ' + gestor.estado().estado + (gestor.estado().licencia ? ' — ' + gestor.estado().licencia.cliente : ''));
    console.log('');
    const avisosLic = gestor.estado().avisos;
    for (const a of avisosLic) console.warn('  AVISO: ' + a);
    if (avisosLic.length) console.log('');
  });

  /* Apagado ordenado: se cierran los pools para no dejar conexiones colgadas
     cuando Dokploy reinicia el contenedor. */
  const apagar = async (senal) => {
    console.log('\n[visitaflow] ' + senal + ': cerrando...');
    servidor.close(async () => {
      await bd.cerrar();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));

  return servidor;
}

if (require.main === module) {
  arrancar().catch((e) => {
    console.error('[visitaflow] No se pudo arrancar:', e);
    process.exit(1);
  });
}

module.exports = { app, arrancar };
