/**
 * VisitaFlow - Prueba en modo produccion.
 *
 *   node scripts/probar-produccion.js
 *
 * Las demas pruebas corren con NODE_ENV=development. Hay cosas que SOLO se
 * comportan distinto en produccion, y conviene descubrirlas aqui y no en el VPS:
 *
 *   - El acceso por la utilidad de desarrollo queda desactivado.
 *   - El cache de archivos estaticos se activa.
 *   - La cookie de sesion se marca como Secure (exige HTTPS).
 *   - Los avisos de configuracion peligrosa se activan.
 *
 * Levanta una instancia aparte en un puerto propio, con NODE_ENV=production y su
 * propia licencia, y recorre el flujo real por la API. Al terminar la detiene.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));

const PUERTO = 3220;
const BASE = 'http://localhost:' + PUERTO;
const DATOS = path.join(RAIZ, 'tmp', 'produccion');

let ok = 0;
let fallos = 0;
const detalle = [];

async function prueba(nombre, fn) {
  try {
    await fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    detalle.push(nombre + ' -> ' + e.message);
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

async function pedir(metodo, ruta, cuerpo, token) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 200) }; }
  return { estado: r.status, datos, cabeceras: r.headers };
}

/** Espera a que la instancia responda. */
async function esperarArranque() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/api/salud');
      if (r.ok) return true;
    } catch (e) {
      /* todavia no */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - prueba en modo produccion');
  console.log('  ' + '='.repeat(58));
  console.log('');

  // 1. Preparar un directorio con su licencia, como tendria el contenedor.
  if (fs.existsSync(DATOS)) fs.rmSync(DATOS, { recursive: true, force: true });
  fs.mkdirSync(DATOS, { recursive: true });

  const tenant = 'zz-produccion';
  const texto = lic.firmar({
    tenant,
    cliente: 'Institución de Producción (prueba)',
    desde: new Date().toISOString(),
    hasta: new Date(Date.now() + 30 * 86400000).toISOString(),
    tipo: 'prueba',
    limite_usuarios: 5,
    limites: { usuarios: 5, instalaciones: 1, visitas_mes: 0 },
  });
  const rutaLicencia = path.join(DATOS, 'licencia.vflow');
  fs.writeFileSync(rutaLicencia, texto);

  const llaves = {
    publica: fs.readFileSync(path.join(RAIZ, 'licencias-keys', 'publica.pem')).toString('base64'),
    privada: fs.readFileSync(path.join(RAIZ, 'licencias-keys', 'privada.pem')).toString('base64'),
  };

  // 2. Levantar la instancia en modo produccion.
  const entorno = Object.assign({}, process.env, {
    NODE_ENV: 'production',
    PORT: String(PUERTO),
    HOST: '127.0.0.1',
    URL_PUBLICA: BASE,
    DB_SERVER: process.env.DB_SERVER || 'localhost',
    DB_USER: process.env.DB_USER || 'sa',
    DB_PASSWORD: process.env.DB_PASSWORD || '',
    DB_DATABASE: process.env.DB_DATABASE || 'VisitaFlow',
    PADRON_DB_SERVER: process.env.PADRON_DB_SERVER || 'localhost',
    PADRON_DB_PASSWORD: process.env.PADRON_DB_PASSWORD || process.env.DB_PASSWORD || '',
    PADRON_DATABASE: process.env.PADRON_DATABASE || 'PadronLigero',
    JWT_SECRET: 'produccion-de-prueba-' + Date.now(),
    ADMIN_TOKEN: 'produccion-de-prueba',
    LICENCIA_ARCHIVO: rutaLicencia,
    LICENCIA_LLAVE_PUBLICA_B64: llaves.publica,
    LICENCIA_LLAVE_PRIVADA_B64: llaves.privada,
    ARCHIVOS_CARPETA: path.join(DATOS, 'archivos'),
  });

  const proceso = spawn(process.execPath, ['server.js'], {
    cwd: RAIZ,
    env: entorno,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let salida = '';
  proceso.stdout.on('data', (d) => { salida += d.toString(); });
  proceso.stderr.on('data', (d) => { salida += d.toString(); });

  /* El servidor escribe CLAVE-ADMINISTRADOR.txt con la institución con la que
     arranca. Esta prueba arranca con una institución propia, así que pisaría el
     archivo de la instalación local. Se guarda y se devuelve como estaba. */
  const rutaCredenciales = path.join(RAIZ, 'datos', 'CLAVE-ADMINISTRADOR.txt');
  const credencialesPrevias = fs.existsSync(rutaCredenciales) ? fs.readFileSync(rutaCredenciales) : null;

  const terminar = () => { try { proceso.kill(); } catch (e) { /* ya murio */ } };

  try {
    if (!(await esperarArranque())) {
      console.log('  [X] La instancia de produccion no arranco. Salida:');
      console.log(salida.split('\n').slice(0, 20).map((l) => '      ' + l).join('\n'));
      process.exit(1);
    }
    console.log('  --- la instancia de producción arrancó ---');
    console.log('');

    /* -------------------------------------------------------------- */
    console.log('Configuración de producción');

    await prueba('el sistema se declara en producción', async () => {
      const r = await pedir('GET', '/api/salud');
      esperar(r.datos.entorno === 'production', 'el entorno es ' + r.datos.entorno);
    });

    await prueba('la institución de la licencia se creó sola al arrancar', async () => {
      const r = await pedir('GET', '/api/acceso/instituciones');
      const t = r.datos.instituciones.find((x) => x.codigo === tenant);
      esperar(t, 'no se creó la institución de la licencia');
    });

    await prueba('la utilidad de acceso de desarrollo está DESACTIVADA', async () => {
      const r = await pedir('GET', '/api/acceso/dev-entrar?tenant=' + tenant + '&correo=x&clave=y');
      esperar(r.estado === 404, 'debería responder 404 en producción y respondió ' + r.estado);
    });

    await prueba('la licencia viva es la de producción', async () => {
      const r = await pedir('GET', '/api/salud');
      esperar(r.datos.licencia.valida, 'la licencia no es válida: ' + r.datos.licencia.estado);
      esperar(r.datos.licencia.cliente.indexOf('Producción') !== -1, 'el cliente es ' + r.datos.licencia.cliente);
    });

    /* -------------------------------------------------------------- */
    console.log('');
    console.log('Flujo real: acceso, consulta de cédula y registro');

    let token = null;
    // El estado compartido entre pruebas se declara ANTES de la primera que lo
    // usa: si se declara despues, el "await" de la prueba llega antes que la
    // declaracion y salta "Cannot access 'ctx' before initialization".
    const ctx = { token: null, cedula: null, ciudadano: null, visita: null };

    await prueba('el administrador entra con su clave', async () => {
      /* El administrador lo crea el propio servidor en el primer arranque, y
         deja la clave en CLAVE-ADMINISTRADOR.txt. Esa es la que se usa aqui:
         es exactamente lo que hara una persona al desplegar. */
      /* El administrador de ESTA institución, leído de la base.
       *
       * No se lee el archivo de credenciales a propósito. El servidor solo lo
       * escribe cuando CREA el administrador; si esa institución ya tenía uno
       * (de una corrida anterior), el archivo se queda con el de la instalación
       * local y la prueba falla por un motivo que no tiene nada que ver con lo
       * que se está probando.
       *
       * Se lee el correo de la base y se le pone una clave conocida. Es
       * exactamente lo que hace scripts/restablecer-admin.js, que es la
       * herramienta que existe para esto. */
      const bd = require(path.join(RAIZ, 'src', 'db.js'));
      const auth = require(path.join(RAIZ, 'src', 'auth.js'));

      await bd.conectarSistema();
      const t = await bd.consultar('SELECT id FROM vf_tenants WHERE codigo = @c', { c: tenant });
      esperar(t.recordset.length, 'la institución de prueba no se creó');

      const CLAVE_PRUEBA = 'Produccion2026!x';
      const hash = await auth.cifrarClave(CLAVE_PRUEBA);

      const u = await bd.consultar(
        "SELECT TOP 1 id, correo FROM vf_usuarios WHERE tenant_id = @t AND rol = 'admin' ORDER BY id",
        { t: t.recordset[0].id }
      );

      let usuario;
      if (u.recordset.length) {
        usuario = u.recordset[0].correo;
        await bd.consultar(
          'UPDATE vf_usuarios SET clave_hash = @h, intentos = 0, bloqueado_hasta = NULL, activo = 1 WHERE id = @id',
          { id: u.recordset[0].id, h: hash }
        );
      } else {
        usuario = 'admin@' + tenant + '.local';
        await bd.consultar(
          "INSERT INTO vf_usuarios (tenant_id, correo, clave_hash, nombre, rol, activo) " +
          "VALUES (@t, @c, @h, 'Administrador', 'admin', 1)",
          { t: t.recordset[0].id, c: usuario, h: hash }
        );
      }

      const pass = CLAVE_PRUEBA;
      const inst = tenant;
      await bd.cerrar();

      const r = await pedir('POST', '/api/acceso/entrar', { tenant, correo: usuario, clave: pass });
      esperar(r.estado === 200, 'no pudo entrar con "' + usuario + '": ' + (r.datos.mensaje || r.estado));
      token = r.datos.token;
      ctx.token = token;
    });

    await prueba('la sesión funciona con el token recibido', async () => {
      const r = await pedir('GET', '/api/acceso/sesion', undefined, ctx.token);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.usuario.tenant === tenant, 'la institución no coincide: ' + r.datos.usuario.tenant);
    });

    await prueba('la consulta de cédulas sigue funcionando en producción', async () => {
      const r = await pedir('GET', '/api/registro/buscar?q=00100000017', undefined, ctx.token);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.resultados.length > 0, 'no se encontró la cédula de prueba');
      ctx.cedula = r.datos.resultados[0].cedula;
      ctx.ciudadano = r.datos.resultados[0];
    });

    await prueba('las fechas de nacimiento vienen bien formateadas', async () => {
      esperar(/^\d{4}-\d{2}-\d{2}$/.test(ctx.ciudadano.fecha_nacimiento), 'la fecha es ' + ctx.ciudadano.fecha_nacimiento);
    });

    let visitaId = null;
    await prueba('se registra una visita completa', async () => {
      const c = await pedir('GET', '/api/registro/consultar?cedula=' + ctx.cedula, undefined, ctx.token);
      const cat = c.datos.consulta.catalogos;

      const r = await pedir('POST', '/api/registro', {
        cedula: ctx.cedula,
        motivo_id: cat.motivos[0].id,
        departamento_id: cat.departamentos[0].id,
        visitado: 'Prueba de producción',
        observaciones: 'DEMO produccion',
        permitir_duplicado: true,
      }, ctx.token);

      esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
      visitaId = r.datos.visita.id;
      ctx.visita = r.datos.visita;
    });

    await prueba('la fecha de entrada NO queda en el futuro', async () => {
      const entrada = new Date(ctx.visita.entrada).getTime();
      const ahora = Date.now();
      const minutos = Math.round((entrada - ahora) / 60000);
      esperar(minutos <= 1, 'la entrada quedó ' + minutos + ' minutos en el futuro (debería ser ahora)');
      esperar(minutos >= -5, 'la entrada quedó ' + Math.abs(minutos) + ' minutos en el pasado');
    });

    await prueba('el gafete se emite con su código QR', async () => {
      const r = await pedir('GET', '/api/gafetes/visita/' + visitaId, undefined, ctx.token);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.gafete.codigos.qr_svg, 'no se generó el QR');
      esperar(r.datos.gafete.nombre === ctx.ciudadano.nombre_completo, 'el nombre del gafete no coincide');
    });

    await prueba('la salida se registra y la duración es positiva', async () => {
      const r = await pedir('POST', '/api/visitas/' + visitaId + '/salida', {}, ctx.token);
      esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
      esperar(r.datos.visita.duracion, 'no vino la duración');
      esperar(!r.datos.visita.duracion.startsWith('-'), 'la duración salió negativa: ' + r.datos.visita.duracion);
    });

    await prueba('el panel responde y cuadra', async () => {
      const r = await pedir('GET', '/api/panel', undefined, ctx.token);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(typeof r.datos.panel.metricas.hoy === 'number', 'las métricas no vienen');
    });

    await prueba('los estáticos se sirven y ahora SÍ se cachean', async () => {
      const r = await fetch(BASE + '/app.css');
      esperar(r.status === 200, 'estado ' + r.status);
      const cache = r.headers.get('cache-control') || '';
      esperar(cache.indexOf('max-age') !== -1, 'en producción debería cachear y el encabezado es: ' + cache);
    });

    await prueba('un archivo estático inexistente no rompe la aplicación', async () => {
      const r = await fetch(BASE + '/no-existe-esto.js');
      // El servidor devuelve la aplicación (SPA), no un error: el router del
      // navegador decide qué hacer.
      esperar(r.status === 200 || r.status === 404, 'estado inesperado ' + r.status);
    });

    await prueba('la bitácora de auditoría registró la operación', async () => {
      const r = await pedir('GET', '/api/auditoria?tamano=20', undefined, ctx.token);
      esperar(r.estado === 200, 'estado ' + r.estado);
      const acciones = r.datos.listado.filas.map((f) => f.accion);
      esperar(acciones.indexOf('visita.registrar') !== -1, 'no se registró el alta en la auditoría');
    });

    /* -------------------------------------------------------------- */
    console.log('');
    console.log('Limpieza');

    await prueba('se borra la visita y la institución de prueba', async () => {
      const bd = require(path.join(RAIZ, 'src', 'db.js'));
      await bd.conectarSistema();
      const t = await bd.consultar('SELECT id FROM vf_tenants WHERE codigo = @c', { c: tenant });
      if (t.recordset.length) {
        const id = t.recordset[0].id;
        /* El orden importa: los avisos y los gafetes referencian a las visitas,
           y las visitas al departamento. De lo que depende, a lo dependido. */
        await bd.consultar('DELETE FROM vf_avisos WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_gafetes WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_visitas WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_visitantes WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_personas WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_licencias WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_auditoria WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_ajustes WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_rol_permisos WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_plantillas_gafete WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_departamentos WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_motivos WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_categorias WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_sedes WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_usuarios WHERE tenant_id = @t', { t: id });
        await bd.consultar('DELETE FROM vf_tenants WHERE id = @t', { t: id });
      }
      await bd.cerrar();
    });
  } finally {
    terminar();
    await new Promise((r) => setTimeout(r, 500));

    // Se devuelve el archivo de credenciales de la instalación local.
    try {
      if (credencialesPrevias) fs.writeFileSync(rutaCredenciales, credencialesPrevias);
      else if (fs.existsSync(rutaCredenciales)) fs.unlinkSync(rutaCredenciales);
    } catch (e) {
      console.log('  (no se pudo restaurar CLAVE-ADMINISTRADOR.txt: ' + e.message + ')');
    }

    /* Si algo falló, la salida del proceso es la mejor pista. Se muestra al
       final del informe, no enterrada arriba. */
    if (fallos) {
      console.log('  --- salida de la instancia de producción ---');
      const lineas = salida.split('\n').filter((l) => l.trim());
      console.log(lineas.slice(0, 40).map((l) => '      ' + l).join('\n'));
      console.log('');
    }

    try { fs.rmSync(DATOS, { recursive: true, force: true }); } catch (e) { /* da igual */ }
  }

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(58));
  if (fallos) {
    console.log('');
    for (const d of detalle) console.log('    ' + d);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
