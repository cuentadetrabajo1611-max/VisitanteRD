/**
 * VisitaFlow - Comprobacion de una instalacion recien levantada.
 *
 *   npm run comprobar:instalacion
 *
 * QUE HACE
 * --------
 * Entra al sistema por donde entra un usuario y contesta las cinco preguntas que
 * importan despues de instalar:
 *
 *   1. ¿Responde la aplicacion?
 *   2. ¿Esta la base del sistema?
 *   3. ¿Estan las cedulas?
 *   4. ¿Esta la licencia activa?
 *   5. ¿Hay administrador?
 *
 * Cada fallo sale con la instruccion para arreglarlo, porque quien lee esto
 * acaba de instalar el sistema y no lo conoce.
 *
 * DONDE SE EJECUTA
 * ----------------
 * La base del sistema vive dentro de Docker y no esta publicada al exterior, asi
 * que desde el servidor no siempre se llega a ella. Si no se llega y el
 * contenedor esta arriba, este mismo script se vuelve a ejecutar DENTRO del
 * contenedor, que es donde el sistema corre de verdad. Por eso funciona igual
 * escribiendo "npm run comprobar:instalacion" en el servidor que dentro de la
 * imagen.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const CONTENEDOR = 'visitaflow-app';
const MARCA_DENTRO = 'VF_COMPROBACION_DENTRO';

const C = {
  reset: '\u001b[0m',
  gris: '\u001b[90m',
  rojo: '\u001b[31m',
  verde: '\u001b[32m',
  ambar: '\u001b[33m',
  cian: '\u001b[36m',
  blanco: '\u001b[97m',
};

const fallos = [];
const avisos = [];

function titulo(t) {
  console.log('');
  console.log('  ' + C.cian + t + C.reset);
  console.log('  ' + C.gris + '-'.repeat(66) + C.reset);
}

function bien(t) { console.log('  ' + C.verde + '[ok]' + C.reset + '    ' + t); }
function aviso(t, arreglo) {
  avisos.push(t);
  console.log('  ' + C.ambar + '[aviso]' + C.reset + ' ' + t);
  if (arreglo) console.log('          ' + C.gris + 'arreglo: ' + arreglo + C.reset);
}
function fallo(t, arreglo) {
  fallos.push(t);
  console.log('  ' + C.rojo + '[FALLA]' + C.reset + ' ' + t);
  if (arreglo) console.log('          ' + C.ambar + 'arreglo: ' + arreglo + C.reset);
}
function nota(t) { console.log('          ' + C.gris + t + C.reset); }

/* ------------------------------------------------------------------ */
/* Ayudas                                                              */
/* ------------------------------------------------------------------ */

/** GET con espera maxima: una comprobacion no puede quedarse colgada. */
async function pedir(url, msEspera) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), msEspera || 8000);
  try {
    const r = await fetch(url, { signal: control.signal });
    const texto = await r.text();
    let datos = null;
    try { datos = JSON.parse(texto); } catch (e) { /* respuesta que no es JSON */ }
    return { estado: r.status, ok: r.ok, datos: datos, texto: texto };
  } finally {
    clearTimeout(reloj);
  }
}

function hayDocker() {
  const r = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function contenedorArriba(nombre) {
  const r = spawnSync('docker', ['ps', '--filter', 'name=' + nombre, '--filter', 'status=running', '-q'], { encoding: 'utf8' });
  return !r.error && r.status === 0 && String(r.stdout || '').trim().length > 0;
}

/** Repite la comprobacion dentro del contenedor, que es donde vive la base. */
function comprobarDentroDelContenedor() {
  console.log('');
  nota('La base del sistema no se alcanza desde aqui: vive dentro de Docker.');
  nota('Se comprueba desde el contenedor "' + CONTENEDOR + '".');
  const r = spawnSync(
    'docker',
    ['exec', '-e', MARCA_DENTRO + '=1', CONTENEDOR, 'node', 'scripts/comprobar-instalacion.js'],
    { stdio: 'inherit' }
  );
  if (r.error) {
    console.log('  ' + C.rojo + '[FALLA]' + C.reset + ' no se pudo entrar al contenedor: ' + r.error.message);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

function requerirMssql() {
  try {
    return require(path.join(RAIZ, 'node_modules', 'mssql'));
  } catch (e) {
    return null;
  }
}

/** Conexion a una base, con espera corta: si no esta, hay que decirlo pronto. */
async function conectar(sql, cfg) {
  try {
    const pool = await new sql.ConnectionPool({
      server: cfg.server,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      options: { encrypt: Boolean(cfg.encrypt), trustServerCertificate: cfg.trustServerCertificate !== false, enableArithAbort: true },
      connectionTimeout: 8000,
      requestTimeout: 30000,
    }).connect();
    return { ok: true, pool: pool };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

async function consultar(pool, texto, parametros) {
  const peticion = pool.request();
  for (const k of Object.keys(parametros || {})) peticion.input(k, parametros[k]);
  const r = await peticion.query(texto);
  return r.recordset || [];
}

/* ------------------------------------------------------------------ */
/* 1. La aplicacion                                                    */
/* ------------------------------------------------------------------ */

/**
 * Se prueban varias direcciones porque este script corre en sitios distintos:
 * en el servidor (donde vale localhost) y dentro del contenedor (donde la
 * direccion publica puede no existir, por ejemplo en una institucion sin
 * Internet).
 */
async function comprobarAplicacion(puerto, urlPublica) {
  const candidatas = [];
  if (urlPublica) candidatas.push(urlPublica);
  candidatas.push('http://127.0.0.1:' + puerto);
  candidatas.push('http://localhost:' + puerto);

  const vistas = new Set();
  let ultimoMotivo = '';

  for (const base of candidatas) {
    const url = base.replace(/\/+$/, '') + '/api/salud';
    if (vistas.has(url)) continue;
    vistas.add(url);

    let r;
    try {
      r = await pedir(url, 8000);
    } catch (e) {
      ultimoMotivo = e.message;
      continue;
    }

    if (r.ok && r.datos && r.datos.sistema === 'VisitaFlow') {
      bien('la aplicacion responde en ' + base + ' (version ' + r.datos.version + ', ' + r.datos.ms + ' ms)');
      if (r.datos.entorno !== 'production') {
        aviso('el sistema corre en entorno "' + r.datos.entorno + '" y no en production');
      }
      return { salud: r.datos, base: base };
    }
    ultimoMotivo = 'la respuesta de ' + url + ' no es la del sistema (codigo ' + r.estado + ')';
  }

  fallo('la aplicacion no responde (' + (ultimoMotivo || 'sin respuesta') + ')',
    'Levantela con: docker compose up -d bd-sistema app --no-deps  (o npm start si va sin Docker). ' +
    'Si ya estaba levantada, mire que dice: docker compose logs app');
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. La base del sistema                                              */
/* ------------------------------------------------------------------ */

async function comprobarBase(salud, pool) {
  if (salud && salud.base_datos && salud.base_datos.disponible) {
    bien('la base del sistema responde: ' + salud.base_datos.base);
  } else if (salud) {
    fallo('la base del sistema NO responde: ' + (salud.base_datos && salud.base_datos.motivo ? salud.base_datos.motivo : 'sin detalle'),
      'Compruebe la clave de SQL Server (CLAVE_SQL en el .env y DB_PASSWORD) y que el ' +
      'contenedor de la base este arriba: docker compose ps');
  } else if (pool) {
    /* La aplicacion no respondio, pero la base se puede mirar directamente. */
    try {
      await consultar(pool, 'SELECT 1 AS x');
      bien('la base del sistema responde: ' + pool.config.database);
    } catch (e) {
      fallo('la base del sistema NO responde: ' + e.message,
        'Compruebe la clave de SQL Server y que el contenedor de la base este arriba: docker compose ps');
    }
  }

  if (!pool) return;

  const tablas = await consultar(pool, "SELECT COUNT(*) AS n FROM sys.tables WHERE name LIKE 'vf[_]%'");
  const n = Number(tablas[0].n);
  if (n >= 20) bien('las tablas del sistema estan creadas (' + n + ')');
  else {
    fallo('solo hay ' + n + ' tablas del sistema: la base esta a medio crear',
      'Cree el esquema con: docker exec -it ' + CONTENEDOR + ' node sql/01-crear.js');
    return;
  }

  const instituciones = await consultar(pool, 'SELECT codigo, estado FROM vf_tenants');
  if (instituciones.length) {
    bien('la institucion esta creada: ' + instituciones.map((t) => t.codigo + ' (' + t.estado + ')').join(', '));
  } else {
    fallo('no hay ninguna institucion en la base',
      'Se crea sola al arrancar CON la licencia activada. Active el sistema y reinicie: docker compose restart app');
  }
}

/* ------------------------------------------------------------------ */
/* 3. Las cedulas                                                      */
/* ------------------------------------------------------------------ */

async function comprobarCedulas(sql, config, salud) {
  const cedulas = (salud && salud.cedulas) || null;

  if (!config.bd.padronActivo) {
    aviso('la base de cedulas esta apagada a proposito (PADRON_ACTIVO=0)',
      'El sistema funciona igual, pero los nombres no se rellenan solos. Para instalarlas, ' +
      'vea el PASO 3 de INSTALACION.txt.');
    return;
  }

  if (cedulas && cedulas.disponible) {
    bien('la base de cedulas responde: ' + cedulas.base + ' / ' + cedulas.tabla);
  } else if (cedulas) {
    fallo('la base de cedulas NO responde: ' + (cedulas.motivo || 'sin detalle'),
      'Restaure el respaldo y cree la vista (PASO 3 de INSTALACION.txt): ' +
      'docker exec -it ' + CONTENEDOR + ' node sql/03-vista-ciudadanos.js');
  } else if (!sql) {
    aviso('no se pudo comprobar la base de cedulas',
      'La aplicacion no responde y en este servidor no esta el modulo mssql.');
  }
  if (cedulas && cedulas.exigir_en_padron) {
    nota('con IDENTIDAD_EXIGIR_EN_PADRON=1 no se podra registrar a quien no este en el padron');
  }

  if (!sql || !config.bd.padronActivo) return;

  /* La base puede estar configurada y aun asi faltarle la vista, que es el fallo
     tipico: se restauro el respaldo y se olvido el script. Distinguirlo ahorra
     media hora de busqueda. */
  const conexion = await conectar(sql, config.bd.padron);
  if (!conexion.ok) {
    fallo('no se pudo abrir la base de cedulas "' + config.bd.padron.database + '": ' + conexion.motivo,
      'Compruebe que el respaldo se restauro: docker exec -it visitaflow-bd ' +
      '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "SU_CLAVE" -C -Q "SELECT name FROM sys.databases"');
    return;
  }

  try {
    await consultar(conexion.pool, 'SELECT TOP 1 Cedula FROM ' + config.bd.tablaPadron);
    const filas = await consultar(
      conexion.pool,
      "SELECT SUM(p.rows) AS n FROM sys.partitions p JOIN sys.objects o ON o.object_id = p.object_id WHERE o.name = 'PADRON' AND p.index_id IN (0,1)"
    );
    const total = filas.length ? Number(filas[0].n) : 0;
    bien('la vista de cedulas se puede consultar' + (total ? ' (~' + total.toLocaleString('es-DO') + ' registros)' : ''));
  } catch (e) {
    let hayTabla = false;
    try {
      await consultar(conexion.pool, 'SELECT TOP 1 1 AS x FROM dbo.PADRON');
      hayTabla = true;
    } catch (e2) { /* ni la tabla: el respaldo no se restauro */ }

    if (hayTabla) {
      fallo('el padron esta restaurado pero falta la vista ' + config.bd.tablaPadron + ' (por eso buscar una cedula tarda segundos)',
        'Cree la vista con: docker exec -it ' + CONTENEDOR + ' node sql/03-vista-ciudadanos.js');
    } else {
      fallo('la base "' + config.bd.padron.database + '" no tiene el padron dentro',
        'Restaure el respaldo .bak (PASO 3 de INSTALACION.txt).');
    }
  } finally {
    try { await conexion.pool.close(); } catch (e) { /* da igual al terminar */ }
  }
}

/* ------------------------------------------------------------------ */
/* 4. La licencia                                                      */
/* ------------------------------------------------------------------ */

function comprobarLicencia(salud, config) {
  const lic = (salud && salud.licencia) || null;
  const servidor = (salud && salud.servidor_licencias) || null;

  if (!salud) {
    aviso('no se pudo comprobar la licencia: la aplicacion no responde',
      'Levante el sistema y vuelva a ejecutar esta comprobacion.');
    return;
  }

  if (lic && lic.valida) {
    bien('la licencia esta activa: ' + (lic.cliente || '(sin nombre)') +
      (lic.hasta ? ', vence el ' + String(lic.hasta).slice(0, 10) : '') +
      (Number.isFinite(lic.dias_restantes) ? ' (' + lic.dias_restantes + ' dias)' : ''));
    if (Number.isFinite(lic.dias_restantes) && lic.dias_restantes <= 30) {
      aviso('la licencia vence en ' + lic.dias_restantes + ' dias',
        'Pida la renovacion con tiempo: ' + (servidor && servidor.direccion ? servidor.direccion : 'al proveedor'));
    }
  } else if (lic) {
    fallo('la licencia no esta activa (' + (lic.estado || 'sin licencia') + (lic.motivo ? ': ' + lic.motivo : '') + ')',
      servidor && servidor.configurado
        ? 'Abra el sistema en el navegador: muestra la pantalla de activacion. Escriba ahi el ID (LIC-XXXXXXXX) ' +
          'o pegue el archivo .vflow.'
        : 'Esta instalacion no tiene servidor de licencias configurado (LICENCIA_SERVIDOR): solo se puede ' +
          'activar pegando el archivo .vflow en la pantalla de activacion.');
  }

  if (servidor && !servidor.configurado) {
    aviso('sin servidor de licencias configurado (LICENCIA_SERVIDOR vacio)',
      'Con Internet, ponga la direccion publica del proveedor en el .env y reinicie: docker compose restart app');
  } else if (servidor && servidor.direccion && /licencias:4100|localhost|127\.0\.0\.1/.test(servidor.direccion) && !/localhost|127\.0\.0\.1/.test(config.servidor.urlPublica || '')) {
    /* El error mas caro del despliegue: en el servidor del proveedor funciona y
       en el de un cliente no llega a ninguna parte. */
    aviso('el servidor de licencias apunta a una direccion interna (' + servidor.direccion + ')',
      'Desde este servidor no se podra activar. Ponga la direccion publica del proveedor en LICENCIA_SERVIDOR.');
  }
}

/* ------------------------------------------------------------------ */
/* 5. El administrador                                                 */
/* ------------------------------------------------------------------ */

async function comprobarAdministrador(pool, config) {
  if (pool) {
    const admins = await consultar(
      pool,
      "SELECT COUNT(*) AS n FROM vf_usuarios WHERE rol = 'admin' AND activo = 1"
    );
    const n = Number(admins[0].n);

    if (n > 0) {
      bien('hay ' + n + ' administrador(es) activo(s)');
    } else {
      fallo('no hay ningun administrador activo en la base',
        'Se crea solo al arrancar CON la licencia activada. Active la licencia y reinicie: ' +
        'docker compose restart app');
    }

    const usuarios = await consultar(pool, 'SELECT COUNT(*) AS n FROM vf_usuarios WHERE activo = 1');
    nota('operadores activos: ' + Number(usuarios[0].n));

    /* La clave inicial solo existe si el administrador se acaba de crear: si el
       archivo esta, hay que anotarla y borrarlo. */
    const ruta = path.join(config.archivos.datos, 'CLAVE-ADMINISTRADOR.txt');
    if (fs.existsSync(ruta)) {
      aviso('las credenciales iniciales siguen en ' + ruta,
        'Entre, cambie la contrasena (Usuarios) y borre ese archivo.');
    }
    return;
  }

  /* Sin base a mano queda el archivo de credenciales, que es lo que deja el
     primer arranque: dice si el administrador llego a crearse. */
  const credenciales = require(path.join(__dirname, 'credenciales.js')).leerCredenciales();
  if (credenciales) {
    bien('el administrador existe: ' + credenciales.usuario +
      (credenciales.tenant ? ' (institucion ' + credenciales.tenant + ')' : ''));
    aviso('no se pudo leer la base para confirmarlo; se dedujo del archivo de credenciales',
      'Cambie la contrasena y borre ' + credenciales.ruta);
  } else {
    fallo('no se pudo comprobar el administrador',
      'Ejecute esta comprobacion dentro del contenedor: docker exec -it ' + CONTENEDOR +
      ' node scripts/comprobar-instalacion.js');
  }
}

/* ------------------------------------------------------------------ */
/* Extra: el contenedor de licencias, que en un cliente no va          */
/* ------------------------------------------------------------------ */

function comprobarContenedorLicencias() {
  /* En el servidor del proveedor este servicio SI se usa: solo se avisa si esta
     reiniciandose, que es lo que pasa cuando alguien levanta los tres servicios
     en la instalacion de un cliente. */
  if (!hayDocker()) return;
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} {{.RestartCount}}', 'visitaflow-licencias'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return;
  const estado = String(r.stdout || '').trim();
  if (/^restarting/i.test(estado)) {
    aviso('el contenedor "visitaflow-licencias" se esta reiniciando (' + estado + ')',
      'En una instalacion de cliente ese servicio no se usa (el servidor de licencias es el del ' +
      'proveedor). Parese con: docker compose stop licencias');
  }
}

/* ------------------------------------------------------------------ */
/* Principal                                                           */
/* ------------------------------------------------------------------ */

async function principal() {
  const dentro = process.env[MARCA_DENTRO] === '1' || fs.existsSync('/.dockerenv');
  const rutaEnv = path.join(RAIZ, '.env');

  console.log('');
  console.log('  ' + C.blanco + 'VisitaFlow - como quedo la instalacion' + C.reset);
  console.log('  ' + C.gris + '='.repeat(66) + C.reset);

  if (!dentro && !fs.existsSync(rutaEnv)) {
    console.log('');
    fallo('no hay archivo .env en ' + RAIZ,
      'Prepare la instalacion primero: npm run instalar:cliente');
    console.log('');
    console.log('  ' + C.rojo + 'No se puede comprobar nada sin la configuracion.' + C.reset);
    console.log('');
    return 1;
  }

  const config = require(path.join(RAIZ, 'src', 'config.js'));
  const sql = requerirMssql();

  console.log('  ' + C.gris + 'Direccion : ' + C.reset + (config.servidor.urlPublica || 'http://localhost:' + config.servidor.puerto));
  console.log('  ' + C.gris + 'Base      : ' + C.reset + config.bd.sistema.server + ' / ' + config.bd.sistema.database);
  console.log('  ' + C.gris + 'Entorno   : ' + C.reset + config.servidor.entorno +
    (dentro ? '   (comprobando desde dentro del contenedor)' : ''));

  /* 1. La aplicacion. */
  titulo('1. La aplicacion');
  const aplicacion = await comprobarAplicacion(config.servidor.puerto, config.servidor.urlPublica);
  const salud = aplicacion ? aplicacion.salud : null;

  /* 2 y 5 necesitan la base. Si no se llega desde aqui y el contenedor esta
     arriba, se termina la comprobacion dentro del contenedor. */
  const conexion = sql ? await conectar(sql, config.bd.sistema) : { ok: false, motivo: 'falta el modulo mssql en este servidor' };

  if (!conexion.ok && !dentro && hayDocker() && contenedorArriba(CONTENEDOR)) {
    return comprobarDentroDelContenedor();
  }

  titulo('2. La base del sistema');
  if (!sql) {
    aviso('no esta el modulo mssql, asi que no se puede mirar la base desde aqui',
      'Ejecute: npm install   (o compruebe dentro del contenedor)');
  } else if (!conexion.ok) {
    aviso('no se pudo abrir la base desde donde se ejecuta esto: ' + conexion.motivo,
      'Si el sistema corre en Docker, la base no esta publicada al exterior. Ejecute: docker exec -it ' +
      CONTENEDOR + ' node scripts/comprobar-instalacion.js');
  }
  await comprobarBase(salud, conexion.ok ? conexion.pool : null);

  titulo('3. Las cedulas');
  await comprobarCedulas(sql, config, salud);

  titulo('4. La licencia');
  comprobarLicencia(salud, config);

  titulo('5. El administrador');
  await comprobarAdministrador(conexion.ok ? conexion.pool : null, config);

  if (conexion.ok) {
    try { await conexion.pool.close(); } catch (e) { /* da igual al terminar */ }
  }

  comprobarContenedorLicencias();

  /* Resumen. */
  console.log('');
  console.log('  ' + C.gris + '='.repeat(66) + C.reset);
  if (fallos.length) {
    console.log('  ' + C.rojo + fallos.length + ' comprobacion(es) en rojo:' + C.reset);
    for (const f of fallos) console.log('    ' + C.rojo + '-' + C.reset + ' ' + f);
    console.log('');
    console.log('  ' + C.gris + 'Los pasos completos de esta instalacion estan en INSTALACION.txt' + C.reset);
    console.log('');
    return 1;
  }

  console.log('  ' + C.verde + 'Todo en orden' +
    (avisos.length ? ' (' + avisos.length + ' aviso(s) que no impiden funcionar)' : '') + '.' + C.reset);
  console.log('  ' + C.gris + 'Entre con el usuario administrador y cambie la contrasena inicial.' + C.reset);
  console.log('');
  return 0;
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((e) => {
    console.error('');
    console.error('  ' + C.rojo + 'No se pudo completar la comprobacion: ' + e.message + C.reset);
    console.error('');
    process.exit(1);
  });
