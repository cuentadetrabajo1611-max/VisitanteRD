/**
 * VisitaFlow - Restablece la contrasena del administrador de una institucion.
 *
 *   node scripts/restablecer-admin.js <institucion>
 *   node scripts/restablecer-admin.js junta-los-prados
 *
 * PARA QUE SIRVE
 * --------------
 * Si se pierde la contrasena del administrador y no hay otro usuario con
 * permiso para restablecerla, no queda forma de entrar al sistema. Esto lo
 * resuelve desde el servidor, que es donde esta la base de datos.
 *
 * Que hace:
 *   1. Busca la institucion por su codigo.
 *   2. Le pone al administrador una contrasena nueva, generada al azar.
 *   3. La escribe en CLAVE-ADMINISTRADOR.txt, igual que el primer arranque.
 *
 * No toca ningun dato: solo la contrasena. Y no sirve de nada sin acceso al
 * servidor, que es justo lo que lo hace seguro.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));
const auth = require(path.join(RAIZ, 'src', 'auth.js'));
const config = require(path.join(RAIZ, 'src', 'config.js'));

/* El archivo va DENTRO de la carpeta de datos, que en el VPS es un volumen.
   Escrito en la raiz del proyecto se perderia en cada redespliegue. */
const ARCHIVO = path.join(config.archivos.datos, 'CLAVE-ADMINISTRADOR.txt');

/* Mismo alfabeto que usa el servidor al crear el administrador: sin caracteres
   que se confundan al leerlos de una pantalla (nada de O/0 ni I/l/1). */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generarClave() {
  const bytes = crypto.randomBytes(14);
  let clave = '';
  for (let i = 0; i < 14; i++) clave += ALFABETO[bytes[i] % ALFABETO.length];
  return clave + '!7';
}

async function principal() {
  const codigo = (process.argv[2] || '').trim().toLowerCase();

  console.log('');
  console.log('  VisitaFlow - restablecer la contrasena del administrador');
  console.log('  ' + '-'.repeat(58));

  await bd.conectarSistema();

  // Sin argumento se muestran las instituciones disponibles.
  const todas = await bd.consultar(
    'SELECT t.id, t.codigo, t.nombre, ' +
    '(SELECT COUNT(*) FROM vf_usuarios u WHERE u.tenant_id = t.id AND u.rol = \'admin\' AND u.activo = 1) AS admins ' +
    'FROM vf_tenants t ORDER BY t.codigo'
  );

  if (!todas.recordset.length) {
    console.log('  La base no tiene ninguna institución todavía.');
    console.log('  Arranque el sistema una vez para que se cree a partir de la licencia.');
    console.log('');
    await bd.cerrar();
    process.exit(1);
  }

  if (!codigo) {
    console.log('  Indique la institución. Las que hay:');
    console.log('');
    for (const t of todas.recordset) {
      console.log('    ' + t.codigo.padEnd(28) + t.nombre + '  (' + t.admins + ' administrador(es))');
    }
    console.log('');
    console.log('  Por ejemplo:  node scripts/restablecer-admin.js ' + todas.recordset[0].codigo);
    console.log('');
    await bd.cerrar();
    process.exit(0);
  }

  const t = todas.recordset.find((x) => x.codigo === codigo);
  if (!t) {
    console.log('  No existe la institución "' + codigo + '".');
    console.log('  Las que hay: ' + todas.recordset.map((x) => x.codigo).join(', '));
    console.log('');
    await bd.cerrar();
    process.exit(1);
  }

  // Se busca al administrador activo; si no hay, se crea uno.
  const admins = await bd.consultar(
    "SELECT TOP 1 id, correo FROM vf_usuarios WHERE tenant_id = @t AND rol = 'admin' AND activo = 1 ORDER BY id",
    { t: t.id }
  );

  const clave = generarClave();
  const hash = await auth.cifrarClave(clave);
  let correo;

  if (admins.recordset.length) {
    correo = admins.recordset[0].correo;
    await bd.consultar(
      'UPDATE vf_usuarios SET clave_hash = @h, intentos = 0, bloqueado_hasta = NULL, ' +
      'reset_token = NULL, reset_expira = NULL, actualizado = SYSDATETIMEOFFSET() WHERE id = @id',
      { id: admins.recordset[0].id, h: hash }
    );
    console.log('  Contraseña restablecida al administrador existente.');
  } else {
    correo = 'admin@' + t.codigo + '.local';
    await bd.consultar(
      "INSERT INTO vf_usuarios (tenant_id, correo, clave_hash, nombre, rol, activo) " +
      "VALUES (@t, @c, @h, 'Administrador', 'admin', 1)",
      { t: t.id, c: correo, h: hash }
    );
    console.log('  La institución no tenía administrador: se creó uno.');
  }

  // Se deja la credencial en el mismo archivo que usa el primer arranque.
  const texto =
    'VisitaFlow - credenciales del administrador\n' +
    '=========================================================\n\n' +
    '  Institución: ' + t.codigo + '\n' +
    '  Usuario    : ' + correo + '\n' +
    '  Contraseña : ' + clave + '\n\n' +
    'Cámbiela al entrar (Usuarios → restablecer) y BORRE este archivo.\n';
  fs.writeFileSync(ARCHIVO, texto, { mode: 0o600 });

  console.log('');
  console.log('  Institución: ' + t.codigo + '  (' + t.nombre + ')');
  console.log('  Usuario    : ' + correo);
  console.log('  Contraseña : ' + clave);
  console.log('');
  console.log('  Quedó anotada en ' + path.relative(RAIZ, ARCHIVO));
  console.log('  Cámbiela al entrar y borre ese archivo.');
  console.log('');

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
