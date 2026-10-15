/**
 * VisitaFlow - Revision del despliegue.
 *
 *   node scripts/revisar-despliegue.js
 *
 * No puede construir la imagen (eso necesita Docker), pero si comprueba lo que
 * suele romperse en un despliegue y que no se descubre hasta que el contenedor
 * ya esta arriba:
 *
 *   1. Que el Dockerfile copie TODO lo que el codigo necesita en tiempo de
 *      ejecucion. Un archivo que falte da "Cannot find module" al arrancar.
 *   2. Que los require() del codigo apunten a archivos que entren en la imagen.
 *   3. Que el Compose tenga todos los servicios, volumenes y variables que el
 *      codigo lee del entorno.
 *   4. Que el .dockerignore no excluya nada imprescindible.
 *
 * Es barato de correr y evita el ciclo de subir, fallar, mirar el log y volver.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');

let problemas = 0;
let avisos = 0;

function error(texto, detalle) {
  problemas++;
  console.log('  [X] ' + texto);
  if (detalle) console.log('      ' + detalle);
}

function aviso(texto, detalle) {
  avisos++;
  console.log('  [!] ' + texto);
  if (detalle) console.log('      ' + detalle);
}

function bien(texto) {
  console.log('  [ok] ' + texto);
}

function leer(rel) {
  const p = path.join(RAIZ, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/* ------------------------------------------------------------------ */
/* 1. Lista de archivos que el .dockerignore deja pasar                 */
/* ------------------------------------------------------------------ */

/**
 * Aplica las reglas del .dockerignore.
 * Soporta lo que se usa en este proyecto: comentarios, negaciones con !,
 * directorios con / y comodines *.
 */
function aplicarDockerignore(archivos) {
  const texto = leer('.dockerignore') || '';
  const reglas = texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => ({ negar: l.startsWith('!'), patron: l.replace(/^!/, '').replace(/\/$/, '') }));

  return archivos.filter((rel) => {
    let incluido = true;
    for (const r of reglas) {
      const partes = rel.split('/');
      const coincide =
        rel === r.patron ||
        partes[0] === r.patron ||
        partes.includes(r.patron) ||
        new RegExp('^' + r.patron.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(partes[partes.length - 1]);
      if (coincide) incluido = !r.negar;
    }
    return incluido;
  });
}

/** Todos los archivos del proyecto, en rutas relativas con barra normal. */
function listarArchivos(dir, base, salida) {
  const b = base || '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = b ? b + '/' + e.name : e.name;
    if (e.isDirectory()) {
      // node_modules y tmp nunca entran en la imagen.
      if (['node_modules', 'tmp', '.git', 'capturas', 'datos', 'licencias-keys', 'docs'].includes(e.name)) continue;
      listarArchivos(path.join(dir, e.name), rel, salida);
    } else {
      salida.push(rel);
    }
  }
  return salida;
}

/* ------------------------------------------------------------------ */
/* 2. Lo que el Dockerfile copia                                        */
/* ------------------------------------------------------------------ */

function copiadosPorDockerfile() {
  const texto = leer('Dockerfile');
  if (!texto) return null;
  const copias = [];
  for (const linea of texto.split('\n')) {
    const m = linea.match(/^\s*COPY\s+(.+)$/);
    if (!m) continue;
    if (m[1].indexOf('--from=') !== -1) continue; // de otra etapa, no del contexto
    const partes = m[1].trim().split(/\s+/);
    partes.pop(); // el destino
    for (const origen of partes) copias.push(origen.replace(/^\.\//, ''));
  }
  return copias;
}

/* ------------------------------------------------------------------ */
/* 3. Pruebas                                                          */
/* ------------------------------------------------------------------ */

function revisarDockerfile() {
  console.log('');
  console.log('  --- Dockerfile ---');

  const texto = leer('Dockerfile');
  if (!texto) return error('No existe el Dockerfile');

  const copias = copiadosPorDockerfile();
  const necesarios = [
    ['package.json', 'manifiesto'],
    ['server.js', 'servidor del sistema'],
    ['server-licencias.js', 'servidor de licencias'],
    ['src', 'codigo del sistema'],
    ['public', 'interfaz web'],
    ['public-licencias', 'consola de licencias'],
    ['sql', 'esquema y pruebas'],
    ['scripts', 'utilidades'],
  ];

  for (const [ruta, que] of necesarios) {
    if (copias.indexOf(ruta) === -1) error('El Dockerfile no copia "' + ruta + '" (' + que + ')');
    else if (!fs.existsSync(path.join(RAIZ, ruta))) error('El Dockerfile copia "' + ruta + '" pero no existe');
    else bien('copia ' + ruta + ' (' + que + ')');
  }

  // La etapa de dependencias necesita el lockfile para "npm ci".
  if (copias.indexOf('package-lock.json') === -1 && copias.indexOf('package*.json') === -1) {
    if (!fs.existsSync(path.join(RAIZ, 'package-lock.json'))) {
      error('No hay package-lock.json y el Dockerfile usa "npm ci"', 'npm ci falla sin el lockfile');
    } else {
      error('La etapa de dependencias no copia package-lock.json', 'npm ci lo necesita');
    }
  }

  // El usuario sin privilegios tiene que poder leer lo copiado.
  if (texto.indexOf('USER ') === -1) aviso('El contenedor corre como root', 'Conviene un usuario sin privilegios');
  else bien('corre como usuario sin privilegios');

  if (texto.indexOf('HEALTHCHECK') === -1) aviso('Sin HEALTHCHECK', 'Dokploy no sabra si el contenedor esta listo');
  else bien('tiene HEALTHCHECK');

  if (texto.indexOf('dumb-init') === -1) aviso('Sin dumb-init', 'Las senales de reinicio pueden no llegar a Node');
  else bien('usa dumb-init para las senales');

  // La llave privada NUNCA debe copiarse.
  for (const c of copias) {
    if (c.indexOf('licencias-keys') !== -1 || c.indexOf('.env') !== -1 || c.indexOf('.pem') !== -1) {
      error('El Dockerfile copia un secreto: ' + c, 'La llave privada no puede ir dentro de la imagen');
    }
  }
}

function revisarDockerignore() {
  console.log('');
  console.log('  --- .dockerignore ---');

  const texto = leer('.dockerignore');
  if (!texto) return aviso('No hay .dockerignore', 'La imagen incluiria node_modules, .env y las llaves');

  const obligatorios = ['.env', 'licencias-keys', 'node_modules', 'tmp'];
  for (const o of obligatorios) {
    if (texto.indexOf(o) === -1) error('.dockerignore no excluye "' + o + '"');
    else bien('excluye ' + o);
  }

  // Que no excluya algo que el Dockerfile necesita copiar.
  const todos = listarArchivos(RAIZ, '', []);
  const pasan = aplicarDockerignore(todos);
  const copias = copiadosPorDockerfile() || [];

  for (const c of copias) {
    if (c.indexOf('*') !== -1) continue;
    const esDir = fs.existsSync(path.join(RAIZ, c)) && fs.statSync(path.join(RAIZ, c)).isDirectory();
    if (esDir) {
      const dentro = todos.filter((f) => f.startsWith(c + '/'));
      const quedan = pasan.filter((f) => f.startsWith(c + '/'));
      if (dentro.length && !quedan.length) {
        error('".dockerignore" excluye TODO el contenido de "' + c + '"', 'El Dockerfile lo copia y quedaria vacio');
      } else if (dentro.length) {
        bien(c + '/ -> ' + quedan.length + ' de ' + dentro.length + ' archivos entran');
      }
    } else if (todos.indexOf(c) !== -1 && pasan.indexOf(c) === -1) {
      error('".dockerignore" excluye "' + c + '", que el Dockerfile copia');
    }
  }
}

/** Los require() relativos del codigo tienen que existir dentro de la imagen. */
function revisarRequires() {
  console.log('');
  console.log('  --- require() del codigo ---');

  const textos = [leer('server.js') || '', leer('server-licencias.js') || ''];
  const dirs = ['src', 'sql', 'scripts'];
  const archivos = [];

  for (const d of dirs) {
    const p = path.join(RAIZ, d);
    if (!fs.existsSync(p)) continue;
    (function recorrer(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) recorrer(full);
        else if (e.name.endsWith('.js')) archivos.push(full);
      }
    })(p);
  }

  const faltantes = [];
  for (const a of archivos) {
    const contenido = fs.readFileSync(a, 'utf8');
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(contenido)) !== null) {
      const destino = path.resolve(path.dirname(a), m[1]);
      const existe = fs.existsSync(destino) || fs.existsSync(destino + '.js') || fs.existsSync(path.join(destino, 'index.js'));
      if (!existe) faltantes.push(path.relative(RAIZ, a) + ' -> ' + m[1]);
    }
  }

  if (faltantes.length) {
    for (const f of faltantes) error('require() roto: ' + f);
  } else {
    bien(archivos.length + ' archivos revisados, todos los require() resuelven');
  }
}

/* ------------------------------------------------------------------ */
/* 4. Compose                                                          */
/* ------------------------------------------------------------------ */

/**
 * Texto del bloque de un servicio del Compose.
 *
 * Se corta por sangria: el servicio empieza en "  nombre:" y termina en la
 * siguiente linea que empiece en la columna 2. Cortar por texto plano (buscar
 * el nombre y quedarse con todo lo que sigue) daba un falso positivo: el bloque
 * de "app" se comia el de "licencias", y parecia que la app recibia la llave
 * privada cuando en realidad no era asi.
 */
function bloqueServicio(texto, nombre) {
  const lineas = texto.split('\n');
  const inicio = lineas.findIndex((l) => l.match(new RegExp('^  ' + nombre + ':')));
  if (inicio === -1) return '';
  const salida = [lineas[inicio]];
  for (let i = inicio + 1; i < lineas.length; i++) {
    const l = lineas[i];
    if (l.trim() && !/^\s{3,}/.test(l) && !/^  [a-z]/.test(l)) break; // se acabo el servicio
    if (/^  [a-zA-Z_-]+:/.test(l)) break;
    salida.push(l);
  }
  return salida.join('\n');
}

function revisarCompose() {
  console.log('');
  console.log('  --- docker-compose.yml ---');

  const texto = leer('docker-compose.yml');
  if (!texto) return error('No existe docker-compose.yml');

  // Comprobaciones de texto: no hay parser de YAML a mano, pero estas son las
  // equivocaciones que de verdad ocurren.
  const servicios = ['bd-sistema', 'licencias', 'app'];
  for (const s of servicios) {
    const re = new RegExp('^  ' + s + ':', 'm');
    if (!re.test(texto)) error('Falta el servicio "' + s + '" en el Compose');
    else bien('servicio ' + s);
  }

  // Cada `${VAR}` del Compose tiene que estar documentada en .env.example.
  // Se saltan los comentarios: en las notas del compose se escribe ${VAR:?...}
  // como ejemplo, y eso no es una variable de verdad.
  const ejemplo = leer('.env.example') || '';
  const variables = new Set();
  let m;
  const reVar = /\$\{([A-Z_][A-Z0-9_]*)/g;
  const sinComentarios = texto
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  while ((m = reVar.exec(sinComentarios)) !== null) variables.add(m[1]);

  const sinDocumentar = [];
  for (const v of variables) {
    if (ejemplo.indexOf(v) === -1) sinDocumentar.push(v);
  }
  if (sinDocumentar.length) {
    aviso('Variables del Compose que no están en .env.example: ' + sinDocumentar.join(', '));
  } else {
    bien(variables.size + ' variables del Compose documentadas en .env.example');
  }

  // El codigo lee del entorno: ¿estan todas en el Compose o en .env.example?
  const config = leer('src/config.js') || '';
  const leidas = new Set();
  const reEnv = /texto\(\s*'([A-Z_][A-Z0-9_]*)'|numero\(\s*'([A-Z_][A-Z0-9_]*)'|booleano\(\s*'([A-Z_][A-Z0-9_]*)'/g;
  while ((m = reEnv.exec(config)) !== null) {
    const nombre = m[1] || m[2] || m[3];
    if (nombre) leidas.add(nombre);
  }

  const faltanEnCompose = [];
  const sinValor = ['PORT', 'HOST', 'NODE_ENV', 'TZ']; // los pone la imagen o el sistema
  for (const v of leidas) {
    if (sinComentarios.indexOf(v + ':') === -1 && ejemplo.indexOf(v) === -1 && sinValor.indexOf(v) === -1) {
      faltanEnCompose.push(v);
    }
  }
  if (faltanEnCompose.length) {
    aviso('El código lee variables que no están ni en el Compose ni en .env.example: ' + faltanEnCompose.join(', '));
  } else {
    bien('todas las variables que lee el código están contempladas');
  }

  // Los dos servicios tienen que compartir la clave de SQL.
  if (texto.indexOf('CLAVE_SQL') === -1) error('El Compose no usa CLAVE_SQL para la contraseña de SQL Server');
  else bien('la contraseña de SQL Server viene de CLAVE_SQL');

  // El servicio de la app tiene que esperar a la base.
  if (texto.indexOf('condition: service_healthy') === -1) {
    aviso('La app no espera a que la base esté lista', 'Puede fallar el primer arranque');
  } else {
    bien('la app espera a que la base esté sana');
  }

  // Y el servidor de licencias tiene que tener la llave privada.
  if (texto.indexOf('LICENCIA_LLAVE_PRIVADA') === -1) {
    error('El servicio de licencias no recibe la llave privada', 'No podría firmar licencias');
  } else {
    bien('el servicio de licencias recibe la llave privada');
  }

  // La app NO debe recibir la llave privada: solo el servidor de licencias la
  // necesita para firmar. Si la app la tuviera, una institucion podria emitirse
  // sus propias licencias.
  const bloqueApp = bloqueServicio(texto, 'app');
  const bloqueLic = bloqueServicio(texto, 'licencias');

  if (!bloqueApp) {
    error('No se pudo leer el bloque del servicio "app" en el Compose');
  } else if (bloqueApp.indexOf('LICENCIA_LLAVE_PRIVADA') !== -1) {
    error('La app recibe la llave privada', 'Solo el servidor de licencias debe tenerla');
  } else {
    bien('la app NO recibe la llave privada');
  }

  if (!bloqueLic) {
    error('No se pudo leer el bloque del servicio "licencias" en el Compose');
  }
}

/* ------------------------------------------------------------------ */
/* 5. Que el servidor arranque sin base (despliegue nuevo)              */
/* ------------------------------------------------------------------ */

function revisarArranque() {
  console.log('');
  console.log('  --- arranque en un despliegue nuevo ---');

  const texto = leer('server.js') || '';
  if (texto.indexOf('process.exit(1)') !== -1 && texto.indexOf('No se pudo conectar a SQL Server') !== -1) {
    error('El servidor muere si no hay base', 'En un despliegue nuevo el contenedor se reiniciaria en bucle');
  } else if (texto.indexOf('El servidor arranca igual') !== -1) {
    bien('arranca aunque la base no exista todavía, y lo avisa');
  } else {
    aviso('No se pudo confirmar que el servidor arranque sin base');
  }

  // Tiene que haber una forma de crear la base desde el contenedor.
  if (fs.existsSync(path.join(RAIZ, 'sql', '01-crear.js'))) bien('sql/01-crear.js está disponible para ejecutarlo dentro del contenedor');
  else error('Falta sql/01-crear.js');
}

/**
 * Los comandos "docker exec" de la documentacion apuntan a archivos que deben
 * existir DENTRO del contenedor.
 *
 * Esto se rompe solo: se documenta un comando, mas adelante se renombra el
 * script, y el comando del manual queda apuntando al vacio. Se descubre en el
 * peor momento, con el VPS ya desplegado y alguien siguiendo la guia.
 */
function revisarComandosDocumentados() {
  console.log('');
  console.log('  --- comandos documentados en el compose y el manual ---');

  const fuentes = [
    ['docker-compose.yml', leer('docker-compose.yml') || ''],
    ['DESPLIEGUE.md', leer('DESPLIEGUE.md') || ''],
    ['README.md', leer('README.md') || ''],
  ];

  // Rutas dentro de la imagen que el Dockerfile copia.
  const copiados = copiadosPorDockerfile() || [];

  const revisados = new Set();
  let problemasAqui = 0;

  for (const [nombre, texto] of fuentes) {
    // "node sql/algo.js", "node scripts/algo.js"
    const re = /node\s+((?:sql|scripts)\/[A-Za-z0-9_.-]+\.js)/g;
    let m;
    while ((m = re.exec(texto)) !== null) {
      const ruta = m[1];
      const clave = nombre + ':' + ruta;
      if (revisados.has(clave)) continue;
      revisados.add(clave);

      // 1. ¿Existe en el proyecto?
      if (!fs.existsSync(path.join(RAIZ, ruta))) {
        error(nombre + ' manda ejecutar "' + ruta + '", que no existe');
        problemasAqui++;
        continue;
      }

      // 2. ¿Entra en la imagen? Se comprueba contra la carpeta de primer nivel.
      const carpeta = ruta.split('/')[0];
      if (copiados.indexOf(carpeta) === -1) {
        error(nombre + ' manda ejecutar "' + ruta + '", pero el Dockerfile no copia "' + carpeta + '"');
        problemasAqui++;
      }
    }
  }

  if (!problemasAqui) {
    bien(revisados.size + ' comandos documentados apuntan a archivos que existirán en el contenedor');
  }
}

/* ------------------------------------------------------------------ */

/**
 * Comprueba que TODO lo que se puede ejecutar al menos COMPILA.
 *
 * POR QUE
 * -------
 * Dos scripts de despliegue se caian al ejecutarse porque llamaban a funciones que no
 * existian en su archivo (`aviso` en uno, `info` en el otro). Eso no lo detecta leer el
 * codigo ni pasar las pruebas: solo se ve al ejecutar el comando, y justo en el peor
 * momento, que es cuando ya estas desplegando.
 *
 * `node --check` no ejecuta nada: solo compila. No encuentra una funcion que falta, pero
 * si una sintaxis rota, un parentesis mal cerrado o un archivo a medio guardar. Es
 * barato y va en la revision previa al despliegue.
 *
 * Se revisan todos los archivos .js que mencionan los comandos de npm, mas los dos
 * servidores y los del sql/.
 */
function revisarSintaxis() {
  console.log('');
  console.log('  --- sintaxis de todo lo que se puede ejecutar ---');

  const archivos = new Set();

  /* Los que mencionan los comandos de npm. */
  const comandos = require(path.join(RAIZ, 'package.json')).scripts || {};
  for (const texto of Object.values(comandos)) {
    const re = /((?:scripts|sql|src)\/[A-Za-z0-9_./-]+\.js)/g;
    let m;
    while ((m = re.exec(texto)) !== null) archivos.add(m[1]);
  }

  /* Y los puntos de entrada. */
  for (const f of ['server.js', 'server-licencias.js']) {
    if (fs.existsSync(path.join(RAIZ, f))) archivos.add(f);
  }

  let malos = 0;
  for (const rel of [...archivos].sort()) {
    const ruta = path.join(RAIZ, rel);
    if (!fs.existsSync(ruta)) continue;

    const r = spawnSync(process.execPath, ['--check', ruta], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      const motivo = ((r.stderr || '').split('\n').find((l) => /Error/.test(l)) || '').trim();
      error(rel + ' no compila: ' + motivo.slice(0, 90));
      malos++;
    }
  }

  if (!malos) {
    bien(archivos.size + ' archivos ejecutables compilan');
  }

  return archivos;
}

/**
 * Carga los modulos del sistema para comprobar que no se caen al cargarse.
 *
 * `node --check` solo mira la sintaxis. Los dos fallos reales que hubo —`aviso` e `info`
 * sin definir— eran funciones que no existian, y eso la sintaxis no lo ve: se descubre
 * al ejecutar.
 *
 * Cargarlos NO ejecuta nada peligroso: el sistema usa `require.main === module` para
 * distinguir "me estan importando" de "me estan ejecutando", asi que un modulo que se
 * carga solo define sus funciones. Lo que si se descubre aqui es un `require` roto, un
 * error de nivel superior o una constante mal definida.
 */
function revisarCarga() {
  console.log('');
  console.log('  --- que los módulos se carguen sin caerse ---');

  const srcdir = path.join(RAIZ, 'src');
  const modulos = [];

  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js')) modulos.push(p);
    }
  };
  if (fs.existsSync(srcdir)) recorrer(srcdir);

  let malos = 0;
  for (const abs of modulos) {
    const rel = path.relative(RAIZ, abs).replace(/\\/g, '/');

    /* Se carga en un proceso aparte para que un modulo no contamine a los demas. */
    const codigo = 'require(' + JSON.stringify(abs) + ');';
    const r = spawnSync(process.execPath, ['-e', codigo], {
      encoding: 'utf8',
      cwd: RAIZ,
      timeout: 30000,
    });

    if (r.status !== 0) {
      const salida = (r.stderr || '') + (r.stdout || '');
      const motivo = (salida.split('\n').find((l) => /Error/.test(l)) || '').trim();
      error(rel + ' se cae al cargarse: ' + motivo.slice(0, 90));
      malos++;
    }
  }

  if (!malos) {
    bien(modulos.length + ' módulos del sistema se cargan sin errores');
  }
}

/* ------------------------------------------------------------------ */

function principal() {
  console.log('');
  console.log('  VisitaFlow - revision del despliegue');
  console.log('  ' + '='.repeat(62));

  revisarSintaxis();
  revisarCarga();
  revisarDockerfile();
  revisarDockerignore();
  revisarRequires();
  revisarCompose();
  revisarComandosDocumentados();
  revisarArranque();

  console.log('');
  console.log('  ' + '='.repeat(62));
  console.log('  ' + (problemas ? problemas + ' problema(s)' : 'Sin problemas') + (avisos ? ', ' + avisos + ' aviso(s)' : ''));
  console.log('');

  process.exit(problemas ? 1 : 0);
}

principal();
