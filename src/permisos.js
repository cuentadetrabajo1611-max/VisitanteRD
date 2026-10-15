/**
 * VisitaFlow - Permisos del sistema.
 *
 * Los permisos se agrupan para poder pintarlos en pantalla, y cada rol trae su
 * juego por defecto. El rol admin conserva TODOS los permisos por diseno: si
 * alguien borra una asignacion por error, el sistema no queda sin acceso.
 */
'use strict';

const PERMISOS = [
  // Registro y recepcion
  { clave: 'registro.ver', grupo: 'Registro', descripcion: 'Ver la pantalla de registro y consultar cédulas' },
  { clave: 'registro.crear', grupo: 'Registro', descripcion: 'Registrar la entrada de un visitante' },
  { clave: 'recepcion.ver', grupo: 'Recepción', descripcion: 'Ver quién está dentro de las instalaciones' },
  { clave: 'recepcion.salida', grupo: 'Recepción', descripcion: 'Registrar la salida de un visitante' },
  { clave: 'recepcion.anular', grupo: 'Recepción', descripcion: 'Anular o denegar una visita' },
  { clave: 'recepcion.aprobar', grupo: 'Recepción', descripcion: 'Aprobar visitas que exigen autorización' },

  // Gafetes
  { clave: 'gafete.imprimir', grupo: 'Gafetes', descripcion: 'Emitir e imprimir el gafete' },
  { clave: 'gafete.devolver', grupo: 'Gafetes', descripcion: 'Registrar la devolución del gafete' },
  { clave: 'gafete.disenar', grupo: 'Gafetes', descripcion: 'Editar las plantillas de gafete' },

  // Pre-registro
  { clave: 'preregistro.ver', grupo: 'Pre-registro', descripcion: 'Ver las visitas anunciadas' },
  { clave: 'preregistro.crear', grupo: 'Pre-registro', descripcion: 'Anunciar una visita' },
  { clave: 'preregistro.editar', grupo: 'Pre-registro', descripcion: 'Editar o cancelar una visita anunciada' },

  // Vigilancia
  { clave: 'vigilancia.ver', grupo: 'Vigilancia', descripcion: 'Ver la lista de bloqueados y observados' },
  { clave: 'vigilancia.editar', grupo: 'Vigilancia', descripcion: 'Agregar, editar o levantar registros de vigilancia' },

  // Reportes
  { clave: 'reportes.ver', grupo: 'Reportes', descripcion: 'Ver el panel y el detalle de visitas' },
  { clave: 'reportes.exportar', grupo: 'Reportes', descripcion: 'Exportar los reportes a CSV' },

  // Configuracion
  { clave: 'config.ver', grupo: 'Configuración', descripcion: 'Ver catálogos y ajustes' },
  { clave: 'config.editar', grupo: 'Configuración', descripcion: 'Crear y editar catálogos y ajustes' },
  { clave: 'personalizacion.editar', grupo: 'Configuración', descripcion: 'Cambiar el logo y los colores institucionales' },
  { clave: 'usuarios.ver', grupo: 'Usuarios', descripcion: 'Ver los operadores' },
  { clave: 'usuarios.editar', grupo: 'Usuarios', descripcion: 'Crear, editar y desactivar operadores' },
  { clave: 'auditoria.ver', grupo: 'Usuarios', descripcion: 'Consultar la bitácora de auditoría' },

  // Sistema
  { clave: 'licencia.ver', grupo: 'Sistema', descripcion: 'Ver el estado de la licencia' },
  { clave: 'licencia.activar', grupo: 'Sistema', descripcion: 'Activar o renovar la licencia' },
  { clave: 'sistema.respaldo', grupo: 'Sistema', descripcion: 'Descargar respaldos de los datos' },
];

/** Rol por defecto de cada permiso. */
const ROLES = {
  admin: PERMISOS.map((p) => p.clave),

  supervisor: [
    'registro.ver', 'registro.crear',
    'recepcion.ver', 'recepcion.salida', 'recepcion.anular', 'recepcion.aprobar',
    'gafete.imprimir', 'gafete.devolver', 'gafete.disenar',
    'preregistro.ver', 'preregistro.crear', 'preregistro.editar',
    'vigilancia.ver', 'vigilancia.editar',
    'reportes.ver', 'reportes.exportar',
    'config.ver', 'personalizacion.editar',
    'usuarios.ver',
    'licencia.ver',
  ],

  operator: [
    'registro.ver', 'registro.crear',
    'recepcion.ver', 'recepcion.salida',
    'gafete.imprimir', 'gafete.devolver',
    'preregistro.ver', 'preregistro.crear',
    'vigilancia.ver',
    'licencia.ver',
  ],
};

const ROLES_VALIDOS = Object.keys(ROLES);

const GRUPOS = [...new Set(PERMISOS.map((p) => p.grupo))];

/** Nombre legible de cada rol. */
const NOMBRE_ROL = {
  admin: 'Administrador',
  supervisor: 'Supervisor',
  operator: 'Operador de recepción',
};

function existe(clave) {
  return PERMISOS.some((p) => p.clave === clave);
}

/** Permisos que le corresponden a un rol segun el catalogo por defecto. */
function porRol(rol) {
  if (rol === 'admin') return PERMISOS.map((p) => p.clave);
  return (ROLES[rol] || []).slice();
}

module.exports = { PERMISOS, ROLES, ROLES_VALIDOS, GRUPOS, NOMBRE_ROL, existe, porRol };
