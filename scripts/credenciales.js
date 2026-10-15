/**
 * VisitaFlow - Lectura del archivo de credenciales del administrador.
 *
 *   const { leerCredenciales, RUTA_CREDENCIALES } = require('./credenciales');
 *   const cred = leerCredenciales();   // { usuario, clave, tenant } o null
 *
 * El archivo lo escribe el servidor al crear el administrador inicial. Vive
 * dentro de la carpeta de datos (que en el VPS es un volumen, para que no se
 * pierda en un redespliegue), pero tambien se busca en la raiz del proyecto:
 * asi las instalaciones hechas antes del cambio siguen funcionando.
 *
 * Estaba repetido en siete scripts. Aqui esta una sola vez.
 */
'use strict';

const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });

const RAIZ = path.resolve(__dirname, '..');

/** Las dos ubicaciones posibles, en orden de preferencia. */
const RUTAS = [
  path.join(RAIZ, 'datos', 'CLAVE-ADMINISTRADOR.txt'),
  path.join(RAIZ, 'CLAVE-ADMINISTRADOR.txt'),
];

/** La ruta que existe ahora mismo, o la preferida si no hay ninguna. */
function rutaCredenciales() {
  for (const r of RUTAS) {
    if (fs.existsSync(r)) return r;
  }
  return RUTAS[0];
}

/**
 * Lee las credenciales. Devuelve null si no hay archivo o no se puede leer.
 * El campo "tenant" sale de la linea "Institución", que lleva acento.
 */
function leerCredenciales() {
  const ruta = rutaCredenciales();
  if (!fs.existsSync(ruta)) return null;

  const texto = fs.readFileSync(ruta, 'utf8');
  const usuario = (texto.match(/Usuario\s*:\s*(\S+)/) || [])[1];
  const clave = (texto.match(/Contraseña\s*:\s*(\S+)/) || [])[1];
  // "Institución" lleva acento, asi que se acepta cualquier terminacion.
  const tenant = (texto.match(/Instituci\S*\s*:\s*(\S+)/) || [])[1];

  if (!usuario || !clave) return null;
  return { usuario, clave, tenant, ruta };
}

/** El texto del archivo, o null. */
function textoCredenciales() {
  const ruta = rutaCredenciales();
  return fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : null;
}

module.exports = {
  RAIZ,
  RUTAS,
  rutaCredenciales,
  leerCredenciales,
  textoCredenciales,
};
