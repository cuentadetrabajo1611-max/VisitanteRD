/**
 * VisitaFlow - Revision de la configuracion de produccion.
 *
 *   node scripts/revisar-configuracion.js
 *
 * QUE HACE
 * --------
 * Lee la configuracion con la que se va a arrancar el sistema y dice si sirve para
 * produccion o no. No comprueba el codigo: comprueba los VALORES.
 *
 * POR QUE EXISTE
 * --------------
 * Casi todos los despliegues que salen mal, salen mal por la configuracion, no por el
 * codigo: un secreto que se quedo en el valor de ejemplo, una direccion que apunta a
 * localhost, una contrasena que SQL Server va a rechazar. Son cosas que no dan error
 * al arrancar y que aparecen despues, cuando ya hay gente usandolo.
 *
 * Esto no sustituye a leer la documentacion: la adelanta. Cada problema viene con lo
 * que hay que hacer para arreglarlo.
 *
 * Se puede ejecutar aqui, antes de desplegar, y tambien dentro del contenedor:
 *
 *   docker exec -it visitaflow-app node scripts/revisar-configuracion.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');

/* Se lee el .env a mano en vez de con dotenv: si ya hay variables de entorno puestas
   (en el VPS las pone Dokploy), esas mandan, y dotenv no sobrescribe. Aqui interesa
   saber QUE valor va a usar el sistema de verdad. */
try {
  const rutaEnv = path.join(RAIZ, '.env');
  if (fs.existsSync(rutaEnv)) {
    for (const linea of fs.readFileSync(rutaEnv, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(linea);
      if (!m) continue;
      // Lo que ya venga del entorno tiene prioridad.
      if (process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (e) {
  /* sin .env se revisa lo que haya en el entorno */
}

const config = require(path.join(RAIZ, 'src', 'config.js'));

const C = {
  reset: '\u001b[0m',
  gris: '\u001b[90m',
  rojo: '\u001b[31m',
  verde: '\u001b[32m',
  ambar: '\u001b[33m',
  cian: '\u001b[36m',
  blanco: '\u001b[97m',
};

let graves = 0;
let avisos = 0;
let bienes = 0;

function bien(t) { bienes++; console.log('  ' + C.verde + '[ok]' + C.reset + '    ' + t); }
function aviso(t, arreglo) {
  avisos++;
  console.log('  ' + C.ambar + '[aviso]' + C.reset + ' ' + t);
  if (arreglo) console.log('          -> ' + arreglo);
}
function grave(t, arreglo) {
  graves++;
  console.log('  ' + C.rojo + '[GRAVE]' + C.reset + ' ' + t);
  if (arreglo) console.log('          -> ' + arreglo);
}
function titulo(t) {
  console.log('');
  console.log('  ' + C.cian + t + C.reset);
  console.log('  ' + C.gris + '-'.repeat(66) + C.reset);
}

/** Los valores de ejemplo que NUNCA deben llegar a produccion. */
const EJEMPLOS = [
  'cambie_esta_clave', 'cambie-este-secreto-en-produccion', 'cambiame',
  'tu-clave', 'password', 'secreto', 'changeme', 'admin123',
];

function esEjemplo(v) {
  if (!v) return false;
  const t = String(v).trim().toLowerCase();
  return EJEMPLOS.some((e) => t === e || t.indexOf(e) !== -1);
}

/* ================================================================== */

console.log('');
console.log('  ' + C.blanco + 'VisitaFlow - revisión de la configuración' + C.reset);
console.log('  ' + C.gris + '='.repeat(66) + C.reset);
console.log('  Entorno: ' + C.blanco + config.servidor.entorno + C.reset +
  '   (se espera "production" en el VPS)');

/* ------------------------------------------------------------------ */
titulo('1. Secretos');

if (!config.sesion.secreto || String(config.sesion.secreto).length < 32) {
  grave('JWT_SECRET falta o es demasiado corto',
    'Genere uno con: npm run desplegar:preparar');
} else if (esEjemplo(config.sesion.secreto)) {
  grave('JWT_SECRET sigue siendo el valor de ejemplo',
    'Cualquiera que lea el repositorio puede firmar sesiones válidas. Genere otro.');
} else {
  bien('JWT_SECRET tiene ' + String(config.sesion.secreto).length + ' caracteres y no es de ejemplo');
}

/* ------------------------------------------------------------------ */
titulo('2. La base de datos del sistema');

if (esEjemplo(config.bd.sistema.password)) {
  grave('La contraseña de SQL Server sigue siendo el valor de ejemplo',
    'Ponga una de verdad en CLAVE_SQL, no la del .env.example.');
} else if (!config.bd.sistema.password) {
  grave('No hay contraseña de SQL Server configurada',
    'Defina CLAVE_SQL en las variables de entorno.');
} else {
  const p = String(config.bd.sistema.password);
  /* SQL Server rechaza las contraseñas que no cumplan su politica y el contenedor
     se muere en bucle sin decir cual es el motivo. Comprobarlo aqui ahorra eso. */
  const fallos = [];
  if (p.length < 8) fallos.push('menos de 8 caracteres');
  if (!/[A-Z]/.test(p)) fallos.push('sin mayúscula');
  if (!/[a-z]/.test(p)) fallos.push('sin minúscula');
  if (!/[0-9]/.test(p)) fallos.push('sin número');
  if (!/[^A-Za-z0-9]/.test(p)) fallos.push('sin símbolo');

  if (fallos.length) {
    /* En el VPS esto es grave: el contenedor de SQL Server se muere en bucle sin
       decir por qué. En esta máquina la base ya existe con esa clave y funciona,
       así que se avisa sin alarmar. */
    const texto = 'La contraseña de SQL Server no cumple su política: ' + fallos.join(', ');
    const arreglo = 'SQL Server arrancará y se morirá en bucle. Use mayúscula, minúscula, número y símbolo.';

    if (config.servidor.entorno === 'production') {
      grave(texto, arreglo);
    } else {
      aviso(texto + ' (aquí no importa: la base ya existe)', 'Para el VPS sí. ' + arreglo);
    }
  } else {
    bien('la contraseña de SQL Server cumple la política de complejidad');
  }

  if (/['"]/.test(p)) {
    grave('La contraseña de SQL Server lleva comillas',
      'Rompe el archivo .env y la línea de comandos. Quítelas.');
  }
}

console.log('          servidor: ' + config.bd.sistema.server + ':' + config.bd.sistema.port);
console.log('          base    : ' + config.bd.sistema.database);

if (config.servidor.entorno === 'production' && /^(localhost|127\.0\.0\.1)$/.test(config.bd.sistema.server)) {
  aviso('la base apunta a ' + config.bd.sistema.server + ' estando en producción',
    'Dentro del contenedor debería ser el nombre del servicio (bd-sistema).');
}

/* ------------------------------------------------------------------ */
titulo('3. El servidor de licencias');

if (!config.licencia.servidor) {
  aviso('no hay servidor de licencias configurado',
    'El sistema funcionará, pero para activar habrá que pegar el archivo .vflow a mano. ' +
    'Defina LICENCIA_SERVIDOR_URL.');
} else {
  bien('servidor de licencias: ' + config.licencia.servidor);

  /* Este es el error mas caro del despliegue: apuntar al nombre interno del
     contenedor. Funciona en ESTE servidor, pero las instalaciones de los clientes
     estan en SUS redes y no llegan ahi. Se descubre cuando un cliente intenta
     activarse y no puede. */
  if (/licencias:4100|localhost|127\.0\.0\.1/.test(config.licencia.servidor)) {
    aviso('la dirección del servidor de licencias es interna (' + config.licencia.servidor + ')',
      'Sus CLIENTES no podrán activarse con ella: están en sus propias redes. ' +
      'Ponga la dirección pública con HTTPS en LICENCIA_SERVIDOR_URL.');
  }
}

if (!config.licencia.publicaArchivo) {
  grave('no hay llave pública de licenciamiento',
    'El sistema no podrá verificar ninguna licencia. Defina LICENCIA_LLAVE_PUBLICA_B64.');
} else {
  try {
    const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));
    bien('llave pública cargada (key_id ' + lic.keyId() + ')');
  } catch (e) {
    grave('la llave pública no se puede usar: ' + e.message,
      'Compruebe que LICENCIA_LLAVE_PUBLICA_B64 esté completa, sin cortes ni espacios.');
  }
}

/* ------------------------------------------------------------------ */
titulo('4. Direcciones y proxy');

console.log('          URL pública: ' + (config.servidor.urlPublica || '(sin definir)'));

if (config.servidor.entorno === 'production') {
  if (!config.servidor.urlPublica) {
    aviso('no hay URL_PUBLICA definida',
      'Los enlaces que se manden por correo (recuperar contraseña) apuntarán a localhost.');
  } else if (/localhost|127\.0\.0\.1/.test(config.servidor.urlPublica)) {
    aviso('URL_PUBLICA apunta a localhost (' + config.servidor.urlPublica + ')',
      'Los enlaces de recuperación de contraseña no servirán desde fuera.');
  } else if (!/^https:/.test(config.servidor.urlPublica)) {
    aviso('URL_PUBLICA no usa HTTPS (' + config.servidor.urlPublica + ')',
      'En producción conviene HTTPS: las contraseñas viajan en cada entrada.');
  } else {
    bien('URL_PUBLICA con HTTPS: ' + config.servidor.urlPublica);
  }
}

if (config.servidor.detrasDeProxy) {
  bien('configurado detrás de proxy (la IP real se lee de X-Forwarded-For)');
} else if (config.servidor.entorno === 'production') {
  aviso('no está marcado como detrás de proxy',
    'Detrás de Traefik (Dokploy), todas las visitas parecerán venir de la misma IP ' +
    'y el límite de intentos de acceso bloquea a todos a la vez. Ponga DETRAS_DE_PROXY=1.');
}

if (config.servidor.entorno !== 'production') {
  aviso('NODE_ENV es "' + config.servidor.entorno + '" y no "production"',
    'En producción se activan el modo estricto de sesiones y los avisos de seguridad.');
}

/* ------------------------------------------------------------------ */
titulo('5. La base de cédulas');

if (!config.bd.padronActivo) {
  aviso('la base de cédulas está desactivada',
    'El sistema funcionará, pero el recepcionista tendrá que escribir los nombres a mano. ' +
    'Active PADRON_ACTIVO=1 cuando la instale.');
} else {
  bien('base de cédulas activa');
  console.log('          servidor: ' + config.bd.padron.server + ':' + config.bd.padron.port);
  console.log('          base    : ' + config.bd.padron.database);
  console.log('          tabla   : ' + config.bd.tablaPadron);

  if (config.servidor.entorno === 'production' && /^(localhost|127\.0\.0\.1)$/.test(config.bd.padron.server)) {
    aviso('la base de cédulas apunta a ' + config.bd.padron.server,
      'Dentro del contenedor debería ser bd-sistema.');
  }

  if (esEjemplo(config.bd.padron.password)) {
    grave('la contraseña de la base de cédulas es el valor de ejemplo',
      'Suele ser la misma que CLAVE_SQL. Defínala.');
  }

  /* La vista es lo que separa 10 milisegundos de 2,4 segundos al buscar una cedula.
     Si falta, el sistema funciona pero se arrastra en cada busqueda. */
  if (config.bd.tablaPadron.indexOf('CIUDADANOS') === -1) {
    aviso('la tabla de cédulas es "' + config.bd.tablaPadron + '" y no dbo.CIUDADANOS',
      'dbo.CIUDADANOS es la vista con la intercalación corregida. Sin ella, ' +
      'buscar una cédula tarda 2,4 segundos en vez de 10 milisegundos.');
  } else {
    bien('usa la vista dbo.CIUDADANOS (búsquedas rápidas)');
  }
}

/* ------------------------------------------------------------------ */
titulo('6. Los archivos y carpetas');

const datos = config.archivos.datos;
console.log('          datos   : ' + datos);
console.log('          licencia: ' + config.licencia.archivo);
console.log('          logos   : ' + config.archivos.carpeta);

/* Si la licencia o la clave del administrador se guardaran FUERA del volumen, cada
   redespliegue se las llevaria por delante y habria que activar el sistema otra vez. */
if (config.servidor.entorno === 'production' && datos.indexOf('/app/datos') === -1 && !process.env.DATOS_CARPETA) {
  aviso('la carpeta de datos no es /app/datos',
    'En el contenedor tiene que ser la del volumen (DATOS_CARPETA=/app/datos), ' +
    'o la licencia se perderá en cada redespliegue.');
} else {
  bien('la carpeta de datos es la del volumen (' + datos + ')');
}

/* ------------------------------------------------------------------ */
titulo('7. El administrador');

if (!process.env.ADMIN_CORREO) {
  bien('el correo del administrador se genera solo (admin@<institución>.local)');
} else {
  bien('correo del administrador: ' + process.env.ADMIN_CORREO);
}

/* ------------------------------------------------------------------ */
titulo('8. El correo (es opcional)');

if (!config.correo.activo) {
  bien('el correo está desactivado: los avisos se ven en la pantalla de recepción');
  console.log('          ' + C.gris + '(es una configuración válida: el aviso NUNCA depende del correo)' + C.reset);
} else {
  bien('el correo está activo: ' + config.correo.host + ':' + config.correo.puerto);
  if (!config.correo.usuario) {
    aviso('el correo está activo pero sin usuario', 'Muchos servidores SMTP lo exigen.');
  }
  if (!config.correo.clave) {
    aviso('el correo está activo pero sin contraseña', 'Compruebe SMTP_PASS.');
  }
}

/* ================================================================== */

console.log('');
console.log('  ' + C.gris + '='.repeat(66) + C.reset);

if (graves) {
  console.log('  ' + C.rojo + graves + ' problema(s) grave(s)' + C.reset +
    (avisos ? ', ' + avisos + ' aviso(s)' : ''));
  console.log('  ' + C.rojo + 'No despliegue así: se arreglan en un minuto y evitan un rato largo.' + C.reset);
  console.log('');
  process.exit(1);
}

if (avisos) {
  console.log('  ' + C.ambar + avisos + ' aviso(s), ' + bienes + ' correcto(s).' + C.reset);
  console.log('  Se puede desplegar, pero lea los avisos: cada uno explica qué pasa si no.');
  console.log('');
  process.exit(0);
}

console.log('  ' + C.verde + 'Configuración correcta (' + bienes + ' comprobaciones).' + C.reset);
console.log('');
process.exit(0);
