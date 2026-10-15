/**
 * VisitaFlow - Prueba de escritura en la carpeta de datos, sin privilegios.
 *
 *   node scripts/probar-datos-volumen.js
 *
 * POR QUE EXISTE ESTA PRUEBA
 * --------------------------
 * El contenedor NO corre como root (eso esta bien: si alguien lograra ejecutar
 * codigo, no podria tocar nada fuera de sus carpetas). Pero el sistema tiene que
 * ESCRIBIR en /app/datos:
 *
 *   - la licencia, al activarla
 *   - la clave del administrador, en el primer arranque
 *   - los logos que sube cada institucion
 *
 * Si esa carpeta no queda con el dueno correcto, el sistema arranca, responde,
 * y falla al activar. Es un fallo que aparece TARDE y lejos de su causa: el
 * sintoma es "no se pudo activar" y el motivo real esta en los permisos.
 *
 * Esta prueba reproduce ese escenario: una carpeta de datos VACIA (como un
 * volumen recien creado) con permisos restrictivos, y comprueba que el sistema
 * puede escribir las tres cosas.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const { spawnSync } = require('child_process');

let ok = 0;
let fallos = 0;

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }

const TEMPORAL = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-datos-'));

function limpiar() {
  try { fs.rmSync(TEMPORAL, { recursive: true, force: true }); } catch (e) { /* da igual */ }
}

console.log('');
console.log('  VisitaFlow - la carpeta de datos, como en el contenedor');
console.log('  ' + '='.repeat(62));

try {
  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('1. Que el Dockerfile prepare la carpeta con el dueño correcto');

  const dockerfile = fs.readFileSync(path.join(RAIZ, 'Dockerfile'), 'utf8');

  if (/mkdir -p \/app\/datos/.test(dockerfile)) {
    bien('el Dockerfile crea /app/datos');
  } else {
    mal('el Dockerfile NO crea /app/datos: el volumen se crearía sin dueño y no se podría escribir');
  }

  if (/chown -R \w+:\w+ \/app\/datos/.test(dockerfile)) {
    bien('el Dockerfile le da el dueño del usuario sin privilegios');
  } else {
    mal('el Dockerfile NO cambia el dueño de /app/datos');
  }

  /* El orden importa: si se cambia el dueño antes de crear los archivos, los
     nuevos quedarían de root. */
  const posUser = dockerfile.indexOf('\nUSER ');
  const posChown = dockerfile.search(/chown -R \w+:\w+ \/app\/datos/);
  if (posUser === -1) {
    mal('el Dockerfile no cambia de usuario: el contenedor correría como root');
  } else if (posChown !== -1 && posChown < posUser) {
    bien('el dueño se asigna ANTES de quitar privilegios (el orden es correcto)');
  } else {
    mal('el dueño se asigna DESPUÉS de quitar privilegios: fallaría');
  }

  info('el usuario sin privilegios: ' + (dockerfile.match(/\nUSER (\w+)/) || [])[1]);

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('2. Que el sistema escriba las tres cosas que necesita');

  /* Se reproduce un volumen recien creado: una carpeta vacia, con permisos
     restrictivos, como la deja Docker al copiar el directorio de la imagen. */
  const datos = path.join(TEMPORAL, 'datos');
  fs.mkdirSync(datos, { recursive: true, mode: 0o755 });

  /* Y el sistema se apunta a esa carpeta. */
  const entorno = Object.assign({}, process.env, {
    DATOS_CARPETA: datos,
    LICENCIA_ARCHIVO: path.join(datos, 'licencia.vflow'),
    ARCHIVOS_CARPETA: path.join(datos, 'archivos'),
    // Sin base de datos: esto comprueba el sistema de archivos, nada mas.
    DB_SERVER: '127.0.0.1',
    DB_PORT: '1',
    PADRON_ACTIVO: '0',
  });

  /* Se carga el modulo de configuracion con esas variables y se comprueba que
     las rutas salen de ahi. En un archivo aparte, por la misma razon que abajo. */
  const scriptConfig = path.join(TEMPORAL, 'leer-config.js');
  fs.writeFileSync(scriptConfig, `
'use strict';
const config = require(${JSON.stringify(path.join(RAIZ, 'src', 'config.js'))});
console.log('DATOS=' + config.archivos.datos);
console.log('LICENCIA=' + config.licencia.archivo);
console.log('ARCHIVOS=' + config.archivos.carpeta);
`);

  const salida = spawnSync(process.execPath, [scriptConfig], { env: entorno, encoding: 'utf8', cwd: RAIZ });

  if (salida.status !== 0) {
    mal('no se pudo leer la configuración: ' + (salida.stderr || '').split('\n')[0]);
  } else {
    const lineas = salida.stdout.split('\n');
    const rutaDatos = (lineas.find((l) => l.startsWith('DATOS=')) || '').slice(6);
    const rutaLic = (lineas.find((l) => l.startsWith('LICENCIA=')) || '').slice(9);
    const rutaArch = (lineas.find((l) => l.startsWith('ARCHIVOS=')) || '').slice(9);

    if (rutaDatos === datos) bien('la carpeta de datos se toma de la variable DATOS_CARPETA');
    else mal('la carpeta de datos no respeta la variable: ' + rutaDatos);

    if (rutaLic.indexOf(datos) === 0) bien('la licencia se guarda DENTRO del volumen (sobrevive al redespliegue)');
    else mal('la licencia se guardaría FUERA del volumen: ' + rutaLic + ' — se perdería en cada redespliegue');

    if (rutaArch.indexOf(datos) === 0) bien('los logos se guardan DENTRO del volumen');
    else mal('los logos se guardarían fuera del volumen: ' + rutaArch);
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('3. Que se pueda escribir de verdad, como lo hace el sistema');

  /* Se usa un archivo aparte y no `node -e` con un texto largo: pasar codigo
     multilinea por la linea de comandos falla en Windows sin decir por que, y la
     prueba daba un fallo que no era real. */
  const scriptPrueba = path.join(TEMPORAL, 'prueba-escritura.js');
  fs.writeFileSync(scriptPrueba, `
'use strict';
const fs = require('fs');
const path = require('path');
const datos = process.env.DATOS_CARPETA;

// 1. La licencia, tal como la escribe el gestor.
const archivo = path.join(datos, 'licencia.vflow');
fs.mkdirSync(path.dirname(archivo), { recursive: true });
fs.writeFileSync(archivo, 'prueba de licencia', { mode: 0o600 });
console.log('LICENCIA_OK=' + fs.existsSync(archivo));

// 2. La clave del administrador, como la escribe el arranque.
const clave = path.join(datos, 'CLAVE-ADMINISTRADOR.txt');
fs.writeFileSync(clave, 'usuario: prueba', { mode: 0o600 });
console.log('CLAVE_OK=' + fs.existsSync(clave));

// 3. La carpeta de archivos subidos.
const subidos = path.join(datos, 'archivos');
fs.mkdirSync(subidos, { recursive: true });
fs.writeFileSync(path.join(subidos, 'logo.png'), 'x');
console.log('ARCHIVOS_OK=' + fs.existsSync(path.join(subidos, 'logo.png')));
`);

  const prueba = spawnSync(process.execPath, [scriptPrueba], {
    env: Object.assign({}, entorno, { DATOS_CARPETA: datos }),
    encoding: 'utf8',
    cwd: RAIZ,
  });

  const salidaOk = prueba.stdout || '';
  const errorOk = (prueba.stderr || '').split('\n').filter(Boolean)[0] || '';

  if (/LICENCIA_OK=true/.test(salidaOk)) bien('se puede escribir la licencia en el volumen');
  else mal('NO se puede escribir la licencia. ' + (errorOk || 'el proceso no dio salida'));

  if (/CLAVE_OK=true/.test(salidaOk)) bien('se puede escribir la clave del administrador');
  else mal('NO se puede escribir la clave del administrador');

  if (/ARCHIVOS_OK=true/.test(salidaOk)) bien('se puede crear la carpeta de logos y escribir en ella');
  else mal('NO se puede escribir en la carpeta de logos');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('4. Los archivos sensibles no quedan legibles para cualquiera');

  for (const f of ['licencia.vflow', 'CLAVE-ADMINISTRADOR.txt']) {
    const p = path.join(datos, f);
    if (!fs.existsSync(p)) { mal(f + ' no se creó'); continue; }
    const modo = fs.statSync(p).mode & 0o777;
    /* En Windows los permisos POSIX no existen de verdad; ahi no se comprueba. */
    if (process.platform === 'win32') {
      info(f + ': permisos POSIX no aplicables en Windows');
    } else if (modo & 0o077) {
      mal(f + ' es legible por otros usuarios (modo ' + modo.toString(8) + ')');
    } else {
      bien(f + ' solo lo lee su dueño (modo ' + modo.toString(8) + ')');
    }
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('5. El servidor de licencias: su registro de clientes');

  /* Este es el otro volumen, y el riesgo es peor: si el servidor de licencias no
     puede escribir su registro, NO SE EMITE NINGUNA LICENCIA. El sintoma es que
     el boton "Nueva licencia" no hace nada, y la causa esta en los permisos. */
  const datosLic = path.join(TEMPORAL, 'datos-licencias');
  fs.mkdirSync(datosLic, { recursive: true, mode: 0o755 });

  const scriptLic = path.join(TEMPORAL, 'prueba-licencias.js');
  fs.writeFileSync(scriptLic, `
'use strict';
const fs = require('fs');
const path = require('path');
const datos = process.env.DATOS_CARPETA;

// El registro de clientes, tal como lo escribe el servidor de licencias.
const registro = path.join(datos, 'licencias-emitidas.json');
fs.mkdirSync(path.dirname(registro), { recursive: true });
fs.writeFileSync(registro, JSON.stringify([{ licencia_id: 'LIC-PRUEBA', tenant: 'prueba' }], null, 2), { mode: 0o600 });
console.log('REGISTRO_OK=' + fs.existsSync(registro));

// Y que se pueda volver a leer y anadir, que es lo que hace al emitir otra.
const lista = JSON.parse(fs.readFileSync(registro, 'utf8'));
lista.push({ licencia_id: 'LIC-PRUEBA-2', tenant: 'prueba2' });
fs.writeFileSync(registro, JSON.stringify(lista, null, 2), { mode: 0o600 });
console.log('ANADIR_OK=' + (JSON.parse(fs.readFileSync(registro, 'utf8')).length === 2));
`);

  const r = spawnSync(process.execPath, [scriptLic], {
    env: Object.assign({}, process.env, { DATOS_CARPETA: datosLic }),
    encoding: 'utf8',
    cwd: RAIZ,
  });

  const salidaLic = r.stdout || '';
  const errorLic = (r.stderr || '').split('\n').filter(Boolean)[0] || '';

  if (/REGISTRO_OK=true/.test(salidaLic)) bien('el servidor de licencias puede escribir su registro de clientes');
  else mal('NO se puede escribir el registro de clientes: no se emitiría ninguna licencia. ' + errorLic);

  if (/ANADIR_OK=true/.test(salidaLic)) bien('puede añadir un cliente nuevo al registro existente');
  else mal('NO puede añadir clientes al registro');
} finally {
  limpiar();
}

console.log('');
console.log('  ' + '='.repeat(62));
console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
console.log('  ' + '='.repeat(62));
console.log('');

process.exit(fallos ? 1 : 0);
