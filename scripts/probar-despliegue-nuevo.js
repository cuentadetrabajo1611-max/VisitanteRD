/**
 * VisitaFlow - El recorrido completo de un despliegue nuevo.
 *
 *   node scripts/probar-despliegue-nuevo.js
 *
 * QUE PRUEBA
 * ----------
 * Exactamente lo que pasara la primera vez en el VPS, en este orden:
 *
 *   1. La base no existe          -> se crea con sql/01-crear.js
 *   2. Arranca el sistema         -> dice que hay que activar una licencia
 *   3. Se activa con el ID        -> el servidor de licencias la firma
 *   4. Arranca otra vez           -> crea la institucion, los catalogos y el
 *                                    administrador, y deja la clave en un archivo
 *   5. Se entra con esas credenciales
 *   6. Se comprueba que el sistema funciona de verdad (panel, cedulas)
 *
 * POR QUE NO BASTABA LO QUE YA HABIA
 * ----------------------------------
 * `test:esquema` crea la base pero no arranca el sistema. `test:primer-arranque`
 * arranca el sistema pero sobre una base que YA EXISTIA. Ninguno de los dos
 * recorria la cadena entera, y la cadena es donde aparecen los problemas: una
 * base recien creada no tiene ninguna institucion, y el sistema tiene que
 * arreglarselas para crearla el solo a partir de la licencia.
 *
 * Usa una base y una carpeta de datos PROPIAS. No toca ni la base del sistema ni
 * la del padron, ni la licencia de esta maquina.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const BASE = 'VisitaFlow_PruebaDespliegue';
const PUERTO = 3270;
const TEMPORAL = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-despliegue-'));
const DATOS = path.join(TEMPORAL, 'datos');
const RAIZ_URL = 'http://127.0.0.1:' + PUERTO;
const LICENCIAS = 'http://localhost:' + (process.env.PUERTO_LICENCIAS || 4100);

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

let servidor = null;

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

async function borrarBase() {
  const maestro = await conectar('master');
  await maestro.request().batch(
    "IF DB_ID('" + BASE + "') IS NOT NULL BEGIN " +
    'ALTER DATABASE [' + BASE + '] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ' +
    'DROP DATABASE [' + BASE + ']; END'
  );
  await maestro.close();
}

/** El entorno con el que arranca el sistema, apuntando a la base de prueba. */
function entorno() {
  return Object.assign({}, process.env, {
    NODE_ENV: 'production',
    PORT: String(PUERTO),
    HOST: '127.0.0.1',
    DB_DATABASE: BASE,
    DATOS_CARPETA: DATOS,
    LICENCIA_ARCHIVO: path.join(DATOS, 'licencia.vflow'),
    ARCHIVOS_CARPETA: path.join(DATOS, 'archivos'),
    LICENCIA_SERVIDOR: LICENCIAS,
    URL_PUBLICA: RAIZ_URL,

    /* Un secreto propio de esta prueba.
     *
     * Hace falta porque el sistema ahora NO ARRANCA en producción con un secreto
     * que esté publicado en el repositorio, y el del .env de desarrollo lo está.
     * Es lo mismo que tendrá que hacer un cliente al desplegar, así que la prueba
     * lo hace igual. */
    JWT_SECRET: 'prueba-de-despliegue-secreto-propio-' + BASE + '-no-publicado',
    ADMIN_TOKEN: 'prueba-de-despliegue-token-de-administracion-' + BASE,
  });
}

/** Arranca el sistema y espera a que responda. */
async function arrancar(segundos) {
  /* La salida del servidor de prueba se guarda en un archivo. Si algo falla, es lo
     unico que dice por que: con la salida "heredada" no se ve nada cuando la prueba
     se ejecuta desde otro script. */
  const registro = path.join(TEMPORAL, 'servidor.log');
  const flujo = fs.openSync(registro, 'a');

  servidor = spawn(process.execPath, ['server.js'], {
    cwd: RAIZ,
    env: entorno(),
    stdio: ['ignore', flujo, flujo],
  });
  servidor.registro = registro;

  const limite = Date.now() + (segundos || 40) * 1000;
  while (Date.now() < limite) {
    // Si el proceso se murio, no tiene sentido seguir esperando.
    if (servidor && servidor.exitCode !== null) {
      const texto = fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8') : '';
      const ultimas = texto.split('\n').filter(Boolean).slice(-8).join('\n           ');
      throw new Error('el servidor de prueba se cerró (código ' + servidor.exitCode + '):\n           ' + ultimas);
    }
    try {
      const r = await fetch(RAIZ_URL + '/api/salud', { signal: AbortSignal.timeout(3000) });
      if (r.ok) return await r.json();
    } catch (e) {
      /* todavia no responde */
    }
    await new Promise((listo) => setTimeout(listo, 700));
  }

  const texto = fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8') : '';
  const ultimas = texto.split('\n').filter(Boolean).slice(-8).join('\n           ');
  throw new Error('el sistema no respondió en ' + (segundos || 40) + ' segundos. Últimas líneas:\n           ' + ultimas);
}

/** Para el sistema y espera a que suelte el puerto. */
async function parar() {
  if (!servidor) return;
  const p = servidor;
  servidor = null;
  p.kill('SIGTERM');

  const limite = Date.now() + 15000;
  while (Date.now() < limite) {
    try {
      await fetch(RAIZ_URL + '/api/salud', { signal: AbortSignal.timeout(1500) });
    } catch (e) {
      return; // ya no responde
    }
    await new Promise((listo) => setTimeout(listo, 500));
  }
  try { p.kill('SIGKILL'); } catch (e) { /* da igual */ }
}

async function entrar(correo, clave) {
  const r = await fetch(RAIZ_URL + '/api/acceso/entrar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correo: correo, clave: clave }),
  });
  const j = await r.json().catch(() => ({}));
  return { estado: r.status, datos: j };
}

/* ================================================================== */

async function principal() {
  console.log('');
  console.log('  VisitaFlow - despliegue nuevo, de principio a fin');
  console.log('  ' + '='.repeat(64));
  console.log('  Base de prueba : ' + BASE);
  console.log('  Datos          : ' + DATOS);
  console.log('  Puerto         : ' + PUERTO);

  /* ------------------------------------------------------------------ */
  paso('0. El servidor de licencias tiene que estar en marcha');
  try {
    const r = await fetch(LICENCIAS + '/api/salud', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('respondió ' + r.status);
    bien('el servidor de licencias responde');
  } catch (e) {
    mal('el servidor de licencias no responde en ' + LICENCIAS);
    info('arránquelo con:  npm run licencias');
    throw new Error('sin servidor de licencias no se puede probar la activación');
  }

  /* Se necesita un ID real. Se coge el de un cliente que ya existe.
     El servidor de licencias protege su administración con
     `Authorization: Bearer`, no con x-api-key (esa es la de Dokploy). */
  const tokenAdmin = (process.env.ADMIN_TOKEN || config.adminToken || '').trim();
  const lista = await (await fetch(LICENCIAS + '/api/admin/clientes', {
    headers: { Authorization: 'Bearer ' + tokenAdmin },
  })).json();

  if (!Array.isArray(lista.clientes)) {
    throw new Error('no se pudo leer la lista de clientes: ' +
      (lista.mensaje || lista.motivo || JSON.stringify(lista).slice(0, 120)));
  }

  const cliente = lista.clientes.find((c) => c.activa === true && c.vencida === false);
  if (!cliente) throw new Error('no hay ningún cliente activo en el servidor de licencias');
  info('se usará el ID ' + cliente.licencia_id + ' (' + cliente.cliente + ')');

  await borrarBase();

  /* ------------------------------------------------------------------ */
  paso('1. Crear la base, como en el VPS');
  const r1 = spawn(process.execPath, [path.join(RAIZ, 'sql', '01-crear.js')], {
    cwd: RAIZ,
    env: entorno(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await new Promise((listo) => r1.on('close', listo));
  if (r1.exitCode === 0) bien('la base se creó desde cero');
  else { mal('no se pudo crear la base (código ' + r1.exitCode + ')'); throw new Error('sin base no se puede seguir'); }

  /* ------------------------------------------------------------------ */
  paso('2. Arrancar el sistema por primera vez');
  let salud = await arrancar();
  bien('el sistema arranca y responde');

  if (salud.base_datos.disponible) bien('se conectó a la base recién creada');
  else mal('no se conectó a la base');

  if (salud.cedulas.disponible) bien('se conectó a la base de cédulas');
  else info('la base de cédulas no está disponible (no impide esta prueba)');

  /* Sin licencia, el sistema tiene que PEDIRLA, no arrancar a medias. */
  const estado = await (await fetch(RAIZ_URL + '/api/acceso/instituciones')).json();
  if (estado.necesita_licencia) bien('el sistema pide la licencia (no hay institución todavía)');
  else mal('el sistema debería pedir la licencia en una instalación vacía');

  if (!estado.diagnostico || estado.diagnostico.instituciones_activas.length === 0) {
    bien('no hay ninguna institución en la base, como debe ser');
  } else {
    mal('ya hay instituciones en una base recién creada');
  }

  /* Tampoco debe dejar entrar. */
  const intento = await entrar('admin@' + cliente.tenant + '.local', 'loquesea');
  if (intento.estado === 409) bien('no deja entrar sin licencia (dice que hay que activarla)');
  else if (intento.estado === 401) bien('no deja entrar sin licencia');
  else mal('dejó intentar entrar sin licencia (estado ' + intento.estado + ')');

  /* ------------------------------------------------------------------ */
  paso('3. Activar con el ID de la licencia');

  /* Esta es la ruta pública del primer arranque: no hay sesión porque todavía no
     existe ningún usuario. */
  const act = await fetch(RAIZ_URL + '/api/licencia/activar-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ licencia_id: cliente.licencia_id }),
  });
  const actDatos = await act.json().catch(() => ({}));

  if (act.status === 200) bien('la activación por ID funcionó');
  else { mal('la activación falló (estado ' + act.status + '): ' + (actDatos.mensaje || actDatos.motivo || '')); throw new Error('sin activar no se puede seguir'); }

  if (actDatos.cliente) bien('el sistema sabe de qué cliente es: ' + actDatos.cliente);
  if (actDatos.primer_arranque) bien('el sistema reconoció que es un primer arranque');

  /* La licencia tiene que haber quedado guardada en la carpeta de datos. */
  const archivoLic = path.join(DATOS, 'licencia.vflow');
  if (fs.existsSync(archivoLic)) bien('la licencia quedó guardada en el volumen de datos');
  else mal('la licencia NO se guardó: se perdería en el próximo arranque');

  /* Y la institución tiene que existir YA en la base (la crea el guardado). */
  const pool1 = await conectar(BASE);
  const t1 = (await pool1.request().query("SELECT id, codigo FROM vf_tenants WHERE codigo = '" + cliente.tenant + "'")).recordset[0];
  if (t1) bien('la institución "' + cliente.tenant + '" quedó creada en la base');
  else mal('la institución no se creó al activar');
  await pool1.close();

  /* ------------------------------------------------------------------ */
  /* LO IMPORTANTE: activar tiene que dejar el sistema USABLE EN EL MOMENTO.
   *
   * Antes no lo hacía: la activación solo guardaba la licencia, y los catálogos y
   * el administrador se creaban al ARRANCAR. O sea que había que reiniciar el
   * contenedor después de activar, aunque la pantalla dijera que ya estaba listo,
   * y quien activaba se quedaba sin ningún usuario con el que entrar.
   *
   * Aquí se comprueba SIN REINICIAR NADA. Si esto pasa, el paso deja de existir. */
  console.log('');
  console.log('  Y sin reiniciar nada, el sistema tiene que quedar usable:');

  const pool3 = await conectar(BASE);
  const t3 = (await pool3.request().query("SELECT id FROM vf_tenants WHERE codigo = '" + cliente.tenant + "'")).recordset[0];

  const contar = async (tabla, cond) => {
    const r = await pool3.request().query('SELECT COUNT(*) AS n FROM ' + tabla + ' WHERE tenant_id = ' + t3.id + (cond || ''));
    return r.recordset[0].n;
  };

  const permisosYa = await contar('vf_rol_permisos');
  if (permisosYa >= 30) bien(permisosYa + ' permisos sembrados SIN reiniciar');
  else mal('solo ' + permisosYa + ' permisos tras activar: haría falta reiniciar el contenedor');

  const adminsYa = await contar('vf_usuarios', " AND rol = 'admin' AND activo = 1");
  if (adminsYa === 1) bien('el administrador se creó SIN reiniciar');
  else mal('hay ' + adminsYa + ' administradores tras activar: haría falta reiniciar');

  const motivosYa = await contar('vf_motivos');
  if (motivosYa > 0) bien(motivosYa + ' motivos de visita sembrados SIN reiniciar');
  else mal('no se sembraron los motivos tras activar');
  await pool3.close();

  /* Y que la respuesta de la activación traiga el usuario, para poder entrar. */
  if (actDatos.administrador && actDatos.administrador.correo) {
    bien('la activación devolvió el usuario del administrador: ' + actDatos.administrador.correo);
  } else {
    mal('la activación no devolvió el usuario del administrador');
  }

  /* El archivo de credenciales también tiene que estar ya. */
  const archivoClaveYa = path.join(DATOS, 'CLAVE-ADMINISTRADOR.txt');
  if (fs.existsSync(archivoClaveYa)) bien('el archivo con la contraseña quedó escrito SIN reiniciar');
  else mal('no se escribió el archivo con la contraseña al activar');

  /* ------------------------------------------------------------------ */
  paso('4. Reiniciar: tiene que seguir bien, no romperse');

  /* El reinicio ya no es necesario, pero tiene que seguir funcionando: es lo que
     pasa en cada actualización del contenedor. */
  await parar();
  salud = await arrancar();

  if (salud.licencia.valida) bien('tras reiniciar, la licencia sigue activa');
  else mal('el sistema perdió la licencia al reiniciar');

  /* Y no debe haber duplicado nada al pasar otra vez por la preparación. */
  const pool2 = await conectar(BASE);
  const t2 = (await pool2.request().query("SELECT id FROM vf_tenants WHERE codigo = '" + cliente.tenant + "'")).recordset[0];

  const cuenta = async (tabla, condicion) => {
    const r = await pool2.request().query('SELECT COUNT(*) AS n FROM ' + tabla + ' WHERE tenant_id = ' + t2.id + (condicion || ''));
    return r.recordset[0].n;
  };

  const permisos = await cuenta('vf_rol_permisos');
  if (permisos === permisosYa) bien('los permisos siguen siendo ' + permisos + ' (no se duplicaron al reiniciar)');
  else mal('los permisos pasaron de ' + permisosYa + ' a ' + permisos + ': la preparación duplica datos');

  const admins = await cuenta('vf_usuarios', " AND rol = 'admin' AND activo = 1");
  if (admins === 1) bien('sigue habiendo un solo administrador');
  else mal('ahora hay ' + admins + ' administradores');

  /* La clave tiene que estar en un archivo, DENTRO del volumen de datos. */
  const archivoClave = path.join(DATOS, 'CLAVE-ADMINISTRADOR.txt');
  if (!fs.existsSync(archivoClave)) {
    mal('no se dejó el archivo con la contraseña del administrador');
  } else {
    bien('el archivo con la contraseña quedó dentro del volumen de datos');
    const texto = fs.readFileSync(archivoClave, 'utf8');
    const mCorreo = /Usuario\s*:\s*(\S+)/.exec(texto);
    const mClave = /Contraseña\s*:\s*(\S+)/.exec(texto);

    if (!mCorreo || !mClave) {
      mal('el archivo no tiene el usuario y la contraseña en el formato esperado');
    } else {
      info('usuario: ' + mCorreo[1]);

      /* ------------------------------------------------------------------ */
      paso('5. Entrar con las credenciales que dejó el sistema');

      const sesion = await entrar(mCorreo[1], mClave[1]);
      if (sesion.estado === 200 && sesion.datos.token) {
        bien('se entra con el usuario y la contraseña del archivo');

        if (sesion.datos.usuario.tenant === cliente.tenant) {
          bien('la sesión quedó en la institución correcta (' + cliente.tenant + ')');
        } else {
          mal('la sesión quedó en ' + sesion.datos.usuario.tenant);
        }

        if ((sesion.datos.permisos || []).length >= 20) {
          bien((sesion.datos.permisos || []).length + ' permisos en la sesión');
        } else {
          mal('solo ' + (sesion.datos.permisos || []).length + ' permisos en la sesión');
        }

        /* ------------------------------------------------------------------ */
        paso('6. Que el sistema funcione de verdad, no solo que arranque');

        const cab = { Authorization: 'Bearer ' + sesion.datos.token };

        const panel = await (await fetch(RAIZ_URL + '/api/panel', { headers: cab })).json();
        if (panel.panel) bien('el panel carga (' + panel.panel.metricas.dentro + ' visitantes dentro)');
        else mal('el panel no cargó: ' + JSON.stringify(panel).slice(0, 120));

        const marca = await (await fetch(RAIZ_URL + '/api/marca', { headers: cab })).json();
        if (marca.marca && marca.marca.nombre) bien('la marca de la institución carga: ' + marca.marca.nombre);
        else mal('la marca no cargó');

        /* Buscar en el padrón: lo que hace el recepcionista todo el día.
           Se busca por una cédula real, leída de la propia base de cédulas: es
           la prueba de que la conexión funciona de verdad, no solo que responde.
           La cédula se guarda para usarla luego al registrar la visita. */
        let cedulaEncontrada = '';
        try {
          const pool3 = await conectar('PadronLigero');
          const c = (await pool3.request().query(
            "SELECT TOP 1 Cedula FROM dbo.PADRON WHERE Cedula IS NOT NULL AND LEN(Cedula) >= 6 ORDER BY Cedula"
          )).recordset[0];
          await pool3.close();

          if (c && c.Cedula) {
            const cedula = String(c.Cedula).trim();
            const busc = await (await fetch(
              RAIZ_URL + '/api/registro/buscar?q=' + encodeURIComponent(cedula),
              { headers: cab }
            )).json();

            if ((busc.resultados || []).length > 0) {
              bien('se encuentra una persona real del padrón por su cédula (' + cedula + ')');
              const p = busc.resultados[0];
              info('nombre: ' + (p.nombre_completo || p.nombres || '—'));
              cedulaEncontrada = cedula;
            } else {
              mal('no se encontró la cédula ' + cedula + ' en el padrón: ' + (busc.motivo || 'sin motivo'));
            }
          } else {
            info('no se pudo leer una cédula de ejemplo del padrón');
          }
        } catch (e) {
          info('no se pudo probar la búsqueda en el padrón: ' + e.message);
        }

        /* Y registrar una visita: el corazón del sistema.
           El endpoint es POST /api/registro, no /api/visitas (ese es para
           consultar). Se registra con la cédula real que se encontró arriba y
           con uno de los motivos que el sistema sembró: el motivo es
           obligatorio, y hay que comprobar que los sembrados SIRVEN. */

        let motivoId = null;
        try {
          const cfg = await (await fetch(RAIZ_URL + '/api/config', { headers: cab })).json();
          const motivos = (cfg.config && cfg.config.motivos) || cfg.motivos || [];
          if (motivos.length) {
            motivoId = motivos[0].id;
            info('motivo de la visita: ' + (motivos[0].nombre || motivos[0].motivo || motivoId));
          } else {
            mal('el sistema no sembró ningún motivo de visita: no se podría registrar a nadie');
          }
        } catch (e) {
          info('no se pudo leer los motivos: ' + e.message);
        }

        const reg = await fetch(RAIZ_URL + '/api/registro', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, cab),
          body: JSON.stringify({
            cedula: cedulaEncontrada,
            visitado: 'Administrador',
            motivo_id: motivoId,
          }),
        });
        const regDatos = await reg.json().catch(() => ({}));

        if (reg.status === 200 || reg.status === 201) {
          bien('se puede registrar una visita (el sistema sirve para lo que es)');

          const idVisita = regDatos.visita ? regDatos.visita.id : null;
          const codigoVisita = regDatos.visita ? regDatos.visita.codigo : null;

          /* La lista de visitas viene paginada: es un objeto con `filas`, no un
             arreglo. Confundirlo da un error confuso ("some is not a function"). */
          const listarDentro = async () => {
            const r = await (await fetch(RAIZ_URL + '/api/visitas?estado=dentro', { headers: cab })).json();
            return (r.listado && r.listado.filas) || [];
          };

          const filas = await listarDentro();
          const encontrada = filas.some((v) => v.id === idVisita || v.codigo === codigoVisita);

          if (encontrada) bien('la visita aparece en la lista de visitantes dentro');
          else mal('la visita no aparece en la lista de dentro (' + filas.length + ' fila(s))');

          /* Y que se le pueda dar salida: el ciclo completo. */
          const paraSalida = filas.find((v) => v.id === idVisita || v.codigo === codigoVisita);

          if (paraSalida) {
            const sal = await fetch(RAIZ_URL + '/api/visitas/' + paraSalida.id + '/salida', {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, cab),
              body: JSON.stringify({}),
            });
            const salDatos = await sal.json().catch(() => ({}));

            if (sal.status === 200) {
              bien('se le puede dar salida (el ciclo completo funciona)');

              const despues = await listarDentro();
              const sigue = despues.some((v) => v.id === paraSalida.id);
              if (!sigue) bien('después de la salida ya no figura como visitante dentro');
              else mal('la visita sigue apareciendo dentro después de darle salida');
            } else {
              mal('no se pudo dar salida (estado ' + sal.status + '): ' + (salDatos.mensaje || salDatos.motivo || ''));
            }
          }
        } else {
          mal('no se pudo registrar una visita (estado ' + reg.status + '): ' +
            (regDatos.mensaje || regDatos.motivo || JSON.stringify(regDatos).slice(0, 120)));
        }
      } else {
        mal('no se pudo entrar con las credenciales del archivo (estado ' + sesion.estado + ')');
        if (sesion.datos.mensaje || sesion.datos.motivo) info(sesion.datos.mensaje || sesion.datos.motivo);
      }
    }
  }
}

let error = null;

async function correr() {
  try {
    await principal();
  } catch (e) {
    error = e;
  }

  /* Se limpia SIEMPRE: se para el sistema y se borra la base de prueba. */
  console.log('');
  console.log('  Limpiando…');
  try { await parar(); console.log('  [ok]    el sistema de prueba se detuvo'); }
  catch (e) { console.log('  [FALLO] no se pudo detener: ' + e.message); }

  try {
    await borrarBase();
    console.log('  [ok]    la base de prueba se borró');
  } catch (e) {
    fallos++;
    console.log('  [FALLO] no se pudo borrar la base de prueba: ' + e.message);
  }

  try { fs.rmSync(TEMPORAL, { recursive: true, force: true }); }
  catch (e) { /* da igual */ }

  if (error) {
    console.log('');
    console.log('  La prueba se detuvo: ' + error.message);
  }

  console.log('');
  console.log('  ' + '='.repeat(64));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(64));
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  return (fallos || error) ? 1 : 0;
}

/* Se usa `process.exitCode` en vez de `process.exit()`: salir a la fuerza con
   una conexión a la base todavía cerrándose hace que Node aborte en Windows con
   "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)". Dejando que el
   proceso termine solo, se cierra todo en orden. */
correr().then((codigo) => { process.exitCode = codigo; });
