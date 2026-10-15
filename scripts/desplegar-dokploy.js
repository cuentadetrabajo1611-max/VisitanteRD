/**
 * VisitaFlow - Desplegar en el VPS con Dokploy, por su API.
 *
 *   node scripts/desplegar-dokploy.js --comprobar
 *   node scripts/desplegar-dokploy.js --desplegar
 *   node scripts/desplegar-dokploy.js --estado
 *
 * QUE HACE
 * --------
 * Crea el proyecto, sube el docker-compose.yml tal cual (sin repositorio Git: se
 * manda el contenido), pone las variables de entorno, despliega y sigue los
 * registros hasta que el sistema arranca.
 *
 * POR QUE POR LA API Y NO CON GIT
 * -------------------------------
 * Dokploy puede desplegar desde un repositorio, pero eso obliga a subir el codigo
 * a GitHub o GitLab primero. Su API admite el compose en crudo (sourceType
 * "raw"), asi que se puede desplegar sin repositorio y sin claves SSH.
 *
 * QUE NECESITA
 * ------------
 * Un token de API de Dokploy. Se genera en el panel:
 *   Settings -> Profile -> API/CLI -> Generate token
 *
 * Y se pasa por variable de entorno, para no dejarlo escrito en ningun archivo:
 *   $env:DOKPLOY_TOKEN = "..."
 *
 * AVISO SOBRE EL TOKEN
 * --------------------
 * Ese token da control TOTAL sobre tu Dokploy: puede crear, desplegar y borrar
 * cualquier cosa de tu servidor. Tratalo como la contrasena del servidor. Si lo
 * compartes para que se haga el despliegue, puedes revocarlo despues desde el
 * mismo sitio donde lo generaste.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const DOKPLOY = (process.env.DOKPLOY_URL || 'http://206.183.130.121:3000').replace(/\/+$/, '');
const TOKEN = (process.env.DOKPLOY_TOKEN || '').trim();

/* Los nombres que tendra todo en Dokploy. */
const NOMBRE_PROYECTO = process.env.DOKPLOY_PROYECTO || 'visitaflow';
const NOMBRE_SERVICIO = 'visitaflow';

let ok = 0;
let fallos = 0;

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; console.log('  [FALLA] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/* ------------------------------------------------------------------ */
/* Cliente de la API                                                   */
/* ------------------------------------------------------------------ */

async function api(ruta, cuerpo, metodo) {
  const opciones = {
    method: metodo || (cuerpo === undefined ? 'GET' : 'POST'),
    headers: { 'x-api-key': TOKEN, 'Content-Type': 'application/json' },
  };
  if (cuerpo !== undefined) opciones.body = JSON.stringify(cuerpo);

  const r = await fetch(DOKPLOY + '/api/' + ruta.replace(/^\/+/, ''), opciones);
  const texto = await r.text();

  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 300) }; }

  if (!r.ok) {
    const e = new Error(
      'Dokploy respondió ' + r.status + ' en ' + ruta + ': ' +
      (datos.message || datos.error || JSON.stringify(datos).slice(0, 200))
    );
    e.estado = r.status;
    e.datos = datos;
    throw e;
  }
  return datos;
}

/** Lee el compose del proyecto y le quita lo que no sirve para Dokploy. */
function leerCompose() {
  const texto = fs.readFileSync(path.join(RAIZ, 'docker-compose.yml'), 'utf8');

  /* Dokploy pone su propia red y su propio Traefik: las declaraciones de red del
   * compose casero pueden chocar. El archivo del proyecto no declara redes
   * propias (usa la de por defecto), asi que no hay nada que quitar. Se deja
   * constancia por si algun dia se anaden. */
  return texto;
}

/* ------------------------------------------------------------------ */
/* Comprobaciones antes de tocar nada                                  */
/* ------------------------------------------------------------------ */

async function comprobar() {
  console.log('');
  console.log('  VisitaFlow - despliegue en Dokploy');
  console.log('  ' + '='.repeat(66));
  console.log('  Servidor: ' + DOKPLOY);

  paso('1. El servidor de Dokploy responde');

  try {
    const r = await fetch(DOKPLOY + '/api/health');
    if (r.ok) bien('Dokploy responde en ' + DOKPLOY);
    else mal('Dokploy respondió ' + r.status);
  } catch (e) {
    mal('No se pudo contactar ' + DOKPLOY + ': ' + e.message);
    return false;
  }

  paso('2. El token de API');

  if (!TOKEN) {
    mal('Falta DOKPLOY_TOKEN.');
    info('Genérelo en el panel:  Settings -> Profile -> API/CLI -> Generate token');
    info('Y pásemelo, o ejecute:  $env:DOKPLOY_TOKEN = "el-token"');
    return false;
  }

  try {
    await api('project.all');
    bien('el token funciona (se pudo listar los proyectos)');
  } catch (e) {
    if (e.estado === 401) {
      mal('El token no es válido (401). Genere uno nuevo en Settings -> Profile -> API/CLI.');
    } else {
      mal(e.message);
    }
    return false;
  }

  paso('3. El compose del proyecto');

  try {
    const compose = leerCompose();
    const tieneServicios = /^services:/m.test(compose);
    if (!tieneServicios) {
      mal('el docker-compose.yml no tiene la sección "services"');
      return false;
    }
    const n = (compose.match(/^  [a-z][a-z0-9-]*:/gm) || []).length;
    bien('el compose tiene ' + n + ' servicio(s) y ' + compose.length + ' caracteres');
  } catch (e) {
    mal('no se pudo leer docker-compose.yml: ' + e.message);
    return false;
  }

  paso('4. Las variables obligatorias');

  /* El compose usa ${VAR:?mensaje}: si falta alguna, el despliegue se detiene.
     Conviene saberlo antes de lanzarlo. */
  const obligatorias = [];
  const re = /\$\{([A-Z_][A-Z0-9_]*):\?/g;
  let m;
  while ((m = re.exec(compose)) !== null) obligatorias.push(m[1]);

  const presentes = [];
  const ausentes = [];
  for (const v of obligatorias) {
    if (process.env[v]) presentes.push(v);
    else ausentes.push(v);
  }

  if (presentes.length) bien('definidas en este entorno: ' + presentes.join(', '));
  if (ausentes.length) {
    info('no están en este entorno (se pondrán como variables de Dokploy): ' + ausentes.join(', '));
    info('genérelas con:  npm run desplegar:preparar');
  }

  return fallos === 0;
}

/* ------------------------------------------------------------------ */
/* El despliegue                                                       */
/* ------------------------------------------------------------------ */

/** El proyecto, creándolo si no existe. */
async function asegurarProyecto() {
  const proyectos = await api('project.all');
  const lista = Array.isArray(proyectos) ? proyectos : [];
  const existente = lista.find((p) => p.name === NOMBRE_PROYECTO);
  if (existente) {
    bien('el proyecto "' + NOMBRE_PROYECTO + '" ya existe');
    return existente;
  }

  const creado = await api('project.create', {
    name: NOMBRE_PROYECTO,
    description: 'Sistema de visitantes y servidor de licencias',
  });
  bien('proyecto "' + NOMBRE_PROYECTO + '" creado');
  return creado;
}

/** El entorno por defecto del proyecto (Dokploy siempre crea uno). */
async function entornoDe(proyectoId) {
  const e = await api('environment.byProjectId?projectId=' + encodeURIComponent(proyectoId));
  const lista = Array.isArray(e) ? e : (e.environments || []);
  if (!lista.length) throw new Error('El proyecto no tiene ningún entorno.');
  return lista[0];
}

/** El servicio de compose, creándolo si no existe. */
async function asegurarServicio(entornoId) {
  const servicios = await api('compose.byEnvironmentId?environmentId=' + encodeURIComponent(entornoId));
  const lista = Array.isArray(servicios) ? servicios : (servicios.compose || []);
  const existente = lista.find((c) => c.name === NOMBRE_SERVICIO);

  const composeFile = leerCompose();

  if (existente) {
    await api('compose.update', {
      composeId: existente.composeId,
      composeFile: composeFile,
      sourceType: 'raw',
    });
    bien('servicio actualizado con el compose del proyecto');
    return existente;
  }

  const creado = await api('compose.create', {
    name: NOMBRE_SERVICIO,
    description: 'VisitaFlow: sistema de visitantes y servidor de licencias',
    environmentId: entornoId,
    composeType: 'docker-compose',
    // El compose se manda tal cual: no hace falta repositorio Git.
    sourceType: 'raw',
    composeFile: composeFile,
  });
  bien('servicio de compose creado');
  return creado;
}

/** Las variables de entorno que necesita el compose. */
function variablesDelCompose() {
  const compose = leerCompose();

  /* Se saltan los comentarios: en las notas del compose se escribe ${VAR:?...}
     como ejemplo, y eso no es una variable de verdad. */
  const sinComentarios = compose.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const nombres = new Set();
  let m;
  const re = /\$\{([A-Z_][A-Z0-9_]*)/g;
  while ((m = re.exec(sinComentarios)) !== null) nombres.add(m[1]);

  const valores = {};
  for (const n of nombres) {
    const v = process.env[n];
    if (v) valores[n] = v;
  }
  return valores;
}

async function desplegar() {
  paso('Creando todo en Dokploy');

  const proyecto = await asegurarProyecto();
  const entorno = await entornoDe(proyecto.projectId);
  bien('entorno: ' + (entorno.name || entorno.environmentId));

  const servicio = await asegurarServicio(entorno.environmentId);
  const composeId = servicio.composeId;

  /* Las variables: se pasan las que tenga el entorno local. Las que falten hay
     que ponerlas a mano en el panel, y el despliegue lo dirá. */
  const vars = variablesDelCompose();
  const cuantas = Object.keys(vars).length;

  if (cuantas) {
    await api('compose.saveEnvironment', {
      composeId: composeId,
      env: Object.keys(vars).map((k) => k + '=' + vars[k]).join('\n'),
    });
    bien(cuantas + ' variables de entorno guardadas (' + Object.keys(vars).join(', ') + ')');
  } else {
    info('no se pasaron variables: póngalas en el panel antes de desplegar');
  }

  paso('Desplegando');
  info('esto construye la imagen y levanta los tres servicios; tarda varios minutos');

  const despliegue = await api('compose.deploy', { composeId: composeId });
  bien('despliegue lanzado: ' + (despliegue.message || 'en marcha'));

  return { proyectoId: proyecto.projectId, composeId: composeId };
}

/** El estado de los servicios. */
async function estado(composeId) {
  paso('Estado');

  try {
    const d = await api('compose.one?composeId=' + encodeURIComponent(composeId));
    const c = d.compose || d;
    console.log('  ' + (c.name || '') + '  estado: ' + (c.composeStatus || '—'));
    if (c.composeStatus === 'error') {
      info('revise los registros en el panel de Dokploy');
    }
  } catch (e) {
    mal('no se pudo leer el estado: ' + e.message);
  }

  /* Y una comprobación de verdad: ¿responde la aplicación? */
  const url = process.env.URL_PUBLICA;
  if (url) {
    try {
      const r = await fetch(url.replace(/\/+$/, '') + '/api/salud', { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      console.log('');
      bien('el sistema responde en ' + url);
      info('licencia: ' + j.licencia.estado + (j.licencia.cliente ? ' — ' + j.licencia.cliente : ''));
      info('base de datos: ' + (j.base_datos.disponible ? 'conectada' : 'NO conectada'));
      info('cédulas: ' + (j.cedulas.disponible ? 'conectadas' : 'NO conectadas'));
      info('servidor de licencias: ' + (j.servidor_licencias.direccion || 'no configurado'));
    } catch (e) {
      info('todavía no responde en ' + url + ' (' + e.message + ')');
      info('puede tardar: la base de datos tarda un minuto en aceptar conexiones');
    }
  }
}

/* ------------------------------------------------------------------ */

async function principal() {
  const arg = process.argv[2] || '--comprobar';

  const listo = await comprobar();
  if (!listo) {
    console.log('');
    console.log('  ' + fallos + ' problema(s). No se tocó nada en el servidor.');
    console.log('');
    process.exit(1);
  }

  if (arg === '--comprobar') {
    console.log('');
    console.log('  ' + '='.repeat(66));
    console.log('  Todo listo para desplegar.');
    console.log('  Ejecute:  node scripts/desplegar-dokploy.js --desplegar');
    console.log('');
    return;
  }

  if (arg === '--estado') {
    const proyectos = await api('project.all');
    const p = (Array.isArray(proyectos) ? proyectos : []).find((x) => x.name === NOMBRE_PROYECTO);
    if (!p) {
      console.log('');
      console.log('  El proyecto "' + NOMBRE_PROYECTO + '" no existe todavía en Dokploy.');
      console.log('');
      return;
    }
    const e = await entornoDe(p.projectId);
    const servicios = await api('compose.byEnvironmentId?environmentId=' + encodeURIComponent(e.environmentId));
    const lista = Array.isArray(servicios) ? servicios : (servicios.compose || []);
    const s = lista.find((c) => c.name === NOMBRE_SERVICIO);
    if (!s) {
      console.log('');
      console.log('  El servicio todavía no existe.');
      console.log('');
      return;
    }
    await estado(s.composeId);
    console.log('');
    return;
  }

  if (arg === '--desplegar') {
    const r = await desplegar();
    console.log('');
    console.log('  ' + '='.repeat(66));
    console.log('  Despliegue lanzado. Mire los registros en el panel de Dokploy.');
    console.log('');
    console.log('  Cuando termine, compruebe:');
    console.log('    node scripts/desplegar-dokploy.js --estado');
    console.log('');
    console.log('  Y después, dentro del contenedor:');
    console.log('    docker exec -it visitaflow-app node sql/01-crear.js');
    console.log('');
    return;
  }

  console.log('');
  console.log('  Uso:');
  console.log('    node scripts/desplegar-dokploy.js --comprobar   (revisa sin tocar nada)');
  console.log('    node scripts/desplegar-dokploy.js --desplegar   (crea y despliega)');
  console.log('    node scripts/desplegar-dokploy.js --estado      (cómo va)');
  console.log('');
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  if (e.estado === 401) {
    console.error('  El token de API no vale. Genere uno nuevo en Settings -> Profile -> API/CLI.');
  }
  console.error('');
  process.exit(1);
});
