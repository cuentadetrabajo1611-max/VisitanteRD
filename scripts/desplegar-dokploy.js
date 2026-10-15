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

/* Un aviso NO es un fallo: el despliegue puede seguir. Pero se cuentan aparte para que
 * la comprobación diga cuántas cosas conviene mirar antes de seguir, en vez de dar un
 * "todo en orden" que oculte lo que falta.
 *
 * Esta función NO existía, y la sección de dominios la llamaba: `--comprobar` se caía
 * con "aviso is not defined" en cuanto no se indicaba ningún dominio, o sea en la
 * primera ejecución de cualquiera. Un error que no dice nada del problema real. */
let avisos = 0;
function aviso(t) { avisos++; console.log('  [ojo]   ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/* ------------------------------------------------------------------ */
/* Cliente de la API                                                   */
/* ------------------------------------------------------------------ */

/**
 * Llama a la API de Dokploy.
 *
 * SIEMPRE por POST con el cuerpo en JSON, incluidas las consultas.
 *
 * Esto no es capricho: tRPC (que es lo que usa Dokploy por dentro) atiende las
 * consultas por GET, pero entonces los parámetros tienen que ir en un formato
 * especial, y armar la URL a mano falla. Con POST, el nombre del procedimiento
 * queda limpio en la ruta y los parámetros viajan en el cuerpo, que es lo que
 * tRPC espera en ese caso. Se comprobó contra el código de Dokploy.
 */
async function api(ruta, cuerpo) {
  const r = await fetch(DOKPLOY + '/api/' + ruta.replace(/^\/+/, ''), {
    method: 'POST',
    headers: { 'x-api-key': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo === undefined ? {} : cuerpo),
  });
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

/**
 * Los nombres de los servicios del compose.
 *
 * Solo los de PRIMER nivel dentro de `services:`: los que tienen exactamente dos
 * espacios de sangria y no van precedidos de "-". Contar con una expresion
 * regular suelta daba de mas, porque claves como `build:`, `environment:` o
 * `volumes:` tambien tienen esa forma.
 */
function serviciosDelCompose(texto) {
  const lineas = (texto || leerCompose()).split('\n');
  const salida = [];
  let dentro = false;

  for (const linea of lineas) {
    if (/^services:\s*$/.test(linea)) { dentro = true; continue; }
    // Otra seccion de primer nivel cierra la lista.
    if (dentro && /^[a-zA-Z]/.test(linea)) break;
    if (!dentro) continue;

    const m = /^ {2}([a-zA-Z0-9._-]+):\s*$/.exec(linea);
    if (m) salida.push(m[1]);
  }

  return salida;
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

  /* Si falta el token, no se corta aquí: se sigue comprobando el resto para que
     de una sola pasada se vea TODO lo que hay que arreglar. Descubrir los
     problemas de uno en uno, ejecutando el script cinco veces, es una pérdida de
     tiempo para quien lo usa. */
  if (!TOKEN) {
    mal('Falta DOKPLOY_TOKEN.');
    info('Genérelo en el panel:  Settings -> Profile -> API/CLI -> Generate token');
    info('Y ejecute:  $env:DOKPLOY_TOKEN = "el-token"');
  } else {
    try {
      await api('project.all');
      bien('el token funciona (se pudo listar los proyectos)');
    } catch (e) {
      if (e.estado === 401) {
        mal('El token no es válido (401). Genere uno nuevo en Settings -> Profile -> API/CLI.');
      } else {
        mal(e.message);
      }
    }
  }

  paso('3. El compose del proyecto');

  try {
    const compose = leerCompose();
    if (!/^services:/m.test(compose)) {
      mal('el docker-compose.yml no tiene la sección "services"');
    } else {
      const servicios = serviciosDelCompose(compose);
      bien('el compose tiene ' + servicios.length + ' servicio(s): ' + servicios.join(', '));
      info('(' + compose.length + ' caracteres)');
    }
  } catch (e) {
    mal('no se pudo leer docker-compose.yml: ' + e.message);
  }

  paso('4. Las variables obligatorias');

  /* El compose usa ${VAR:?mensaje}: si falta alguna, el despliegue se detiene.
     Conviene saberlo antes de lanzarlo.
     
     Se quitan los comentarios primero: en las notas del compose se escribe
     ${VAR:?...} como ejemplo, y eso NO es una variable de verdad. Sin esto
     aparecia una variable "VAR" que no existe en ningun sitio. */
  const sinComentarios = leerCompose().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const obligatorias = new Set();
  const re = /\$\{([A-Z_][A-Z0-9_]*):\?/g;
  let m;
  while ((m = re.exec(sinComentarios)) !== null) obligatorias.add(m[1]);

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

  paso('5. Los dominios');

  const dominios = dominiosPedidos();
  if (!dominios.length) {
    aviso('no se indicó ningún dominio.');
    info('Sin dominio, el sistema solo será accesible desde dentro del servidor.');
    info('Indique antes de desplegar, si los tiene:');
    info('  $env:VISITAS_DOMINIO = "visitas.su-dominio.com"');
    info('  $env:LICENCIAS_DOMINIO = "licencias.su-dominio.com"');
    info('Y que los dos nombres apunten a 206.183.130.121 en su proveedor de DNS.');

    /* Si no hay dominio de licencias, el servidor queda con su nombre interno de Docker
       y NINGUNA instalación de cliente podrá activarse ni renovar. Conviene decirlo
       ahora y no descubrirlo cuando ya haya un cliente esperando. */
    aviso('sin LICENCIAS_DOMINIO, el servidor de licencias queda en ' +
      (variablesDelCompose().LICENCIA_SERVIDOR_URL || 'http://licencias:4100') +
      ', que solo existe dentro del servidor.');
    info('Las instalaciones de sus clientes NO podrán activarse ni renovar hasta que');
    info('el servidor de licencias tenga una dirección pública con HTTPS.');
  } else {
    for (const d of dominios) {
      bien(d.host + '  ->  ' + d.servicio + ':' + d.puerto);
      info('(' + d.paraQue + ')');
    }
    info('compruebe que esos nombres ya apuntan a 206.183.130.121, o el');
    info('certificado HTTPS no se podrá emitir.');
  }

  return fallos === 0;
}

/* ------------------------------------------------------------------ */
/* El despliegue                                                       */
/* ------------------------------------------------------------------ */

/**
 * El proyecto, creándolo si no existe.
 *
 * Siempre devuelve el MISMO formato: el de `project.all`, que trae los entornos
 * anidados. `project.create` devuelve otra cosa distinta ({ project, environment }),
 * y mezclarlas fue un error que ya se corrigió una vez.
 */
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

  /* Se vuelve a leer la lista en vez de usar lo que devolvió create: así el
     formato es siempre el mismo y no hay dos caminos que puedan divergir. */
  const otraVez = await api('project.all');
  const nuevo = (Array.isArray(otraVez) ? otraVez : []).find((p) => p.name === NOMBRE_PROYECTO);

  if (!nuevo) {
    // Si no aparece, se arma con lo que devolvió create para no quedarse sin nada.
    const id = (creado.project && creado.project.projectId) || creado.projectId;
    const entorno = creado.environment || {};
    return {
      projectId: id,
      name: NOMBRE_PROYECTO,
      environments: entorno.environmentId
        ? [{ environmentId: entorno.environmentId, name: entorno.name, isDefault: true, compose: [] }]
        : [],
    };
  }

  return nuevo;
}

/** El entorno por defecto del proyecto (Dokploy siempre crea uno). */
async function entornoDe(proyecto) {
  /* `project.all` devuelve los entornos ANIDADOS dentro de cada proyecto. No hay
   * un endpoint suelto que los liste, así que se leen de ahí. */
  const entornos = proyecto.environments || [];
  if (!entornos.length) throw new Error('El proyecto no tiene ningún entorno.');
  // El primero es el que Dokploy crea solo, y no se puede borrar.
  return entornos.find((e) => e.isDefault) || entornos[0];
}

/** Los servicios de compose que ya tiene el entorno. */
function serviciosDe(proyecto) {
  const salida = [];
  for (const e of proyecto.environments || []) {
    for (const c of e.compose || []) {
      salida.push(Object.assign({ environmentId: e.environmentId }, c));
    }
  }
  return salida;
}

/**
 * Los dominios que hay que configurar, si se indicaron.
 *
 * Se leen de variables de entorno, para que el que despliega decida:
 *
 *   VISITAS_DOMINIO=visitas.su-dominio.com
 *   LICENCIAS_DOMINIO=licencias.su-dominio.com
 *
 * Si no se indica ninguno, no se crea nada: el sistema queda alcanzable solo
 * desde dentro del servidor, y hay que configurarlos a mano en el panel.
 */
function dominiosPedidos() {
  const salida = [];

  const visitas = (process.env.VISITAS_DOMINIO || '').trim();
  if (visitas) {
    salida.push({
      host: visitas,
      puerto: Number(process.env.VISITAS_PUERTO || 3000),
      // El nombre del servicio TAL COMO está en el docker-compose.yml, no el
      // nombre del servicio de Dokploy: es lo que Traefik usa para enrutar.
      servicio: 'app',
      paraQue: 'el sistema de visitantes',
    });
  }

  const licencias = (process.env.LICENCIAS_DOMINIO || '').trim();
  if (licencias) {
    salida.push({
      host: licencias,
      puerto: Number(process.env.LICENCIAS_PUERTO || 4100),
      servicio: 'licencias',
      paraQue: 'el servidor de licencias (lo necesitan los clientes para activar)',
    });
  }

  return salida;
}

/**
 * Configura los dominios de un servicio de compose.
 *
 * IMPORTANTE: los dominios de compose se aplican como ETIQUETAS de Docker, así
 * que hay que crearlos ANTES de desplegar. Si se crean después, el cambio no
 * surte efecto hasta el siguiente despliegue.
 */
async function configurarDominios(composeId) {
  const pedidos = dominiosPedidos();
  if (!pedidos.length) {
    info('no se indicaron dominios.');
    info('Para que el sistema sea accesible, indique antes de desplegar:');
    info('  $env:VISITAS_DOMINIO = "visitas.su-dominio.com"');
    info('  $env:LICENCIAS_DOMINIO = "licencias.su-dominio.com"');
    info('Y que los dos nombres apunten a 206.183.130.121 en su proveedor de DNS.');
    return [];
  }

  /* Los que ya existen, para no duplicar. */
  let existentes = [];
  try {
    const r = await api('domain.byComposeId', { composeId: composeId });
    existentes = Array.isArray(r) ? r : [];
  } catch (e) {
    existentes = [];
  }

  const creados = [];
  for (const d of pedidos) {
    const yaEsta = existentes.find((x) => x.host === d.host);
    if (yaEsta) {
      bien('el dominio ' + d.host + ' ya estaba configurado');
      creados.push(yaEsta);
      continue;
    }

    try {
      const r = await api('domain.create', {
        host: d.host,
        port: d.puerto,
        https: true,
        certificateType: 'letsencrypt',
        domainType: 'compose',
        composeId: composeId,
        serviceName: d.servicio,
        stripPath: false,
      });
      bien('dominio ' + d.host + ' -> ' + d.servicio + ':' + d.puerto + '  (' + d.paraQue + ')');
      creados.push(r);
    } catch (e) {
      mal('no se pudo configurar el dominio ' + d.host + ': ' + e.message);
      info('recuerde que el nombre tiene que existir en su DNS y apuntar a este servidor');
    }
  }

  return creados;
}

/** El servicio de compose, creándolo si no existe. */
async function asegurarServicio(proyecto, entornoId) {
  /* No existe `compose.byEnvironmentId`: se comprobó contra el código de Dokploy.
     Los servicios vienen dentro del proyecto. */
  const existente = serviciosDe(proyecto).find((c) => c.name === NOMBRE_SERVICIO);
  const composeFile = leerCompose();

  if (existente) {
    await api('compose.update', {
      composeId: existente.composeId,
      sourceType: 'raw',
      composeType: 'docker-compose',
      composeFile: composeFile,
    });
    bien('servicio actualizado con el compose del proyecto');
    return existente;
  }

  const creado = await api('compose.create', {
    name: NOMBRE_SERVICIO,
    description: 'VisitaFlow: sistema de visitantes y servidor de licencias',
    environmentId: entornoId,
    composeType: 'docker-compose',
    /* El compose se manda tal cual: no hace falta repositorio Git. El
       sourceType tiene que ser "raw" EXPLÍCITAMENTE, porque si no Dokploy lo
       guarda como si viniera de Git y falla al desplegar. */
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

  /* LAS DIRECCIONES PÚBLICAS SE DEDUCEN DEL DOMINIO, si no se dieron ya.
   *
   * Esto no es un adorno: `LICENCIA_SERVIDOR_URL` trae por defecto el nombre interno
   * de Docker (http://licencias:4100). Ese nombre solo existe DENTRO del servidor, así
   * que si se despliega así, las instalaciones de los clientes no pueden alcanzar el
   * servidor de licencias para activarse: se instalan, piden el ID de licencia y no
   * hay forma de que lleguen. El fallo aparece en casa del cliente, no aquí.
   *
   * Como el dominio ya se pide para el certificado, se aprovecha: si indicó
   * LICENCIAS_DOMINIO, la dirección pública es ese dominio con https. Y lo mismo para
   * la dirección pública del sistema. Si ya venían definidas a mano, mandan ellas. */
  const licencias = (process.env.LICENCIAS_DOMINIO || '').trim();
  if (licencias && !valores.LICENCIA_SERVIDOR_URL) {
    valores.LICENCIA_SERVIDOR_URL = 'https://' + licencias;
  }

  const visitas = (process.env.VISITAS_DOMINIO || '').trim();
  if (visitas && !valores.URL_PUBLICA) {
    valores.URL_PUBLICA = 'https://' + visitas;
  }

  return valores;
}

async function desplegar() {
  paso('Creando todo en Dokploy');

  const proyecto = await asegurarProyecto();
  const entorno = await entornoDe(proyecto);
  bien('entorno: ' + (entorno.name || entorno.environmentId));

  const servicio = await asegurarServicio(proyecto, entorno.environmentId);
  const composeId = servicio.composeId;
  if (!composeId) throw new Error('Dokploy no devolvió el identificador del servicio.');

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

  /* Los dominios van ANTES de desplegar: en un compose son etiquetas de Docker,
     y si se crean después no surten efecto hasta el siguiente despliegue. */
  paso('Dominios');
  await configurarDominios(composeId);

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
    const d = await api('compose.one', { composeId: composeId });
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
    if (avisos) {
      console.log('  ' + avisos + ' aviso(s) arriba: no impiden desplegar, pero léalos.');
    }
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
    const s = serviciosDe(p).find((c) => c.name === NOMBRE_SERVICIO);
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
