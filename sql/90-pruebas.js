/**
 * VisitaFlow - Pruebas de extremo a extremo.
 *
 *   node sql/90-pruebas.js
 *
 * Necesita el servidor en marcha (npm start). Recorre el sistema como lo haria
 * una persona en recepcion: entra, consulta una cedula real del padron,
 * registra la visita, saca el gafete, registra la salida y revisa el panel y
 * los reportes. Despues comprueba que el aislamiento entre instituciones y los
 * permisos funcionan de verdad, y que una licencia manipulada se rechaza.
 *
 * Las pruebas se limpian solas: al final borra lo que creo.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));
// El archivo de credenciales se lee con el modulo compartido.
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));

const BASE = process.env.PRUEBA_URL || 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const fallosDetalle = [];

function prueba(nombre, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      ok++;
      console.log('  ok   ' + nombre);
    })
    .catch((e) => {
      fallos++;
      fallosDetalle.push(nombre + ' -> ' + e.message);
      console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
    });
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

/** Peticion a la API. Devuelve { estado, datos } sin lanzar por codigos de error. */
async function pedir(metodo, ruta, cuerpo, token) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const respuesta = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  let datos = null;
  const texto = await respuesta.text();
  try {
    datos = JSON.parse(texto);
  } catch (e) {
    datos = { crudo: texto.slice(0, 300) };
  }
  return { estado: respuesta.status, datos };
}

/* Estado compartido entre pruebas */
const ctx = { token: null, cedula: null, visitaId: null, gafeteCodigo: null };

async function principal() {
  console.log('');
  console.log('  === VisitaFlow: pruebas de extremo a extremo ===');
  console.log('  Servidor: ' + BASE);
  console.log('');

  /* ---------------------------------------------------------------- */
  console.log('Salud y licencia');

  await prueba('el sistema responde y reporta el estado de las bases', async () => {
    const r = await pedir('GET', '/api/salud');
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.ok, 'la respuesta no es ok');
    esperar(r.datos.base_datos.disponible, 'la base del sistema no está disponible');
    esperar(['activa', 'por_vencer', 'gracia'].includes(r.datos.licencia.estado), 'licencia en estado ' + r.datos.licencia.estado);
  });

  await prueba('la base de cédulas está conectada', async () => {
    const r = await pedir('GET', '/api/salud');
    esperar(r.datos.cedulas.disponible, 'la base de cédulas no está disponible: ' + r.datos.cedulas.motivo);
  });

  await prueba('la lista de instituciones para el acceso no viene vacía', async () => {
    const r = await pedir('GET', '/api/acceso/instituciones');
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.instituciones.length > 0, 'no hay instituciones activas');
    /* La institución de la prueba es la del archivo de credenciales, NO la
       primera de la lista. Si se toma la primera y en la base quedó alguna
       institución de otra suite, la prueba intenta entrar en la equivocada y
       falla con 401 sin que nada esté roto. */
    const cred = leerCredenciales();
    esperar(cred && cred.tenant, 'el archivo de credenciales no dice la institución');
    const esta = r.datos.instituciones.some((x) => x.codigo === cred.tenant);
    esperar(esta, 'la institución "' + cred.tenant + '" no está entre las activas: ' +
      r.datos.instituciones.map((x) => x.codigo).join(', '));
    ctx.tenant = cred.tenant;
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Acceso');

  let credenciales = null;
  await prueba('se puede leer la credencial inicial del administrador', async () => {
    const c = leerCredenciales();
    esperar(c, 'no existe el archivo de credenciales (lo crea el servidor al arrancar)');
    esperar(c.usuario && c.clave, 'no se pudieron leer las credenciales del archivo');
    credenciales = { usuario: c.usuario, clave: c.clave };
  });

  await prueba('una contraseña equivocada es rechazada', async () => {
    const r = await pedir('POST', '/api/acceso/entrar', { tenant: ctx.tenant, correo: credenciales.usuario, clave: 'clave-que-no-es' });
    esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
  });

  await prueba('una institución inexistente es rechazada', async () => {
    const r = await pedir('POST', '/api/acceso/entrar', { tenant: 'no-existe-esta-junta', correo: credenciales.usuario, clave: credenciales.clave });
    esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
  });

  await prueba('el administrador entra y recibe su token y sus permisos', async () => {
    const r = await pedir('POST', '/api/acceso/entrar', { tenant: ctx.tenant, correo: credenciales.usuario, clave: credenciales.clave });
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.token, 'no vino el token');
    esperar(r.datos.permisos.length > 0, 'no vinieron los permisos');
    esperar(r.datos.marca && r.datos.marca.colores, 'no vino la marca de la institución');
    ctx.token = r.datos.token;
    ctx.usuario = r.datos.usuario;
  });

  await prueba('la sesión se puede consultar con el token', async () => {
    const r = await pedir('GET', '/api/acceso/sesion', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.usuario.correo === credenciales.usuario, 'el usuario no coincide');
  });

  await prueba('sin token no se entra a los datos', async () => {
    const r = await pedir('GET', '/api/visitas');
    esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
  });

  await prueba('un token inventado no sirve', async () => {
    const r = await pedir('GET', '/api/visitas', undefined, 'esto.no.es.un.token');
    esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Padrón de cédulas');

  await prueba('se encuentra una cédula real del padrón con sus datos', async () => {
    // Se toma una cédula cualquiera del padrón y se valida el dígito verificador.
    const r = await pedir('GET', '/api/registro/buscar?q=00100000017', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.resultados.length > 0, 'no se encontró la cédula 001-0000001-7');
    const c = r.datos.resultados[0];
    esperar(c.nombre_completo, 'no vino el nombre');
    esperar(c.cedula === '00100000017', 'la cédula no coincide: ' + c.cedula);
    esperar(c.fecha_nacimiento && /^\d{4}-\d{2}-\d{2}$/.test(c.fecha_nacimiento), 'la fecha de nacimiento no viene como YYYY-MM-DD: ' + c.fecha_nacimiento);
    esperar(c.en_padron === true, 'no quedó marcado como verificado en el padrón');
    ctx.cedula = c.cedula;
    ctx.ciudadano = c;
  });

  await prueba('la búsqueda por nombre devuelve resultados', async () => {
    const r = await pedir('GET', '/api/registro/buscar?q=ABREU', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.resultados.length > 0, 'no se encontró nadie apellidado ABREU');
    esperar(r.datos.resultados[0].nombre_completo, 'los resultados vienen sin nombre');
  });

  await prueba('una cédula con dígito verificador inválido se rechaza', async () => {
    const r = await pedir('GET', '/api/registro/consultar?cedula=00100000018', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.consulta.ok === false, 'debería rechazarla');
    esperar(/verificador/i.test(r.datos.consulta.motivo || ''), 'el motivo no menciona el dígito verificador: ' + r.datos.consulta.motivo);
  });

  await prueba('una cédula que no está en el padrón queda marcada como no verificada', async () => {
    const r = await pedir('GET', '/api/registro/consultar?cedula=40200000009', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.consulta.origen !== 'padron', 'no debería venir del padrón');
  });

  await prueba('la consulta trae los catálogos para el formulario', async () => {
    const r = await pedir('GET', '/api/registro/consultar?cedula=' + ctx.cedula, undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const c = r.datos.consulta;
    esperar(c.catalogos.departamentos.length > 0, 'no hay departamentos');
    esperar(c.catalogos.motivos.length > 0, 'no hay motivos');
    esperar(c.ajustes && typeof c.ajustes === 'object', 'no vinieron los ajustes');
    ctx.catalogos = c.catalogos;
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Registro de la entrada');

  await prueba('registrar sin motivo es rechazado', async () => {
    const r = await pedir('POST', '/api/registro', { cedula: ctx.cedula, visitado: 'Alguien' }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('registrar sin decir a quién visita es rechazado', async () => {
    const r = await pedir('POST', '/api/registro', { cedula: ctx.cedula, motivo_id: ctx.catalogos.motivos[0].id }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('se registra la entrada y queda "dentro"', async () => {
    const r = await pedir(
      'POST',
      '/api/registro',
      {
        cedula: ctx.cedula,
        motivo_id: ctx.catalogos.motivos[0].id,
        departamento_id: ctx.catalogos.departamentos[0].id,
        visitado: 'Encargado de prueba',
        telefono: '8095551234',
        empresa: 'Empresa de prueba',
        acompanantes: 1,
        vehiculo: 'Toyota Corolla',
        placa: 'A123456',
      },
      ctx.token
    );
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || JSON.stringify(r.datos).slice(0, 200)));
    esperar(r.datos.visita, 'no vino la visita');
    esperar(r.datos.visita.estado === 'dentro', 'la visita no quedó dentro');
    esperar(r.datos.visita.codigo, 'la visita no tiene código');
    esperar(r.datos.gafete, 'no se emitió el gafete');
    ctx.visitaId = r.datos.visita.id;
    ctx.gafeteCodigo = r.datos.visita.codigo;
  });

  await prueba('la visita guarda una copia de los datos validados', async () => {
    const r = await pedir('GET', '/api/visitas/' + ctx.visitaId, undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const v = r.datos.visita;
    esperar(v.nombre_completo === ctx.ciudadano.nombre_completo, 'el nombre no quedó congelado en la visita');
    esperar(v.cedula_formato && v.cedula_formato.includes('-'), 'la cédula no quedó formateada');
    esperar(v.edad > 0, 'no se calculó la edad');
    esperar(v.empresa === 'Empresa de prueba', 'no se guardó la empresa');
  });

  await prueba('no se puede registrar dos veces a la misma persona sin cerrar la primera', async () => {
    const r = await pedir(
      'POST',
      '/api/registro',
      { cedula: ctx.cedula, motivo_id: ctx.catalogos.motivos[0].id, visitado: 'Otra vez' },
      ctx.token
    );
    esperar(r.estado === 409, 'debería responder 409 y respondió ' + r.estado);
    esperar(r.datos.duplicado === true, 'no se marcó como duplicado');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Gafete');

  await prueba('el gafete trae la vista previa con los datos de la visita', async () => {
    const r = await pedir('GET', '/api/gafetes/visita/' + ctx.visitaId, undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const g = r.datos.gafete;
    esperar(g.nombre === ctx.ciudadano.nombre_completo, 'el nombre del gafete no coincide');
    esperar(g.codigo === ctx.gafeteCodigo, 'el código del gafete no coincide');
    esperar(g.institucion.nombre, 'el gafete no trae la institución');
    esperar(g.colores.primario, 'el gafete no trae los colores');
  });

  await prueba('el gafete incluye un código QR y se puede volver a leer', async () => {
    const r = await pedir('GET', '/api/gafetes/visita/' + ctx.visitaId, undefined, ctx.token);
    const g = r.datos.gafete;
    esperar(g.codigos.qr_svg, 'no se generó el QR');
    esperar(g.codigos.qr_svg.startsWith('<svg'), 'el QR no es un SVG');
    esperar(g.codigos.contenido_qr === ctx.gafeteCodigo, 'el QR no codifica el código de la visita');
    // Se comprueba que el QR generado se puede decodificar de vuelta.
    const { decodificar } = require('./92-pruebas-qr.js');
    const leido = decodificar(g.codigos.qr_svg);
    esperar(leido.texto === ctx.gafeteCodigo, 'el QR se leyó como "' + leido.texto + '" en vez de "' + ctx.gafeteCodigo + '"');
  });

  await prueba('el gafete institucional usa el color primario de la institución', async () => {
    const r = await pedir('GET', '/api/gafetes/visita/' + ctx.visitaId, undefined, ctx.token);
    const g = r.datos.gafete;
    esperar(g.colores.primario.startsWith('#'), 'el color primario no es un color');
    esperar(g.colores.texto_sobre_primario, 'no se calculó el color del texto sobre el fondo de marca');
  });

  await prueba('marcar el gafete como impreso sube el contador', async () => {
    const r = await pedir('POST', '/api/gafetes/visita/' + ctx.visitaId + '/impreso', {}, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const p = await pedir('GET', '/api/gafetes/pendientes', undefined, ctx.token);
    const g = p.datos.gafetes.find((x) => x.visita_id === ctx.visitaId);
    esperar(g, 'el gafete no aparece entre los pendientes');
    esperar(g.veces_impreso >= 1, 'el contador de impresiones no subió');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Panel y recepción');

  await prueba('el panel muestra al visitante dentro', async () => {
    const r = await pedir('GET', '/api/panel', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.panel.metricas.dentro >= 1, 'el contador de "dentro" no subió');
    esperar(r.datos.panel.dentro_detalle.some((v) => v.id === ctx.visitaId), 'la visita no aparece en la lista de dentro');
  });

  await prueba('la salida se registra con el código del gafete (lector de barras)', async () => {
    const r = await pedir('POST', '/api/recepcion/salida-por-codigo', { codigo: ctx.gafeteCodigo }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.visita.estado === 'salida', 'la visita no quedó como salida');
    esperar(r.datos.visita.salida, 'no se guardó la hora de salida');
    esperar(r.datos.visita.duracion, 'no se calculó la duración');
  });

  await prueba('registrar la salida dos veces se rechaza', async () => {
    const r = await pedir('POST', '/api/visitas/' + ctx.visitaId + '/salida', {}, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('el gafete queda marcado como devuelto', async () => {
    const r = await pedir('GET', '/api/gafetes/pendientes', undefined, ctx.token);
    const g = r.datos.gafetes.find((x) => x.visita_id === ctx.visitaId);
    esperar(!g, 'el gafete sigue apareciendo como pendiente después de la salida');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Lista de vigilancia');

  let vigId = null;
  await prueba('se agrega una cédula a la lista de vigilancia', async () => {
    const r = await pedir(
      'POST',
      '/api/vigilancia',
      { cedula: '00100000033', tipo: 'bloqueado', motivo: 'Prueba automática: no debe entrar', severidad: 'alta' },
      ctx.token
    );
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    vigId = r.datos.id;
    ctx.cedulaBloqueada = '00100000033';
  });

  await prueba('agregar la misma cédula dos veces se rechaza', async () => {
    const r = await pedir('POST', '/api/vigilancia', { cedula: '00100000033', tipo: 'bloqueado', motivo: 'Otra vez' }, ctx.token);
    esperar(r.estado === 409, 'debería responder 409 y respondió ' + r.estado);
  });

  await prueba('agregar sin motivo se rechaza', async () => {
    const r = await pedir('POST', '/api/vigilancia', { cedula: '00100000017', tipo: 'observado' }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('una cédula con dígito verificador inválido no se puede bloquear', async () => {
    const r = await pedir('POST', '/api/vigilancia', { cedula: '00100000019', tipo: 'bloqueado', motivo: 'Error de tecleo' }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('la consulta de una cédula bloqueada avisa', async () => {
    const r = await pedir('GET', '/api/vigilancia/cedula/00100000033', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.vigilancia && r.datos.vigilancia.bloqueado, 'no se marcó como bloqueada');
  });

  await prueba('una cédula bloqueada NO puede registrar entrada sin autorización', async () => {
    const r = await pedir(
      'POST',
      '/api/registro',
      { cedula: '00100000033', motivo_id: ctx.catalogos.motivos[0].id, visitado: 'Alguien' },
      ctx.token
    );
    esperar(r.estado === 400, 'debería rechazarse y respondió ' + r.estado);
    esperar(r.datos.requiere_autorizacion === true, 'no pidió autorización expresa');
  });

  let visitaBloqueada = null;
  await prueba('con autorización expresa y motivo sí entra, y queda registrado', async () => {
    const r = await pedir(
      'POST',
      '/api/registro',
      {
        cedula: '00100000033',
        motivo_id: ctx.catalogos.motivos[0].id,
        visitado: 'Alguien',
        autorizar_bloqueado: true,
        motivo_autorizacion: 'Autorizado por la presidenta de la junta',
      },
      ctx.token
    );
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    visitaBloqueada = r.datos.visita.id;
    esperar(/AUTORIZADO/i.test(r.datos.visita.observaciones || ''), 'no quedó constancia de la autorización en las observaciones');
  });

  await prueba('la bitácora de avisos registra la decisión', async () => {
    const r = await pedir('GET', '/api/vigilancia/avisos?cedula=00100000033', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.listado.filas.length > 0, 'no se registró ningún aviso');
    esperar(r.datos.listado.filas[0].decision === 'permitido', 'la decisión no quedó como permitido');
  });

  await prueba('levantar el registro no lo borra: queda el historial', async () => {
    const r = await pedir('DELETE', '/api/vigilancia/' + vigId, { motivo: 'Prueba terminada' }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const historial = await pedir('GET', '/api/vigilancia?historial=1', undefined, ctx.token);
    const fila = historial.datos.listado.filas.find((f) => f.id === vigId);
    esperar(fila, 'el registro desapareció del historial');
    esperar(fila.activo === false, 'el registro sigue activo');
    esperar(fila.levantado_motivo === 'Prueba terminada', 'no quedó el motivo del levantamiento');
  });

  if (visitaBloqueada) await pedir('POST', '/api/visitas/' + visitaBloqueada + '/salida', {}, ctx.token);

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Pre-registro');

  let preCodigo = null;
  await prueba('se anuncia una visita y devuelve un código para dictar', async () => {
    const r = await pedir(
      'POST',
      '/api/preregistros',
      { nombre_completo: 'Visitante Anunciado', cedula: '00100000017', empresa: 'Proveedora', visitado: 'Recursos Humanos' },
      ctx.token
    );
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.codigo, 'no vino el código');
    esperar(/^[A-Z]{2,3}-[A-Z2-9]{4}$/.test(r.datos.codigo), 'el código no tiene el formato esperado: ' + r.datos.codigo);
    preCodigo = r.datos.codigo;
    ctx.preId = r.datos.id;
  });

  await prueba('el pre-registro se encuentra por su código', async () => {
    const r = await pedir('GET', '/api/preregistros/codigo/' + preCodigo, undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.preregistro.codigo === preCodigo, 'no coincide el código');
  });

  await prueba('la consulta de la cédula ofrece el pre-registro pendiente', async () => {
    const r = await pedir('GET', '/api/registro/consultar?cedula=00100000017', undefined, ctx.token);
    esperar(r.datos.consulta.preregistro, 'no se ofreció el pre-registro');
    esperar(r.datos.consulta.preregistro.codigo === preCodigo, 'el código ofrecido no coincide');
  });

  await prueba('al hacer el check-in el pre-registro queda usado y enlazado', async () => {
    const r = await pedir(
      'POST',
      '/api/registro',
      {
        cedula: '00100000017',
        motivo_id: ctx.catalogos.motivos[0].id,
        visitado: 'Recursos Humanos',
        preregistro_id: ctx.preId,
      },
      ctx.token
    );
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    ctx.visitaPre = r.datos.visita.id;
    const p = await pedir('GET', '/api/preregistros/codigo/' + preCodigo, undefined, ctx.token);
    esperar(p.datos.preregistro.estado === 'usado', 'el pre-registro quedó en estado ' + p.datos.preregistro.estado);
    esperar(p.datos.preregistro.visita_id === ctx.visitaPre, 'no se enlazó con la visita');
  });

  await pedir('POST', '/api/visitas/' + ctx.visitaPre + '/salida', {}, ctx.token);

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Reportes');

  await prueba('el resumen de reportes trae métricas y series', async () => {
    const r = await pedir('GET', '/api/reportes/resumen', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const rep = r.datos.reporte;
    esperar(rep.metricas.visitas >= 2, 'no cuentan las visitas registradas: ' + rep.metricas.visitas);
    esperar(rep.series.por_dia.length > 0, 'no hay serie por día');
    esperar(rep.series.por_hora.length === 24, 'la serie por hora no tiene 24 puntos');
    esperar(rep.repartos.por_motivo.length > 0, 'no hay reparto por motivo');
  });

  await prueba('el detalle de visitas se puede filtrar y paginar', async () => {
    const r = await pedir('GET', '/api/reportes/visitas?texto=Prueba&tamano=5', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(typeof r.datos.listado.total === 'number', 'no vino el total');
    esperar(r.datos.listado.filas.length <= 5, 'la paginación no respetó el tamaño');
  });

  await prueba('la exportación a CSV sale con encabezados y con BOM', async () => {
    const respuesta = await fetch(BASE + '/api/reportes/visitas.csv', { headers: { Authorization: 'Bearer ' + ctx.token } });
    esperar(respuesta.status === 200, 'estado ' + respuesta.status);
    // Se leen los BYTES, no el texto: segun como se decodifique, el BOM puede
    // desaparecer del texto y parecer que falta cuando en el archivo esta.
    const bytes = Buffer.from(await respuesta.arrayBuffer());
    esperar(
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      'el CSV no empieza con el BOM UTF-8 (Excel no respetaría los acentos): ' +
        [...bytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')
    );
    const texto = bytes.toString('utf8');
    esperar(texto.includes('Código'), 'el CSV no trae el encabezado de código');
    esperar(texto.includes('Cédula'), 'el CSV no trae el encabezado de cédula');
    esperar(texto.split('\r\n').length > 1, 'el CSV no trae filas');
  });

  await prueba('el ranking de visitantes frecuentes responde', async () => {
    const r = await pedir('GET', '/api/reportes/visitantes', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(Array.isArray(r.datos.listado.filas), 'no vino la lista');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Configuración y personalización');

  await prueba('la configuración trae catálogos y ajustes', async () => {
    const r = await pedir('GET', '/api/config', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.departamentos.length > 0, 'no hay departamentos');
    esperar(r.datos.motivos.length > 0, 'no hay motivos');
    esperar(r.datos.ajustes.length > 0, 'no hay ajustes');
    esperar(r.datos.marca, 'no vino la marca');
  });

  let deptoId = null;
  await prueba('se crea un departamento', async () => {
    const r = await pedir('POST', '/api/config/departamentos', { nombre: 'ZZ-PRUEBA Departamento', encargado: 'Alguien' }, ctx.token);
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    deptoId = r.datos.id;
  });

  await prueba('se edita el departamento', async () => {
    const r = await pedir('PATCH', '/api/config/departamentos/' + deptoId, { encargado: 'Otra persona' }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
  });

  await prueba('crear un catálogo sin nombre se rechaza', async () => {
    const r = await pedir('POST', '/api/config/departamentos', { encargado: 'Sin nombre' }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('desactivar un catálogo es baja lógica, no borrado', async () => {
    const r = await pedir('DELETE', '/api/config/departamentos/' + deptoId, {}, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const c = await pedir('GET', '/api/config/departamentos', undefined, ctx.token);
    const d = c.datos.filas.find((x) => x.id === deptoId);
    esperar(d, 'el departamento desapareció');
    esperar(d.activo === false, 'el departamento sigue activo');
  });

  await prueba('se cambian los ajustes del sistema', async () => {
    const r = await pedir('PATCH', '/api/config/ajustes', { ajustes: { alerta_visita_larga: '120' } }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(String(r.datos.config.valores.alerta_visita_larga) === '120', 'el ajuste no se guardó: ' + r.datos.config.valores.alerta_visita_larga);
  });

  await prueba('se cambian los colores institucionales', async () => {
    const r = await pedir('PATCH', '/api/personalizacion', { color_primario: '#0f766e', color_secundario: '#f97316' }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.marca.colores.primario === '#0f766e', 'el color no se aplicó: ' + r.datos.marca.colores.primario);
  });

  await prueba('el contraste del texto sobre el color de marca se calcula', async () => {
    const r = await pedir('GET', '/api/marca', undefined, ctx.token);
    const c = r.datos.marca.colores;
    esperar(c.texto_sobre_primario === '#ffffff' || c.texto_sobre_primario === '#0f172a', 'no se resolvió el color del texto');
    esperar(c.contraste_primario > 1, 'no se calculó el contraste');
  });

  await prueba('un color inválido se rechaza en vez de romper la interfaz', async () => {
    const r = await pedir('PATCH', '/api/personalizacion', { color_primario: 'no-es-un-color' }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('se sube un logo y queda publicado', async () => {
    // PNG mínimo válido de 1x1.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = await pedir('POST', '/api/personalizacion/logo', { imagen: png }, ctx.token);
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.logo_url, 'no vino la dirección del logo');
    const descarga = await fetch(BASE + r.datos.logo_url);
    esperar(descarga.status === 200, 'el logo no se puede descargar: ' + descarga.status);
  });

  await prueba('un archivo que no es imagen se rechaza como logo', async () => {
    const r = await pedir('POST', '/api/personalizacion/logo', { imagen: Buffer.from('esto no es una imagen').toString('base64') }, ctx.token);
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Usuarios y permisos');

  // Las pruebas se limpian solas, pero por si una corrida anterior se corto a
  // medias, se borra el operador de prueba antes de empezar. Si no, la segunda
  // corrida falla diciendo que el correo ya existe.
  {
    const bd = require(path.join(RAIZ, 'src', 'db.js'));
    await bd.consultar("DELETE FROM vf_usuarios WHERE correo = 'operador@prueba.local'");
    await bd.cerrar();
  }

  await prueba('la lista de usuarios trae los roles y sus permisos', async () => {
    const r = await pedir('GET', '/api/usuarios', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.usuarios.length > 0, 'no hay usuarios');
    esperar(r.datos.roles.length === 3, 'no vinieron los tres roles');
    esperar(r.datos.permisos.length > 15, 'el catálogo de permisos parece incompleto');
    const admin = r.datos.roles.find((x) => x.rol === 'admin');
    esperar(admin.permisos.length === r.datos.permisos.length, 'el rol admin debería tener todos los permisos');
  });

  let operadorId = null;
  await prueba('se crea un operador con clave débil rechazada primero', async () => {
    const debil = await pedir('POST', '/api/usuarios', { correo: 'operador@prueba.local', nombre: 'Operador Prueba', rol: 'operator', clave: '123' }, ctx.token);
    esperar(debil.estado === 400, 'una clave débil debería rechazarse y respondió ' + debil.estado);

    const r = await pedir('POST', '/api/usuarios', { correo: 'operador@prueba.local', nombre: 'Operador Prueba', rol: 'operator', clave: 'Operador2026!' }, ctx.token);
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    operadorId = r.datos.id;
  });

  await prueba('el operador entra pero NO ve la configuración', async () => {
    const entrada = await pedir('POST', '/api/acceso/entrar', { tenant: ctx.tenant, correo: 'operador@prueba.local', clave: 'Operador2026!' });
    esperar(entrada.estado === 200, 'el operador no pudo entrar: ' + (entrada.datos.mensaje || ''));
    const tokenOperador = entrada.datos.token;

    // Puede registrar visitas
    const panel = await pedir('GET', '/api/panel', undefined, tokenOperador);
    esperar(panel.estado === 200, 'el operador debería ver el panel y respondió ' + panel.estado);

    // No puede entrar a configuración
    const cfg = await pedir('GET', '/api/config', undefined, tokenOperador);
    esperar(cfg.estado === 403, 'el operador no debería ver la configuración y respondió ' + cfg.estado);

    // No puede administrar usuarios
    const usr = await pedir('GET', '/api/usuarios', undefined, tokenOperador);
    esperar(usr.estado === 403, 'el operador no debería ver usuarios y respondió ' + usr.estado);

    // No puede agregar a la lista de vigilancia
    const vig = await pedir('POST', '/api/vigilancia', { cedula: '00100000017', tipo: 'observado', motivo: 'Prueba' }, tokenOperador);
    esperar(vig.estado === 403, 'el operador no debería poder editar vigilancia y respondió ' + vig.estado);
  });

  await prueba('un operador no puede desactivarse a sí mismo', async () => {
    const entrada = await pedir('POST', '/api/acceso/entrar', { tenant: ctx.tenant, correo: 'operador@prueba.local', clave: 'Operador2026!' });
    const r = await pedir('DELETE', '/api/usuarios/' + operadorId, {}, entrada.datos.token);
    esperar(r.estado === 403, 'debería responder 403 (no tiene permiso) y respondió ' + r.estado);
  });

  await prueba('el administrador cambia los permisos de un rol', async () => {
    const r = await pedir('PUT', '/api/usuarios/roles/operator', { permisos: ['registro.ver', 'registro.crear', 'recepcion.ver'] }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.permisos.length === 3, 'no se guardaron los tres permisos');
  });

  await prueba('el cambio de permisos surte efecto en el siguiente acceso', async () => {
    const entrada = await pedir('POST', '/api/acceso/entrar', { tenant: ctx.tenant, correo: 'operador@prueba.local', clave: 'Operador2026!' });
    esperar(entrada.datos.permisos.length === 3, 'el operador sigue con ' + entrada.datos.permisos.length + ' permisos');
    const salida = await pedir('POST', '/api/visitas/1/salida', {}, entrada.datos.token);
    esperar(salida.estado === 403, 'sin permiso de salida debería responder 403 y respondió ' + salida.estado);
  });

  await prueba('el rol administrador NO se puede dejar sin permisos', async () => {
    const r = await pedir('PUT', '/api/usuarios/roles/admin', { permisos: [] }, ctx.token);
    esperar(r.estado === 400, 'debería rechazarse y respondió ' + r.estado);
  });

  await prueba('se restablece la contraseña de un usuario', async () => {
    const r = await pedir('POST', '/api/usuarios/' + operadorId + '/clave', { clave: 'NuevaClave2026!' }, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const entrada = await pedir('POST', '/api/acceso/entrar', { tenant: ctx.tenant, correo: 'operador@prueba.local', clave: 'NuevaClave2026!' });
    esperar(entrada.estado === 200, 'no pudo entrar con la clave nueva');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Aislamiento entre instituciones');

  await prueba('el token de una institución no da acceso a los datos de otra', async () => {
    // Se crea una SEGUNDA institución con su propio usuario, y se comprueba que
    // ninguno de los dos tokens alcanza los datos del otro. El aislamiento no
    // depende de que el cliente mande bien el tenant: depende del token.
    const bd = require(path.join(RAIZ, 'src', 'db.js'));
    const auth = require(path.join(RAIZ, 'src', 'auth.js'));

    const codigoOtra = 'zz-prueba-aislamiento';
    await bd.consultar("DELETE FROM vf_rol_permisos WHERE tenant_id IN (SELECT id FROM vf_tenants WHERE codigo = @c)", { c: codigoOtra });
    await bd.consultar("DELETE FROM vf_usuarios WHERE tenant_id IN (SELECT id FROM vf_tenants WHERE codigo = @c)", { c: codigoOtra });
    await bd.consultar("DELETE FROM vf_tenants WHERE codigo = @c", { c: codigoOtra });

    const t = await bd.consultar(
      "INSERT INTO vf_tenants (codigo, nombre, estado) OUTPUT INSERTED.id VALUES (@c, 'ZZ Prueba Aislamiento', 'activo')",
      { c: codigoOtra }
    );
    const otraId = t.recordset[0].id;
    const hash = await auth.cifrarClave('Aislamiento2026!');
    await bd.consultar(
      "INSERT INTO vf_usuarios (tenant_id, correo, clave_hash, nombre, rol, activo) VALUES (@t, 'admin@otra.local', @h, 'Admin Otra', 'admin', 1)",
      { t: otraId, h: hash }
    );

    // La otra institución entra.
    const otra = await pedir('POST', '/api/acceso/entrar', { tenant: codigoOtra, correo: 'admin@otra.local', clave: 'Aislamiento2026!' });
    esperar(otra.estado === 200, 'la segunda institución no pudo entrar: ' + (otra.datos.mensaje || ''));
    esperar(otra.datos.usuario.tenant_id === otraId, 'la segunda institución no tiene su propio tenant_id');

    // Su panel está vacío: no ve las visitas de la primera.
    const panelOtra = await pedir('GET', '/api/panel', undefined, otra.datos.token);
    esperar(panelOtra.estado === 200, 'estado ' + panelOtra.estado);
    esperar(panelOtra.datos.panel.metricas.hoy === 0, 'la segunda institución ve ' + panelOtra.datos.panel.metricas.hoy + ' visitas que no son suyas');

    // Y su lista de visitas tampoco trae nada de la primera.
    const visitasOtra = await pedir('GET', '/api/visitas?texto=' + encodeURIComponent(ctx.ciudadano.nombre_completo), undefined, otra.datos.token);
    esperar(visitasOtra.datos.listado.total === 0, 'la segunda institución encontró visitas de la primera');

    // Al revés: la primera tampoco ve nada de la segunda.
    const visitasPrimera = await pedir('GET', '/api/visitas?texto=Admin%20Otra', undefined, ctx.token);
    esperar(visitasPrimera.datos.listado.total === 0, 'la primera institución ve datos de la segunda');

    // Y el intento de forzar la institución por la dirección no cambia nada.
    const forzado = await pedir('GET', '/api/panel?tenant=' + codigoOtra, undefined, ctx.token);
    esperar(forzado.estado === 200, 'estado ' + forzado.estado);
    const sesion = await pedir('GET', '/api/acceso/sesion', undefined, ctx.token);
    esperar(
      sesion.datos.usuario && sesion.datos.usuario.tenant_id === ctx.usuario.tenant_id,
      'la institución de la sesión cambió al pedir otra por la dirección (sesión dice ' +
        JSON.stringify(sesion.datos.usuario) +
        ', se esperaba tenant_id ' +
        ctx.usuario.tenant_id +
        ')'
    );

    // Limpieza de la segunda institución.
    await bd.consultar("DELETE FROM vf_rol_permisos WHERE tenant_id = @t", { t: otraId });
    await bd.consultar("DELETE FROM vf_usuarios WHERE tenant_id = @t", { t: otraId });
    await bd.consultar("DELETE FROM vf_tenants WHERE id = @t", { t: otraId });
    await bd.cerrar();
  });

  await prueba('la bitácora de auditoría registró las operaciones', async () => {
    const r = await pedir('GET', '/api/auditoria?tamano=50', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.listado.total > 0, 'la auditoría está vacía');
    const acciones = r.datos.listado.filas.map((f) => f.accion);
    esperar(acciones.includes('visita.registrar'), 'no se registró el alta de la visita en la auditoría');
    esperar(acciones.includes('acceso.entrar'), 'no se registró el acceso');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Licenciamiento con el sistema en marcha');

  await prueba('una licencia manipulada es rechazada aunque el sistema esté en marcha', async () => {
    const fs = require('fs');
    // La ruta se toma de la configuracion: la licencia vive dentro de la carpeta
    // de datos, que en el VPS es un volumen.
    const original = fs.readFileSync(config.licencia.archivo, 'utf8');
    const cuerpo = original.replace(lic.CABECERA, '').replace(lic.PIE, '').split('\n').map((l) => l.trim()).filter(Boolean).join('');
    const [carga, firma] = cuerpo.split('.');
    const contenido = JSON.parse(lic.deBase64Url(carga).toString('utf8'));
    contenido.hasta = new Date(Date.now() + 3650 * 86400000).toISOString();
    const nueva = lic.aBase64Url(Buffer.from(JSON.stringify(contenido), 'utf8'));
    const falsa = lic.CABECERA + '\n' + nueva + '.' + firma + '\n' + lic.PIE + '\n';

    const r = await pedir('POST', '/api/licencia/activar', { texto: falsa }, ctx.token);
    esperar(r.estado === 400, 'debería rechazarse y respondió ' + r.estado);
    esperar(/firma/i.test(r.datos.mensaje || ''), 'el motivo no menciona la firma: ' + r.datos.mensaje);

    // Y la licencia buena sigue funcionando.
    const salud = await pedir('GET', '/api/salud');
    esperar(['activa', 'por_vencer'].includes(salud.datos.licencia.estado), 'la licencia buena se perdió: ' + salud.datos.licencia.estado);
  });

  await prueba('la pantalla de licencia muestra los días restantes y el equipo', async () => {
    const r = await pedir('GET', '/api/licencia', undefined, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado);
    const l = r.datos.licencia;
    esperar(l.valida, 'la licencia no está válida');
    esperar(l.dias_restantes > 0, 'no vienen los días restantes');
    esperar(l.equipo && l.equipo.huella, 'no viene la huella del equipo');
    esperar(l.modulos.length > 0, 'no vienen los módulos habilitados');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Limpieza');

  await prueba('se desactiva el operador de prueba', async () => {
    const r = await pedir('DELETE', '/api/usuarios/' + operadorId, {}, ctx.token);
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
  });

  // Se borran las visitas y el pre-registro creados por las pruebas. El orden
  // importa: los avisos y los gafetes referencian a las visitas, asi que van
  // primero. Si se borra la visita antes, SQL Server lo rechaza con un error de
  // clave ajena y la limpieza se queda a medias.
  const bd = require(path.join(RAIZ, 'src', 'db.js'));
  const tenantPrueba = ctx.usuario.tenant_id;

  const VISITAS_DE_PRUEBA =
    "SELECT id FROM vf_visitas WHERE tenant_id = @t AND (nombre_completo LIKE '%Anunciado%' OR cedula IN ('00100000017','00100000033'))";

  await bd.consultar('DELETE FROM vf_avisos WHERE tenant_id = @t AND visita_id IN (' + VISITAS_DE_PRUEBA + ')', { t: tenantPrueba });
  await bd.consultar(
    "DELETE FROM vf_gafetes WHERE tenant_id = @t AND visita_id IN (SELECT id FROM vf_visitas WHERE nombre_completo LIKE '%Anunciado%' OR cedula IN ('00100000017','00100000033'))",
    { t: tenantPrueba }
  );
  // Avisos dirigidos a los departamentos de prueba, que no cuelgan de una visita.
  await bd.consultar(
    "DELETE FROM vf_avisos WHERE tenant_id = @t AND destinatario LIKE 'ZZ-%'",
    { t: tenantPrueba }
  );
  await bd.consultar("DELETE FROM vf_vigilancia_avisos WHERE tenant_id = @t AND cedula IN ('00100000017','00100000033')", { t: tenantPrueba });
  const r = await bd.consultar(
    "DELETE FROM vf_visitas WHERE tenant_id = @t AND (nombre_completo LIKE '%Anunciado%' OR cedula IN ('00100000017','00100000033'))",
    { t: tenantPrueba }
  );
  await bd.consultar("DELETE FROM vf_preregistros WHERE tenant_id = @t AND nombre_completo = 'Visitante Anunciado'", { t: tenantPrueba });
  await bd.consultar("DELETE FROM vf_visitantes WHERE tenant_id = @t AND cedula IN ('00100000017','00100000033')", { t: tenantPrueba });
  await bd.consultar("DELETE FROM vf_vigilancia WHERE tenant_id = @t AND motivo LIKE 'Prueba automática%'", { t: tenantPrueba });
  await bd.consultar("DELETE FROM vf_usuarios WHERE tenant_id = @t AND correo = 'operador@prueba.local'", { t: tenantPrueba });
  await bd.consultar("DELETE FROM vf_departamentos WHERE tenant_id = @t AND nombre LIKE 'ZZ-PRUEBA%'", { t: tenantPrueba });
  await bd.consultar("UPDATE vf_tenants SET color_primario = '#1e3a8a', color_secundario = '#f59e0b', logo_url = NULL WHERE id = @id", { id: tenantPrueba });
  await bd.cerrar();

  console.log('  (se borraron ' + (r.rowsAffected[0] || 0) + ' visitas de prueba)');

  console.log('');
  console.log('  ─────────────────────────────────────────────');
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ─────────────────────────────────────────────');
  if (fallos) {
    console.log('');
    for (const f of fallosDetalle) console.log('    ' + f);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('');
  console.error('  No se pudieron correr las pruebas: ' + e.message);
  console.error('  ¿Está el servidor en marcha?  npm start');
  console.error('');
  process.exit(1);
});
