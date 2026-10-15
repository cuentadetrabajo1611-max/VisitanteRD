/**
 * VisitaFlow - Pruebas del directorio de personas y de los avisos.
 *
 *   node sql/95-pruebas-personas.js
 *
 * Necesita el servidor en marcha (npm start) y una institucion con licencia.
 *
 * QUE CUBRE
 * ---------
 *   - El directorio: alta, edicion, baja logica y busqueda, por la API.
 *   - Que se puede registrar una visita eligiendo a la persona del directorio.
 *   - Que al registrar se genera el AVISO a quien corresponde.
 *   - Que el aviso se genera AUNQUE no haya correo configurado, que es el caso
 *     de una institucion sin servidor de correo. Es lo mas importante de todo:
 *     si el aviso dependiera del correo, esas instituciones no avisarian nunca.
 *   - Que el cliente de correo falla con elegancia (sin colgar la peticion)
 *     cuando el servidor no existe.
 *   - Que el aviso se puede marcar como leido.
 *
 * Se limpia sola: borra todo lo que crea.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));

const BASE = process.env.PRUEBA_URL || 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const detalle = [];

function prueba(nombre, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      ok++;
      console.log('  ok   ' + nombre);
    })
    .catch((e) => {
      fallos++;
      detalle.push(nombre + ' -> ' + e.message);
      console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
    });
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

let token = null;

async function api(metodo, ruta, cuerpo) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = { mensaje: texto.slice(0, 200) }; }
  return { estado: r.status, datos };
}

/**
 * El motivo de un error, para que las pruebas digan POR QUE fallo.
 *
 * Sin esto, un 400 sin mensaje deja la prueba diciendo "estado 400" y hay que
 * ir a buscarlo a mano. La API usa "motivo" o "mensaje" segun la ruta, asi que
 * se miran los dos.
 */
function motivoDe(r) {
  const d = r.datos || {};
  return d.motivo || d.mensaje || d.error || JSON.stringify(d).slice(0, 200);
}

/**
 * Espera a que aparezca el aviso de una visita.
 *
 * El aviso se genera DESPUÉS de responder al registro, a propósito: el
 * recepcionista no puede quedarse esperando a que un servidor de correo decida
 * si contesta. Eso significa que al terminar la petición el aviso puede tardar
 * unas décimas en estar. Sin esta espera, la prueba falla por mirar demasiado
 * pronto, y parece un error del sistema cuando no lo es.
 */
async function esperarAviso(visitaId, segundos) {
  const limite = (segundos || 8) * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < limite) {
    const r = await bd.consultar(
      'SELECT id, destinatario, destinatario_correo, persona_id, asunto, cuerpo, estado FROM vf_avisos WHERE visita_id = @v ORDER BY id DESC',
      { v: visitaId }
    );
    if (r.recordset.length) return r.recordset;
    await new Promise((res) => setTimeout(res, 150));
  }
  return [];
}

/* Lo que crea la prueba, para poder borrarlo despues. */
const creado = { personas: [], deptos: [], visitas: [], avisos: [], visitantes: [] };

/* Tres cédulas que existen de verdad en la base (apellido ABAD).
   Se buscan al arrancar en vez de escribirlas a mano: si el padrón cambia, la
   suite sigue funcionando. Si no se encuentran, las pruebas que las necesitan
   lo dicen en vez de fallar con un error confuso. */
const cedulas = [];

async function buscarCedulas() {
  const r = await bd.consultarPadron(
    "SELECT TOP 3 Cedula FROM dbo.CIUDADANOS WHERE Apellido1 LIKE 'ABAD%' ORDER BY Cedula"
  );
  for (const c of r.recordset) cedulas.push(c.Cedula);
  return cedulas.length;
}

/** Una cédula de la lista, por posición (1, 2, 3). */
function cedulaDe(n) {
  return cedulas[n - 1];
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - pruebas del directorio y los avisos');
  console.log('  ' + '='.repeat(64));

  // El servidor tiene que estar en marcha.
  try {
    const r = await fetch(BASE + '/api/salud');
    if (!r.ok) throw new Error('estado ' + r.status);
  } catch (e) {
    console.error('\n  El servidor no responde en ' + BASE + '. Arránquelo con: npm start\n');
    process.exit(1);
  }

  const cred = leerCredenciales();
  if (!cred) {
    console.error('\n  No hay credenciales del administrador. Use: npm run admin:restablecer <institucion>\n');
    process.exit(1);
  }

  const entrada = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  token = entrada.datos.token;
  if (!token) {
    console.error('\n  No se pudo iniciar sesión.\n');
    process.exit(1);
  }

  await bd.conectarSistema();
  await bd.conectarPadron();

  if (!(await buscarCedulas())) {
    console.error('\n  No se encontraron cédulas de prueba en la base de cédulas.');
    console.error('  Compruebe que PadronLigero existe y que la vista dbo.CIUDADANOS está creada:');
    console.error('      npm run db:vista\n');
    await bd.cerrar();
    process.exit(1);
  }
  console.log('');
  console.log('  Cédulas de prueba: ' + cedulas.join(', '));

  /* La suite tiene que poder repetirse. El registro rechaza a un visitante que
     ya esta dentro, asi que si una corrida anterior dejo visitas abiertas de
     prueba, la siguiente falla con "ya esta dentro" y parece un error del
     sistema cuando es basura de la prueba anterior. Se limpia primero. */
  try {
    const restos = await bd.consultar(
      "SELECT COUNT(*) AS n FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%'"
    );
    if (restos.recordset[0].n) {
      console.log('');
      console.log('  (limpiando ' + restos.recordset[0].n + ' visita(s) de una corrida anterior)');
      await bd.consultar(
        "DELETE FROM vf_avisos WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%')"
      );
      await bd.consultar(
        "DELETE FROM vf_gafetes WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%')"
      );
      await bd.consultar(
        "DELETE FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%'"
      );
      await bd.consultar("DELETE FROM vf_personas WHERE nombre LIKE 'ZZ-%'");
      await bd.consultar("DELETE FROM vf_departamentos WHERE nombre LIKE 'ZZ-%'");
    }
  } catch (e) {
    console.log('  (no se pudieron limpiar los restos: ' + e.message + ')');
  }

  try {
    /* ================================================================ */
    console.log('');
    console.log('El esquema');

    await prueba('las tablas del directorio y de avisos existen', async () => {
      const r = await bd.consultar(
        "SELECT name FROM sys.tables WHERE name IN ('vf_personas','vf_avisos') ORDER BY name"
      );
      esperar(r.recordset.length === 2, 'solo existen: ' + r.recordset.map((x) => x.name).join(', '));
    });

    await prueba('la visita guarda a qué persona del directorio se visita', async () => {
      const r = await bd.consultar(
        "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.vf_visitas') AND name = 'persona_id'"
      );
      esperar(r.recordset[0].n === 1, 'no existe la columna vf_visitas.persona_id');
    });

    /* ================================================================ */
    console.log('');
    console.log('El directorio de personas');

    let deptoId = null;
    await prueba('se crea un departamento donde ubicar a la persona', async () => {
      const r = await api('POST', '/api/config/departamentos', {
        nombre: 'ZZ-Prueba Mantenimiento',
        encargado: 'Encargado de Prueba',
        correo: 'encargado@zz-prueba.local',
      });
      esperar(r.estado === 201 && r.datos.id, 'no se creó: ' + r.estado + ' ' + (r.datos.mensaje || ''));
      deptoId = r.datos.id;
      creado.deptos.push(deptoId);
    });

    let personaId = null;
    await prueba('se crea una persona en el directorio', async () => {
      const r = await api('POST', '/api/config/personas', {
        nombre: 'ZZ-Persona de Prueba',
        cargo: 'Supervisor',
        correo: 'persona@zz-prueba.local',
        telefono: '809-555-0000',
        departamento_id: deptoId,
        recibe_visitas: true,
      });
      esperar(r.estado === 201 && r.datos.id, 'no se creó: ' + r.estado + ' ' + (r.datos.mensaje || ''));
      personaId = r.datos.id;
      creado.personas.push(personaId);
    });

    await prueba('la persona queda ligada a su departamento', async () => {
      const r = await api('GET', '/api/config/personas');
      const p = (r.datos.filas || []).find((x) => x.id === personaId);
      esperar(p, 'no aparece en el listado');
      esperar(p.departamento_id === deptoId, 'el departamento es ' + p.departamento_id);
      esperar(p.recibe_visitas === true, 'recibe_visitas debería ser booleano y verdadero');
    });

    await prueba('sin departamento se guarda como nulo, no como cero', async () => {
      // Cero no es un id válido y la clave ajena lo rechazaría.
      const r = await api('POST', '/api/config/personas', {
        nombre: 'ZZ-Sin Departamento',
        departamento_id: '',
      });
      esperar(r.estado === 201, 'no se creó: ' + r.estado + ' ' + (r.datos.mensaje || ''));
      creado.personas.push(r.datos.id);
      const t = await bd.consultar('SELECT departamento_id FROM vf_personas WHERE id = @id', { id: r.datos.id });
      esperar(t.recordset[0].departamento_id === null, 'quedó en ' + t.recordset[0].departamento_id + ' en vez de nulo');
    });

    await prueba('el selector de personas devuelve lo mínimo para elegir', async () => {
      // Esta es la ruta que usa el recepcionista, con permiso de registro.
      const r = await api('GET', '/api/personas');
      esperar(r.estado === 200, 'estado ' + r.estado);
      const p = (r.datos.personas || []).find((x) => x.id === personaId);
      esperar(p, 'la persona no aparece en el selector');
      esperar(p.nombre && p.departamento, 'falta el nombre o el departamento');
    });

    await prueba('el selector se puede filtrar por departamento', async () => {
      const r = await api('GET', '/api/personas?departamento_id=' + deptoId);
      esperar(r.estado === 200, 'estado ' + r.estado);
      const todas = r.datos.personas.every((x) => x.departamento_id === deptoId);
      esperar(todas, 'vino alguna persona de otro departamento');
      esperar(r.datos.personas.length >= 1, 'no vino ninguna');
    });

    await prueba('el selector se puede buscar por nombre', async () => {
      const r = await api('GET', '/api/personas?texto=ZZ-Persona');
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.personas.length >= 1, 'la búsqueda no encontró nada');
    });

    await prueba('quien no recibe visitas no sale en el selector', async () => {
      const r = await api('POST', '/api/config/personas', {
        nombre: 'ZZ-No Recibe Visitas',
        recibe_visitas: false,
      });
      esperar(r.estado === 201, 'no se creó');
      creado.personas.push(r.datos.id);

      const sel = await api('GET', '/api/personas?texto=ZZ-No Recibe');
      esperar(sel.estado === 200, 'estado ' + sel.estado);
      const aparece = (sel.datos.personas || []).some((x) => x.id === r.datos.id);
      esperar(!aparece, 'aparece en el selector aunque no recibe visitas');
    });

    /* ================================================================ */
    console.log('');
    console.log('Registrar una visita a una persona del directorio');

    let visitaId = null;
    let cedula = null;

    await prueba('se registra una visita eligiendo a la persona', async () => {
      const buscar = await api('GET', '/api/registro/buscar?q=' + cedulaDe(1));
      esperar(buscar.estado === 200 && buscar.datos.resultados.length, 'no se encontró la cédula de prueba');
      cedula = buscar.datos.resultados[0].cedula;
      creado.visitantes.push(cedula);

      const cat = await api('GET', '/api/registro/consultar?cedula=' + cedula);
      const c = cat.datos.consulta.catalogos;

      const r = await api('POST', '/api/registro', {
        cedula,
        motivo_id: c.motivos[0].id,
        departamento_id: deptoId,
        persona_id: personaId,
        visitado: 'ZZ-Persona de Prueba',
        observaciones: 'DEMO personas y avisos',
        permitir_duplicado: true,
      });
      esperar(r.estado === 201, 'estado ' + r.estado + ': ' + motivoDe(r));
      visitaId = r.datos.visita.id;
      creado.visitas.push(visitaId);
    });

    await prueba('la visita quedó ligada a la persona', async () => {
      const r = await api('GET', '/api/visitas/' + visitaId);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.visita.persona_id === personaId,
        'persona_id es ' + r.datos.visita.persona_id + ' y se esperaba ' + personaId);
      esperar(r.datos.visita.departamento_id === deptoId, 'el departamento no coincide');
    });

    /* ================================================================ */
    console.log('');
    console.log('El aviso al anfitrión');

    await prueba('se generó un aviso para la persona visitada', async () => {
      const avisos = await esperarAviso(visitaId);
      esperar(avisos.length === 1, 'no se generó ningún aviso');
      const a = avisos[0];
      creado.avisos.push(a.id);
      esperar(a.destinatario === 'ZZ-Persona de Prueba', 'el destinatario es "' + a.destinatario + '"');
      esperar(a.destinatario_correo === 'persona@zz-prueba.local', 'el correo es ' + a.destinatario_correo);
      esperar(a.asunto && a.cuerpo, 'falta el asunto o el cuerpo');
    });

    await prueba('el aviso dice quién llegó y a quién visita', async () => {
      const avisos = await esperarAviso(visitaId);
      esperar(avisos.length, 'no hay aviso');
      const cuerpo = avisos[0].cuerpo;
      esperar(/Llegó una visita/.test(cuerpo), 'no saluda');
      esperar(cuerpo.indexOf('ZZ-Persona de Prueba') !== -1, 'no dice a quién visita');
      esperar(/Visitante/.test(cuerpo), 'no dice quién llegó');
    });

    await prueba('el aviso NO depende del correo: se guarda aunque falle', async () => {
      /* Este es el punto más importante del módulo. La institución de prueba no
         tiene servidor de correo, así que el aviso tiene que quedar guardado
         con estado de error o sin_correo, pero GUARDADO. Si dependiera del
         correo, una junta sin servidor de correo no avisaría nunca. */
      const avisos = await esperarAviso(visitaId);
      esperar(avisos.length, 'no hay aviso');
      const a = avisos[0];
      esperar(a.estado !== 'pendiente', 'quedó en "pendiente": nadie lo resolvió');
      esperar(['enviado', 'error', 'sin_correo'].indexOf(a.estado) !== -1, 'estado inesperado: ' + a.estado);
    });

    await prueba('los avisos sin leer se pueden consultar desde la API', async () => {
      const r = await api('GET', '/api/avisos');
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(typeof r.datos.sin_leer === 'number', 'no viene el conteo');
      const mio = (r.datos.avisos || []).find((x) => x.visita_id === visitaId);
      esperar(mio, 'el aviso de la visita no aparece entre los pendientes');
    });

    await prueba('el aviso se puede marcar como leído', async () => {
      const r = await bd.consultar('SELECT TOP 1 id FROM vf_avisos WHERE visita_id = @v', { v: visitaId });
      const id = r.recordset[0].id;

      const antes = await api('GET', '/api/avisos');
      const marcado = await api('POST', '/api/avisos/' + id + '/leido');
      esperar(marcado.estado === 200, 'estado ' + marcado.estado);
      esperar(marcado.datos.marcado === true, 'no se marcó');

      const despues = await api('GET', '/api/avisos');
      esperar(despues.datos.sin_leer === antes.datos.sin_leer - 1,
        'sin leer pasó de ' + antes.datos.sin_leer + ' a ' + despues.datos.sin_leer + ', debería bajar uno');
    });

    /* ================================================================ */
    console.log('');
    console.log('Aviso cuando el nombre se escribe a mano');

    await prueba('escribiendo el nombre de alguien del directorio, se encuentra', async () => {
      const buscar = await api('GET', '/api/registro/buscar?q=' + cedulaDe(2));
      esperar(buscar.estado === 200 && buscar.datos.resultados.length, 'no se encontró la segunda cédula');
      const ced2 = buscar.datos.resultados[0].cedula;
      creado.visitantes.push(ced2);

      const cat = await api('GET', '/api/registro/consultar?cedula=' + ced2);
      const c = cat.datos.consulta.catalogos;

      // Sin persona_id: solo el nombre escrito.
      const r = await api('POST', '/api/registro', {
        cedula: ced2,
        motivo_id: c.motivos[0].id,
        departamento_id: deptoId,
        visitado: 'ZZ-Persona de Prueba',
        observaciones: 'DEMO aviso por nombre',
        permitir_duplicado: true,
      });
      esperar(r.estado === 201, 'estado ' + r.estado + ': ' + motivoDe(r));
      creado.visitas.push(r.datos.visita.id);

      // El aviso tiene que haberse dirigido a la persona del directorio, con su correo.
      const avisos = await esperarAviso(r.datos.visita.id);
      esperar(avisos.length === 1, 'no se generó aviso');
      creado.avisos.push(avisos[0].id);
      esperar(avisos[0].persona_id === personaId,
        'no se reconoció a la persona del directorio (persona_id ' + avisos[0].persona_id + ')');
      esperar(avisos[0].destinatario_correo === 'persona@zz-prueba.local',
        'el correo quedó en ' + avisos[0].destinatario_correo);
    });

    await prueba('escribiendo un nombre que no está, se avisa al encargado del departamento', async () => {
      const buscar = await api('GET', '/api/registro/buscar?q=' + cedulaDe(3));
      esperar(buscar.estado === 200 && buscar.datos.resultados.length, 'no se encontró la tercera cédula');
      const ced3 = buscar.datos.resultados[0].cedula;
      creado.visitantes.push(ced3);

      const cat = await api('GET', '/api/registro/consultar?cedula=' + ced3);
      const c = cat.datos.consulta.catalogos;

      const r = await api('POST', '/api/registro', {
        cedula: ced3,
        motivo_id: c.motivos[0].id,
        departamento_id: deptoId,
        visitado: 'ZZ-Alguien Que No Esta En El Directorio',
        observaciones: 'DEMO aviso al encargado',
        permitir_duplicado: true,
      });
      esperar(r.estado === 201, 'estado ' + r.estado + ': ' + motivoDe(r));
      creado.visitas.push(r.datos.visita.id);

      const avisos = await esperarAviso(r.datos.visita.id);
      esperar(avisos.length === 1, 'no se generó aviso');
      creado.avisos.push(avisos[0].id);
      esperar(avisos[0].destinatario === 'ZZ-Alguien Que No Esta En El Directorio',
        'el destinatario es ' + avisos[0].destinatario);
      // El correo sale del departamento, que es lo mejor que se puede hacer.
      esperar(avisos[0].destinatario_correo === 'encargado@zz-prueba.local',
        'no se usó el correo del departamento: ' + avisos[0].destinatario_correo);
    });

    /* ================================================================ */
    console.log('');
    console.log('El cliente de correo');

    await prueba('la dirección se saca de "Nombre <correo>"', async () => {
      const avisos = require(path.join(RAIZ, 'src', 'avisos.js'));
      esperar(avisos.extraerDireccion('Ana Pérez <ana@ejemplo.com>') === 'ana@ejemplo.com', 'no la sacó');
      esperar(avisos.extraerDireccion('ana@ejemplo.com') === 'ana@ejemplo.com', 'no la sacó sin nombre');
    });

    await prueba('el mensaje se arma con acentos y sin romper el protocolo', async () => {
      const avisos = require(path.join(RAIZ, 'src', 'avisos.js'));
      const m = avisos.construirMensaje('V <v@x.com>', 'a@y.com', 'Llegó José Ábad', 'Hola:\n  Visitante: JOSÉ');
      esperar(/^From: /m.test(m), 'falta la cabecera From');
      esperar(/Content-Transfer-Encoding: base64/.test(m), 'el cuerpo no va en base64');
      esperar(/^Subject: =\?UTF-8\?B\?/m.test(m), 'el asunto no va codificado');
      // El cuerpo tiene que poder reconstruirse tal cual.
      const cuerpo = m.split('\r\n\r\n')[1].replace(/\r\n/g, '');
      const texto = Buffer.from(cuerpo, 'base64').toString('utf8');
      esperar(texto.indexOf('JOSÉ') !== -1, 'los acentos no sobrevivieron');
    });

    await prueba('con un servidor de correo inexistente falla rápido y sin colgarse', async () => {
      const avisos = require(path.join(RAIZ, 'src', 'avisos.js'));
      const t0 = Date.now();
      // Se apunta a un puerto donde no hay nada.
      const antes = { host: config.correo.host, activo: config.correo.activo, puerto: config.correo.puerto };
      config.correo.host = '127.0.0.1';
      config.correo.puerto = 59999;
      config.correo.activo = true;

      const r = await avisos.enviarCorreo('alguien@ejemplo.com', 'Prueba', 'Cuerpo');

      config.correo.host = antes.host;
      config.correo.puerto = antes.puerto;
      config.correo.activo = antes.activo;

      const segundos = (Date.now() - t0) / 1000;
      esperar(r.ok === false, 'dijo que se envió, y no hay servidor');
      esperar(r.motivo, 'no dijo por qué falló');
      esperar(segundos < 15, 'tardó ' + segundos.toFixed(1) + ' segundos: demasiado para una pantalla');
    });

    await prueba('sin correo activado no lo intenta siquiera', async () => {
      const avisos = require(path.join(RAIZ, 'src', 'avisos.js'));
      const antes = config.correo.activo;
      config.correo.activo = false;
      const r = await avisos.enviarCorreo('alguien@ejemplo.com', 'Prueba', 'Cuerpo');
      config.correo.activo = antes;
      esperar(r.ok === false, 'dijo que se envió con el correo desactivado');
      esperar(/no está activado/i.test(r.motivo), 'el motivo no lo explica: ' + r.motivo);
    });

    await prueba('una dirección inválida se rechaza con un motivo claro', async () => {
      const avisos = require(path.join(RAIZ, 'src', 'avisos.js'));
      const antes = config.correo.activo;
      config.correo.activo = true;
      const r = await avisos.enviarCorreo('esto-no-es-un-correo', 'Prueba', 'Cuerpo');
      config.correo.activo = antes;
      esperar(r.ok === false, 'lo aceptó');
      esperar(/válida/i.test(r.motivo), 'el motivo no lo explica: ' + r.motivo);
    });

    /* ================================================================ */
    console.log('');
    console.log('Baja lógica en el directorio');

    await prueba('desactivar una persona la saca del selector sin borrarla', async () => {
      const r = await api('DELETE', '/api/config/personas/' + personaId);
      esperar(r.estado === 200, 'estado ' + r.estado);

      const sel = await api('GET', '/api/personas?texto=ZZ-Persona');
      const aparece = (sel.datos.personas || []).some((x) => x.id === personaId);
      esperar(!aparece, 'sigue apareciendo en el selector');

      // Pero la persona sigue en la tabla: el histórico la necesita.
      const t = await bd.consultar('SELECT activo FROM vf_personas WHERE id = @id', { id: personaId });
      esperar(t.recordset.length === 1, 'se borró de verdad');
      esperar(t.recordset[0].activo === false, 'no quedó inactiva');
    });

    await prueba('la visita histórica sigue diciendo a quién se visitó', async () => {
      const r = await api('GET', '/api/visitas/' + visitaId);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.visita.visitado === 'ZZ-Persona de Prueba', 'se perdió el nombre');
    });
  } finally {
    /* ================================================================ */
    console.log('');
    console.log('Limpieza');

    try {
      /* El ORDEN importa y cuesta descubrirlo: las visitas apuntan al
         departamento, a la persona y al gafete. Si se borra el departamento
         antes que las visitas, SQL Server lo rechaza con un error de clave
         ajena. Se borra de lo que depende a lo que es dependido. */
      for (const id of creado.avisos) {
        await bd.consultar('DELETE FROM vf_avisos WHERE id = @id', { id });
      }

      for (const id of creado.visitas) {
        await bd.consultar('DELETE FROM vf_avisos WHERE visita_id = @id', { id });
        await bd.consultar('DELETE FROM vf_gafetes WHERE visita_id = @id', { id });
        await bd.consultar('DELETE FROM vf_visitas WHERE id = @id', { id });
      }

      // Restos de una corrida que fallo a medias, por marca y por nombre.
      await bd.consultar(
        "DELETE FROM vf_avisos WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%')"
      );
      await bd.consultar(
        "DELETE FROM vf_gafetes WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%')"
      );
      await bd.consultar(
        "DELETE FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%'"
      );

      /* Y las visitas que apunten a un departamento de prueba aunque no lleven
         la marca: son las que hacian fallar el borrado del departamento. */
      await bd.consultar(
        "DELETE FROM vf_avisos WHERE visita_id IN (SELECT v.id FROM vf_visitas v JOIN vf_departamentos d ON d.id = v.departamento_id WHERE d.nombre LIKE 'ZZ-%')"
      );
      await bd.consultar(
        "DELETE FROM vf_gafetes WHERE visita_id IN (SELECT v.id FROM vf_visitas v JOIN vf_departamentos d ON d.id = v.departamento_id WHERE d.nombre LIKE 'ZZ-%')"
      );
      await bd.consultar(
        "DELETE FROM vf_visitas WHERE departamento_id IN (SELECT id FROM vf_departamentos WHERE nombre LIKE 'ZZ-%')"
      );

      // Ahora si: la persona y el departamento.
      await bd.consultar("DELETE FROM vf_avisos WHERE destinatario LIKE 'ZZ-%'");
      for (const id of creado.personas) {
        await bd.consultar('DELETE FROM vf_personas WHERE id = @id', { id });
      }
      await bd.consultar("DELETE FROM vf_personas WHERE nombre LIKE 'ZZ-%'");
      for (const id of creado.deptos) {
        await bd.consultar('DELETE FROM vf_departamentos WHERE id = @id', { id });
      }
      await bd.consultar("DELETE FROM vf_departamentos WHERE nombre LIKE 'ZZ-%'");

      for (const c of creado.visitantes) {
        await bd.consultar(
          'DELETE FROM vf_visitantes WHERE cedula = @c AND NOT EXISTS (SELECT 1 FROM vf_visitas v WHERE v.visitante_id = vf_visitantes.id)',
          { c }
        );
      }

      const sobra = await bd.consultar(
        "SELECT (SELECT COUNT(*) FROM vf_personas WHERE nombre LIKE 'ZZ-%') AS personas, " +
        "(SELECT COUNT(*) FROM vf_departamentos WHERE nombre LIKE 'ZZ-%') AS deptos, " +
        "(SELECT COUNT(*) FROM vf_avisos WHERE destinatario LIKE 'ZZ-%') AS avisos"
      );
      const s = sobra.recordset[0];
      console.log('  quedan de prueba: ' + s.personas + ' personas, ' + s.deptos + ' departamentos, ' + s.avisos + ' avisos');
    } catch (e) {
      console.error('  Error al limpiar: ' + e.message);
    }

    await bd.cerrar();
  }

  console.log('');
  console.log('  ' + '='.repeat(64));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(64));
  if (fallos) {
    console.log('');
    for (const d of detalle) console.log('    ' + d);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
