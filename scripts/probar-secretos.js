/**
 * VisitaFlow - El sistema se niega a arrancar con secretos publicos.
 *
 *   node scripts/probar-secretos.js
 *
 * QUE COMPRUEBA
 * -------------
 * Que un sistema desplegado con un secreto de sesion que esta escrito en el
 * repositorio NO arranque, en vez de arrancar avisando.
 *
 * POR QUE IMPORTA
 * ---------------
 * Se comprobo fabricando un token de administrador con el valor de reserva y
 * verificandolo contra el sistema: funciona. Cualquiera que lea el repositorio
 * puede entrar como administrador de cualquier instalacion que se haya desplegado
 * sin definir JWT_SECRET.
 *
 * Un aviso en un registro que nadie lee equivale a no avisar, y mientras tanto el
 * sistema queda abierto. Por eso en produccion se para.
 *
 * Y en desarrollo NO se para: en la maquina de casa no hay nada que proteger y
 * pararlo seria una molestia sin motivo.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }

/**
 * Arranca el servidor con un entorno controlado y devuelve que paso.
 *
 * Se ejecuta en una carpeta temporal SIN .env, porque si lo hubiera mandaria el
 * suyo y taparia lo que se quiere probar. El codigo se carga desde el proyecto.
 */
function intentarArrancar(variables) {
  const base = {};
  // Se parte de un entorno limpio: nada de JWT_SECRET ni ADMIN_TOKEN heredados.
  for (const k of Object.keys(process.env)) {
    if (/^(JWT_SECRET|ADMIN_TOKEN|NODE_ENV|PORT|DB_|PADRON_|LICENCIA_|URL_PUBLICA|DATOS_)/.test(k)) continue;
    base[k] = process.env[k];
  }

  const entorno = Object.assign(base, variables);

  /* Se lanza con un puerto que no exista para que no choque con el sistema que el
     usuario tiene en marcha, y con las bases apuntando a ningun sitio: lo que se
     prueba es la comprobacion de secretos, que ocurre ANTES de tocar la base.
     DOTENV_CONFIG_PATH apunta a un archivo que no existe para que el .env del
     proyecto no tape lo que se esta probando. */
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ,
    env: Object.assign(entorno, {
      PORT: '3999',
      DB_SERVER: '127.0.0.1',
      DB_PORT: '1',
      PADRON_ACTIVO: '0',
      DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'no-existe.env'),
    }),
    encoding: 'utf8',
    timeout: 25000,
  });

  const salida = (r.stdout || '') + (r.stderr || '');
  return {
    salida,
    rechazo: /NO SE PUEDE ARRANCAR/.test(salida),
    // Arrancar de verdad se nota en el cartel de bienvenida del servidor.
    arranco: /VisitaFlow en marcha/.test(salida),
    codigo: r.status,
  };
}

console.log('');
console.log('  VisitaFlow - secretos publicados en el repositorio');
console.log('  ' + '='.repeat(66));

/* ------------------------------------------------------------------ */
console.log('');
console.log('1. En producción, con un secreto escrito en el repositorio');

const reserva = intentarArrancar({
  NODE_ENV: 'production',
  JWT_SECRET: 'cambie-este-secreto-en-produccion',
  ADMIN_TOKEN: 'token-de-administracion-suficientemente-largo',
});
if (reserva.rechazo && !reserva.arranco) {
  bien('se niega a arrancar con el secreto de reserva del código');
} else {
  mal('ARRANCÓ con un secreto publicado. Cualquiera puede fabricar una sesión de administrador.');
}
if (/administrador/i.test(reserva.salida)) {
  bien('el mensaje explica qué puede pasar, no solo que falta un valor');
}

const dev = intentarArrancar({
  NODE_ENV: 'production',
  JWT_SECRET: 'visitaflow_local_2026_cambiar_en_el_vps',
  ADMIN_TOKEN: 'token-de-administracion-suficientemente-largo',
});
if (dev.rechazo && !dev.arranco) {
  bien('también se niega con el secreto que traía el .env de desarrollo');
} else {
  mal('ARRANCÓ con el secreto del .env de desarrollo');
}

const corto = intentarArrancar({
  NODE_ENV: 'production',
  JWT_SECRET: 'corto',
  ADMIN_TOKEN: 'token-de-administracion-suficientemente-largo',
});
if (corto.rechazo && !corto.arranco) {
  bien('se niega con un secreto demasiado corto (se puede adivinar)');
} else {
  mal('ARRANCÓ con un secreto de 5 caracteres');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('2. En producción, sin el token del servidor de licencias');

const sinToken = intentarArrancar({
  NODE_ENV: 'production',
  JWT_SECRET: 'un-secreto-largo-propio-y-que-nadie-mas-conoce-1234',
  ADMIN_TOKEN: '',
});
if (sinToken.rechazo && !sinToken.arranco) {
  bien('se niega a arrancar sin ADMIN_TOKEN (la administración quedaría abierta)');
} else {
  mal('ARRANCÓ sin ADMIN_TOKEN: la administración de licencias quedaría al alcance de cualquiera');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('3. En producción, con todo bien puesto');

const bueno = intentarArrancar({
  NODE_ENV: 'production',
  JWT_SECRET: 'un-secreto-largo-propio-y-que-nadie-mas-conoce-1234',
  ADMIN_TOKEN: 'token-de-administracion-suficientemente-largo',
});
if (bueno.rechazo) {
  mal('se negó a arrancar con una configuración CORRECTA: bloquearía un despliegue bueno');
  const linea = bueno.salida.split('\n').find((l) => /^  - /.test(l));
  if (linea) info(linea.trim());
} else {
  bien('con un secreto propio arranca (no bloquea un despliegue correcto)');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('4. En desarrollo, con el secreto de reserva');

const desarrollo = intentarArrancar({
  NODE_ENV: 'development',
  JWT_SECRET: 'cambie-este-secreto-en-produccion',
  ADMIN_TOKEN: '',
});
if (desarrollo.rechazo) {
  mal('en desarrollo TAMBIÉN se niega: sería una molestia sin motivo en la máquina de casa');
} else {
  bien('en desarrollo arranca igual (no molesta mientras se programa)');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('5. El validador de configuración ve lo mismo');

const revisar = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'revisar-configuracion.js')], {
  cwd: RAIZ,
  env: Object.assign({}, process.env, {
    NODE_ENV: 'production',
    JWT_SECRET: 'cambie-este-secreto-en-produccion',
    ADMIN_TOKEN: 'un-token-largo-de-administracion-123456',
  }),
  encoding: 'utf8',
  timeout: 30000,
});

const salidaRev = (revisar.stdout || '') + (revisar.stderr || '');
if (/JWT_SECRET/.test(salidaRev) && /GRAVE/.test(salidaRev)) {
  bien('npm run config:revisar lo marca como grave antes de desplegar');
} else {
  mal('el validador de configuración NO detecta el secreto de ejemplo');
}

console.log('');
console.log('  ' + '='.repeat(66));
console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
console.log('  ' + '='.repeat(66));
if (detalles.length) {
  console.log('');
  for (const d of detalles) console.log('    ' + d);
}
console.log('');

process.exitCode = fallos ? 1 : 0;
