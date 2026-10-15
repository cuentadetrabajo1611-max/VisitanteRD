/**
 * VisitaFlow - Dejar la institucion lista para usarse.
 *
 * Esto es lo que hace que una instalacion recien activada sirva de algo: su
 * institucion, sus permisos por rol, sus ajustes, sus catalogos de ejemplo y su
 * administrador con una contrasena que nadie puede adivinar.
 *
 * POR QUE ES UN MODULO APARTE
 * ---------------------------
 * Estaba escrito dentro de server.js, y eso tenia una consecuencia que se
 * descubrio desplegando: la activacion con el ID solo guardaba la licencia, y los
 * catalogos y el administrador se creaban en el ARRANQUE. O sea que habia que
 * reiniciar el contenedor despues de activar para poder entrar, aunque la pantalla
 * dijera que el sistema ya estaba listo.
 *
 * Ahora lo llaman los dos: el arranque, y la propia activacion. Asi activar deja el
 * sistema usable en el momento y no hay ningun paso que recordar.
 *
 * Todo lo de aqui es IDEMPOTENTE: se puede llamar en cada arranque sin duplicar
 * nada. Eso importa porque se llama en cada arranque.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const bd = require('./db');
const mantenimiento = require('./mantenimiento');

/** Clave inicial legible pero no adivinable. */
function generarClaveInicial() {
  const crypto = require('crypto');
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let clave = '';
  for (let i = 0; i < 14; i++) clave += alfabeto[bytes[i] % alfabeto.length];
  return clave + '!7';
}

/** El correo del administrador de una institucion. */
function correoDelAdmin(codigo) {
  return process.env.ADMIN_CORREO || 'admin@' + codigo + '.local';
}

/**
 * Deja lista la institucion de la licencia cargada.
 *
 * Devuelve que hizo, para que quien llame pueda contarlo:
 *   { ok, motivo, tenant, creados, admin: { correo, clave, archivo } | null }
 */
async function prepararInstitucion() {
  const gestor = require('./licencias/gestor');
  const estado = await gestor.cargar();

  if (!estado.contenido) {
    return { ok: false, motivo: 'sin_licencia', detalle: estado.motivo };
  }

  const codigo = estado.contenido.tenant;

  /* La institucion la crea el guardado de la licencia (MERGE en vf_tenants). Aqui
     solo se busca. Si la base no existe todavia, se avisa y se sigue: no es motivo
     para tumbar el servidor, y asi se puede crear con el contenedor arriba. */
  let t;
  try {
    t = await mantenimiento.porCodigo(codigo);
  } catch (e) {
    return {
      ok: false,
      motivo: 'sin_base',
      detalle: 'No se pudo leer la institución: la base del sistema no responde. ' +
        'Créela con: node sql/01-crear.js',
    };
  }

  if (!t) {
    return {
      ok: false,
      motivo: 'sin_institucion',
      detalle: 'La licencia es de "' + codigo + '" pero esa institución no existe en la base.',
    };
  }

  /* 1. Permisos, ajustes y catalogos de ejemplo. */
  const resumen = await mantenimiento.prepararTenant(t.id, { sembrarCatalogos: true });
  const creados = (resumen.permisos || 0) + (resumen.ajustes || 0) + (resumen.departamentos || 0) +
    (resumen.motivos || 0) + (resumen.categorias || 0) + (resumen.sedes || 0) + (resumen.plantilla || 0);

  /* 2. El administrador, si no hay ninguno.
   *
   * Un administrador con clave por defecto es un agujero. Se genera una al azar y
   * se deja en un archivo, para que haya que ir a buscarla. */
  let admin = null;

  const admins = await bd.consultar(
    "SELECT COUNT(*) AS n FROM vf_usuarios WHERE tenant_id = @tenant_id AND rol = 'admin' AND activo = 1",
    { tenant_id: t.id }
  );

  if (!admins.recordset[0].n) {
    const clave = generarClaveInicial();
    const correo = correoDelAdmin(t.codigo);

    await mantenimiento.crearAdmin(t.id, { correo, clave, nombre: 'Administrador' });

    /* Las credenciales van DENTRO de la carpeta de datos, que en el VPS es un
       volumen. Si se escribieran en la raiz del proyecto, un redespliegue se las
       llevaria y habria que restablecer la contrasena a mano. */
    const ruta = path.join(config.archivos.datos, 'CLAVE-ADMINISTRADOR.txt');
    try {
      fs.mkdirSync(config.archivos.datos, { recursive: true });
      fs.writeFileSync(
        ruta,
        'VisitaFlow - credenciales iniciales de la institución "' + t.codigo + '"\n' +
          '=========================================================\n\n' +
          '  Dirección  : ' + (config.servidor.urlPublica || 'http://localhost:' + config.servidor.puerto) + '\n' +
          '  Institución: ' + t.codigo + '\n' +
          '  Usuario    : ' + correo + '\n' +
          '  Contraseña : ' + clave + '\n\n' +
          'CAMBie esta contraseña al entrar (Usuarios → restablecer) y BORRE este archivo.\n',
        { mode: 0o600 }
      );
      admin = { correo, clave, archivo: ruta, escrito: true };
    } catch (e) {
      /* Si no se puede escribir, la clave se devuelve para mostrarla una sola vez.
         Es mejor que dejarla en un archivo que no existe. */
      admin = { correo, clave, archivo: null, escrito: false, error: e.message };
    }
  }

  return { ok: true, tenant: { id: t.id, codigo: t.codigo, nombre: t.nombre }, creados, admin };
}

/** Anuncia por consola lo que se acaba de preparar. */
function anunciar(resultado) {
  if (!resultado.ok) {
    if (resultado.motivo === 'sin_licencia') {
      console.warn('[visitaflow] Arrancando sin licencia válida: ' + resultado.detalle);
      console.warn('[visitaflow] El sistema queda en modo de solo lectura hasta que active una licencia.');
    } else if (resultado.motivo === 'sin_base') {
      console.error('[visitaflow] ' + resultado.detalle);
    } else {
      console.warn('[visitaflow] ' + resultado.detalle);
    }
    return;
  }

  if (resultado.creados > 0) {
    console.log('[visitaflow] Institución "' + resultado.tenant.codigo + '" preparada (' +
      resultado.creados + ' registros iniciales).');
  }

  if (resultado.admin) {
    const a = resultado.admin;
    if (a.escrito) {
      const relativa = path.relative(config.raiz, a.archivo) || a.archivo;
      console.log('');
      console.log('  ┌──────────────────────────────────────────────────────────────┐');
      console.log('  │  Se creó el administrador inicial de la institución.         │');
      console.log('  │  Usuario: ' + a.correo.padEnd(51).slice(0, 51) + '│');
      console.log('  │  ' + ('La contraseña quedó en: ' + relativa).padEnd(60).slice(0, 60) + '│');
      console.log('  │  Cámbiela y borre ese archivo.                              │');
      console.log('  └──────────────────────────────────────────────────────────────┘');
      console.log('');
    } else {
      console.warn('');
      console.warn('  Se creó el administrador inicial de la institución "' + resultado.tenant.codigo + '".');
      console.warn('  Usuario   : ' + a.correo);
      console.warn('  Contraseña: ' + a.clave);
      console.warn('  (no se pudo escribir el archivo de credenciales: ' + a.error + ')');
      console.warn('  ANOTE la contraseña ahora: no se vuelve a mostrar.');
      console.warn('');
    }
  }
}

module.exports = {
  prepararInstitucion,
  anunciar,
  generarClaveInicial,
  correoDelAdmin,
};
