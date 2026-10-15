/**
 * VisitaFlow - La base se crea bien DESDE CERO.
 *
 *   node scripts/probar-esquema-nuevo.js
 *
 * POR QUE EXISTE ESTA PRUEBA
 * --------------------------
 * Todo lo demas se ha probado sobre la base que ya existe en esta maquina, con
 * sus 22 tablas y sus datos. Pero en el VPS la base NO EXISTE: se crea con
 * `node sql/01-crear.js`. Ese camino no se habia recorrido nunca de principio a
 * fin, y es justo el primero que se usa al desplegar.
 *
 * Esta prueba crea una base de verdad con otro nombre, aplica el esquema, y
 * comprueba que quedo todo: las tablas, las columnas que se anadieron despues
 * (persona_id, los avisos), las claves ajenas, los indices y los permisos.
 * Despues la borra.
 *
 * NO toca la base del sistema ni la del padron.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));
const { spawnSync } = require('child_process');

const BASE = 'VisitaFlow_PruebaEsquema';

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }

/** Una conexion a la base de prueba. */
function conectar(base) {
  return new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: base,
    options: {
      encrypt: config.bd.sistema.encrypt,
      trustServerCertificate: config.bd.sistema.trustServerCertificate,
      enableArithAbort: true,
    },
    connectionTimeout: 20000,
  }).connect();
}

/** Borra la base de prueba si quedo de una corrida anterior. */
async function borrarBase() {
  const maestro = await conectar('master');
  await maestro.request().batch(
    'IF DB_ID(\'' + BASE + '\') IS NOT NULL BEGIN ' +
    'ALTER DATABASE [' + BASE + '] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ' +
    'DROP DATABASE [' + BASE + ']; END'
  );
  await maestro.close();
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - la base desde cero, como en el VPS');
  console.log('  ' + '='.repeat(62));
  console.log('  Base de prueba: ' + BASE);
  console.log('  (la base del sistema NO se toca)');

  /* Si ya existe de antes, se borra: la prueba tiene que partir de nada. */
  await borrarBase();

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('1. Crear el esquema con el mismo comando que se usa en el VPS');

  /* Se ejecuta sql/01-crear.js como un proceso aparte, apuntando a la base de
     prueba. Es importante que sea el proceso real: asi se prueba el comando tal
     como se va a escribir en el servidor, no una copia de su logica. */
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'sql', '01-crear.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { DB_DATABASE: BASE }),
    encoding: 'utf8',
  });

  if (r.status === 0) {
    bien('el comando terminó sin errores');
  } else {
    mal('el comando falló (código ' + r.status + ')');
    const salida = (r.stdout || '') + (r.stderr || '');
    salida.split('\n').filter(Boolean).slice(-12).forEach((l) => info(l.trim()));
    throw new Error('no se pudo crear el esquema');
  }

  const salida = r.stdout || '';
  const mTablas = /Tablas creadas \((\d+)\)/.exec(salida);
  if (mTablas) info('el comando informó de ' + mTablas[1] + ' tablas');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('2. Que estén TODAS las tablas que el sistema usa');

  const pool = await conectar(BASE);

  const tablas = (await pool.request().query(
    "SELECT name FROM sys.tables WHERE name LIKE 'vf[_]%' ORDER BY name"
  )).recordset.map((t) => t.name);

  /* Las que el codigo necesita de verdad, no una lista inventada. */
  const esperadas = [
    'vf_ajustes', 'vf_auditoria', 'vf_avisos', 'vf_categorias', 'vf_departamentos',
    'vf_gafetes', 'vf_instalaciones', 'vf_licencias', 'vf_licencias_revisiones',
    'vf_motivos', 'vf_permisos', 'vf_personas', 'vf_plantillas_gafete',
    'vf_preregistros', 'vf_rol_permisos', 'vf_sedes', 'vf_tenants', 'vf_usuarios',
    'vf_vigilancia', 'vf_vigilancia_avisos', 'vf_visitantes', 'vf_visitas',
  ];

  const faltan = esperadas.filter((t) => tablas.indexOf(t) === -1);
  if (faltan.length) {
    mal('faltan tablas: ' + faltan.join(', '));
  } else {
    bien('están las ' + esperadas.length + ' tablas que el sistema necesita');
  }

  const sobran = tablas.filter((t) => esperadas.indexOf(t) === -1);
  if (sobran.length) info('además hay: ' + sobran.join(', '));

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('3. Las columnas que se añadieron después de la primera versión');

  /* Estas se agregaron con ALTER TABLE en el bloque 14 del esquema. Si ese
     bloque fallara en silencio, la base se crearía pero el aviso al anfitrión
     no funcionaría: el visita no sabría que alguien lo busca. */
  const columnas = [
    { tabla: 'vf_visitas', columna: 'persona_id', paraQue: 'a quién se avisa' },
    { tabla: 'vf_avisos', columna: 'visita_id', paraQue: 'de qué visita es el aviso' },
    { tabla: 'vf_avisos', columna: 'leido', paraQue: 'si el recepcionista ya lo vio' },
  ];

  for (const c of columnas) {
    const r2 = await pool.request().query(
      "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo." + c.tabla + "') AND name = '" + c.columna + "'"
    );
    if (r2.recordset[0].n) bien(c.tabla + '.' + c.columna + ' (' + c.paraQue + ')');
    else mal('falta ' + c.tabla + '.' + c.columna + ': ' + c.paraQue + ' no funcionaría');
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('4. Los tipos de fecha con desfase horario');

  /* Se migraron 37 columnas a DATETIMEOFFSET porque con DATETIME2 las horas
     salían 4 horas antes. En una base nueva tienen que nacer ya correctas. */
  const fechas = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM sys.columns c " +
    "JOIN sys.types t ON c.user_type_id = t.user_type_id " +
    "WHERE t.name = 'datetimeoffset'"
  )).recordset[0].n;

  if (fechas >= 30) bien(fechas + ' columnas de fecha con desfase horario (nacen correctas)');
  else mal('solo ' + fechas + ' columnas con desfase: las horas saldrían mal');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('5. Las claves ajenas y los indices');

  const fks = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM sys.foreign_keys WHERE name LIKE 'FK_vf%'"
  )).recordset[0].n;
  if (fks >= 20) bien(fks + ' claves ajenas');
  else mal('solo ' + fks + ' claves ajenas: podrían quedar datos huérfanos');

  const indices = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM sys.indexes WHERE name LIKE 'IX_vf%' AND name IS NOT NULL"
  )).recordset[0].n;
  if (indices >= 20) bien(indices + ' índices para las consultas frecuentes');
  else mal('solo ' + indices + ' índices: las consultas irían lentas');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('6. La tabla de permisos');

  /* OJO: el esquema CREA la tabla de permisos, pero no la llena. Los permisos se
     siembran POR INSTITUCIÓN cuando se crea (mantenimiento.prepararTenant), que
     es lo correcto: cada institución tiene los suyos. Aquí solo se comprueba que
     la tabla existe con la forma que el sistema espera. */
  const formaPermisos = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.vf_permisos')"
  )).recordset[0].n;

  if (formaPermisos >= 4) bien('vf_permisos tiene ' + formaPermisos + ' columnas');
  else mal('vf_permisos está incompleta: ' + formaPermisos + ' columnas');

  const rolPermisos = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.vf_rol_permisos')"
  )).recordset[0].n;

  /* Son tres: institucion, rol y permiso. */
  if (rolPermisos === 3) bien('vf_rol_permisos tiene sus 3 columnas (institución, rol, permiso)');
  else mal('vf_rol_permisos tiene ' + rolPermisos + ' columnas y deberían ser 3');

  /* El aviso: las columnas por las que se consulta tienen que existir. */
  const colAviso = ['destinatario', 'asunto', 'cuerpo', 'estado', 'leido', 'visita_id', 'persona_id'];
  const faltanAviso = [];
  for (const c of colAviso) {
    const r = await pool.request().query(
      "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.vf_avisos') AND name = '" + c + "'"
    );
    if (!r.recordset[0].n) faltanAviso.push(c);
  }
  if (faltanAviso.length) mal('a vf_avisos le faltan: ' + faltanAviso.join(', '));
  else bien('vf_avisos tiene las ' + colAviso.length + ' columnas que usa el sistema');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('7. Que se pueda ejecutar DOS veces (el esquema es repetible)');

  const r3 = spawnSync(process.execPath, [path.join(RAIZ, 'sql', '01-crear.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { DB_DATABASE: BASE }),
    encoding: 'utf8',
  });

  if (r3.status === 0) {
    bien('se puede volver a ejecutar sin romper nada (importante al actualizar)');
  } else {
    mal('la segunda ejecución falló: una actualización rompería la base');
    ((r3.stdout || '') + (r3.stderr || '')).split('\n').filter(Boolean).slice(-8).forEach((l) => info(l.trim()));
  }

  /* Y que no haya duplicado nada al repetir. */
  const permisos2 = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.vf_permisos')"
  )).recordset[0].n;
  if (permisos2 === formaPermisos) bien('la tabla de permisos no se duplicó');
  else mal('la tabla de permisos pasó de ' + formaPermisos + ' a ' + permisos2 + ' columnas');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('8. Que el sistema pueda trabajar contra esta base');

  /* Lo importante: que sirva, no solo que exista. Se comprueba que se puede
     escribir y leer como lo hace la aplicación. */
  try {
    await pool.request().batch(
      "INSERT INTO vf_tenants (codigo, nombre, estado) VALUES ('prueba-esquema', 'Prueba', 'activo');"
    );
    const t = (await pool.request().query("SELECT id FROM vf_tenants WHERE codigo = 'prueba-esquema'")).recordset[0];
    if (t) bien('se puede crear una institución');
    else mal('no se pudo leer la institución recién creada');

    /* Una visita con fecha del servidor: es como lo hace el sistema.
       Las columnas son las reales: en vf_visitas la fecha de alta se llama
       "creado", no "fecha_registro". */
    if (t) {
      await pool.request().batch(
        "INSERT INTO vf_visitas (tenant_id, codigo, nombre_completo, estado) " +
        "VALUES (" + t.id + ", 'V-0001', 'Prueba Esquema', 'dentro');"
      );
      const v = (await pool.request().query('SELECT id FROM vf_visitas WHERE tenant_id = ' + t.id)).recordset[0];
      if (v) bien('se puede registrar una visita');
      else mal('no se pudo registrar la visita');

      /* Y un aviso ligado a esa visita: es la relacion que mas problemas dio. */
      if (v) {
        await pool.request().batch(
          'INSERT INTO vf_avisos (tenant_id, visita_id, destinatario, asunto, cuerpo) ' +
          "VALUES (" + t.id + ', ' + v.id + ", 'Prueba', 'Llegó una visita', 'Mensaje de prueba');"
        );
        const a = (await pool.request().query('SELECT id, leido FROM vf_avisos WHERE visita_id = ' + v.id)).recordset[0];
        if (a) bien('se puede crear un aviso ligado a la visita');
        else mal('no se pudo crear el aviso');

        if (a && a.leido === null) bien('el aviso nace sin leer');
        else if (a) mal('el aviso deberia nacer sin leer');

        /* El indice del panel de avisos. Dio problemas de intercalacion al
           crearlo a mano, asi que conviene saber si una base nueva lo tiene. */
        const idx = (await pool.request().query(
          "SELECT COUNT(*) AS n FROM sys.indexes WHERE name = 'IX_vf_avisos_tenant'"
        )).recordset[0].n;
        if (idx) bien('el indice del panel de avisos se creo sin conflicto de intercalacion');
        else mal('falta IX_vf_avisos_tenant: el panel de avisos iria lento');

        /* Y que la fecha de entrada venga del servidor con su desfase: si la
           columna fuera DATETIME2, esto guardaria una hora equivocada. */
        const f = (await pool.request().query(
          'SELECT DATEDIFF(MINUTE, entrada, SYSDATETIMEOFFSET()) AS m FROM vf_visitas WHERE id = ' + v.id
        )).recordset[0];
        if (Math.abs(f.m) <= 2) bien('la hora de entrada es la correcta (diferencia de ' + f.m + ' minuto(s))');
        else mal('la hora de entrada está ' + f.m + ' minutos desviada');
      }
    }
  } catch (e) {
    mal('no se pudo trabajar contra la base nueva: ' + e.message);
  }

  await pool.close();
}

/** El cuerpo completo, para poder usar await: el proyecto es CommonJS. */
async function correr() {
  let error = null;
  try {
    await principal();
  } catch (e) {
    error = e;
  }

  /* Se borra SIEMPRE, incluso si algo falló: dejar bases de prueba tiradas es
     como se acaba con quince bases en un servidor. */
  console.log('');
  console.log('  Borrando la base de prueba…');
  try {
    await borrarBase();
    const maestro = await conectar('master');
    const queda = (await maestro.request().query("SELECT COUNT(*) AS n FROM sys.databases WHERE name = '" + BASE + "'")).recordset[0].n;
    await maestro.close();
    if (queda) { fallos++; console.log('  [FALLO] la base de prueba no se pudo borrar'); }
    else console.log('  [ok]    base de prueba borrada');
  } catch (e) {
    fallos++;
    console.log('  [FALLO] no se pudo borrar la base de prueba: ' + e.message);
  }

  if (error) {
    console.log('');
    console.log('  La prueba se detuvo: ' + error.message);
  }

  console.log('');
  console.log('  ' + '='.repeat(62));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(62));
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  process.exit(fallos || error ? 1 : 0);
}

correr();
