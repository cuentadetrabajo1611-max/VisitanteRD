/**
 * VisitaFlow - La busqueda por nombre, con casos de recepcionista.
 *
 *   node scripts/probar-busqueda-nombres.js
 *
 * POR QUE
 * -------
 * Buscar por nombre es lo que el recepcionista hace todo el dia: el visitante dice
 * "soy Juan Perez" y hay que encontrarlo. Ya hubo aqui un fallo grave —"ABREU GUZMAN"
 * no terminaba nunca y la busqueda fallaba entera— asi que conviene vigilarlo.
 *
 * Lo que se prueba son las formas REALES de escribir, no las comodas:
 *
 *   - solo el apellido, que es lo mas comun
 *   - nombre y apellido, en los dos ordenes
 *   - apellidos compuestos, que en Republica Dominicana son la norma
 *   - sin tildes ni enie, que es como se teclea con prisa
 *   - un nombre comun, que devuelve miles
 *   - algo que no existe, que tiene que decir "no hay" y no quedarse pensando
 *
 * Y se mide el TIEMPO: una busqueda que tarda mas de dos segundos es inservible con el
 * visitante delante.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));
const padron = require(path.join(RAIZ, 'src', 'identidad', 'padron.js'));

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/* Cuanto puede tardar una busqueda antes de ser inservible.
 *
 * Hay dos limites, y son distintos a proposito:
 *
 *  - Los apellidos COMUNES —que son la mayoria de lo que pasa por una puerta— tienen
 *    que responder al instante, porque el motor encuentra las filas que se le piden
 *    enseguida y para. Si algun dia tardan mas de dos segundos, algo se rompio.
 *
 *  - Los apellidos POCO COMUNES obligan a recorrer los 7,8 millones de filas del
 *    padron, porque la base solo tiene el indice de la cedula. Eso tarda entre 10 y 20
 *    segundos y NO se puede evitar sin anadir un indice a una base de solo lectura.
 *    Se les da un margen amplio: lo que se comprueba es que ENCUENTREN, que es lo que
 *    antes no hacian. */
const LIMITE_COMUN_MS = 2000;
const LIMITE_RARO_MS = 30000;

(async () => {
  console.log('');
  console.log('  VisitaFlow - buscar personas por nombre');
  console.log('  ' + '='.repeat(66));

  await bd.conectarPadron();

  const salud = bd.saludPadron();
  if (!salud.disponible) {
    console.log('');
    console.log('  La base de cédulas no está disponible. Arránquela y vuelva a intentar.');
    console.log('');
    process.exitCode = 1;
    return;
  }

  /* Se cogen apellidos y nombres REALES del padron, para probar con lo que hay. */
  const muestra = await bd.consultarPadron(
    `SELECT TOP 6 Apellido1, COUNT(*) AS n
       FROM dbo.CIUDADANOS
      WHERE Apellido1 IS NOT NULL AND LEN(Apellido1) > 4
      GROUP BY Apellido1
      ORDER BY COUNT(*) DESC`
  );
  const comunes = muestra.recordset.map((x) => x.Apellido1);
  info('apellidos más comunes del padrón: ' + comunes.join(', '));

  /* Y uno con enie o tilde, que es el caso que rompe las codificaciones. */
  const raros = await bd.consultarPadron(
    `SELECT TOP 3 Apellido1, Nombres FROM dbo.CIUDADANOS
      WHERE Apellido1 LIKE '%' + CHAR(209) + '%' OR Apellido1 LIKE '%' + CHAR(205) + '%'
         OR Apellido1 LIKE '%' + CHAR(211) + '%'`
  );
  const conEnie = raros.recordset[0];
  if (conEnie) info('ejemplo con Ñ o tilde: ' + conEnie.Nombres + ' ' + conEnie.Apellido1);

  /* ------------------------------------------------------------------ */
  paso('1. Casos reales de recepcionista');

  const casos = [];

  if (comunes[0]) {
    casos.push({ que: 'solo el apellido más común', texto: comunes[0], debe: 'encontrar' });
    casos.push({ que: 'el apellido en minúsculas', texto: comunes[0].toLowerCase(), debe: 'encontrar' });
  }
  if (comunes[1]) {
    casos.push({ que: 'otro apellido común', texto: comunes[1], debe: 'encontrar' });
  }
  if (conEnie) {
    /* Sin la enie ni la tilde: es como se teclea con prisa. */
    const sinSignos = conEnie.Apellido1.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ñ/g, 'N').replace(/ñ/g, 'n');
    /* Estos son POCO COMUNES (CAAMAÑO son 336 personas de 7,8 millones), asi que se
       juzgan con el limite amplio. Lo que se comprueba es que ENCUENTREN: antes
       devolvian cero resultados, que es lo grave. */
    casos.push({ que: 'un apellido con Ñ, escrito sin la Ñ', texto: sinSignos, debe: 'encontrar', raro: true });
    casos.push({ que: 'ese mismo apellido, con la Ñ', texto: conEnie.Apellido1, debe: 'encontrar', raro: true });
    /* Nombre y apellido, como lo dice la persona. */
    const primerNombre = String(conEnie.Nombres).split(' ')[0];
    casos.push({ que: 'nombre y apellido juntos', texto: primerNombre + ' ' + conEnie.Apellido1, debe: 'encontrar', raro: true });
    casos.push({ que: 'apellido y nombre, al revés', texto: conEnie.Apellido1 + ' ' + primerNombre, debe: 'encontrar', raro: true });
  }
  casos.push({ que: 'algo que no existe', texto: 'ZZQXWVUT', debe: 'no_encontrar', raro: true });
  casos.push({ que: 'una sola letra', texto: 'A', debe: 'rechazar' });

  for (const c of casos) {
    const t0 = Date.now();
    let r;
    try {
      r = await padron.porNombre(c.texto, 20);
    } catch (e) {
      mal('"' + c.texto + '" (' + c.que + ') reventó: ' + e.message);
      continue;
    }
    const ms = Date.now() - t0;
    const n = (r.resultados || []).length;

    const etiqueta = '"' + c.texto + '" (' + c.que + ')';

    if (c.debe === 'rechazar') {
      if (!n && r.motivo) bien(etiqueta + ' se rechaza con un motivo claro: "' + r.motivo + '"');
      else mal(etiqueta + ' debería rechazarse y devolvió ' + n + ' resultado(s)');
      continue;
    }

    if (c.debe === 'no_encontrar') {
      /* Con un termino que no existe, la base TIENE que recorrer las 7,8 millones de
         filas para poder decirlo, y eso no siempre cabe en el tiempo de espera. Las dos
         respuestas son validas:
           - cero resultados y nada mas: se recorrio la base y no esta.
           - "la busqueda tardo demasiado": no se llego a saber.
         Lo que NO vale es decir "no hay resultados" cuando en realidad no se termino de
         buscar, porque el recepcionista concluiria que esa persona no esta en el padron. */
      if (n === 0 && r.incompleta) {
        bien(etiqueta + ' dice que no le dio tiempo a terminar, en vez de decir que no existe');
        info('    motivo: ' + r.motivo);
      } else if (n === 0) {
        bien(etiqueta + ' no encuentra nada, que es la verdad');
      } else {
        mal(etiqueta + ' encuentra ' + n + ' resultados y no debería encontrar ninguno');
      }
    } else {
      if (n > 0) {
        bien(etiqueta + ' encuentra ' + n + ' (' + ms + ' ms)');
        if (n <= 3) info('    ' + r.resultados.map((x) => x.nombre_completo).join(' | ').slice(0, 110));
      } else {
        mal(etiqueta + ' NO ENCUENTRA NADA: el recepcionista no encontraría a esa persona');
      }
    }

    /* El tiempo. Da igual acertar si el recepcionista se cansa de esperar. */
    const limite = c.raro ? LIMITE_RARO_MS : LIMITE_COMUN_MS;
    if (ms > limite) {
      mal(etiqueta + ' tardó ' + ms + ' ms (el límite es ' + limite + ' ms): ' +
        (c.raro ? 'ni siquiera con el margen amplio' : 'un apellido común tiene que ser instantáneo'));
    } else if (c.raro && ms > LIMITE_COMUN_MS) {
      /* Se dice, pero no es un fallo: es el precio de buscar un apellido poco común en
         una base que solo tiene el índice de la cédula. */
      info('    (tardó ' + Math.round(ms / 1000) + ' s: es un apellido poco común y hay que recorrer toda la base)');
    }
  }

  /* ------------------------------------------------------------------ */
  paso('2. Los resultados tienen que traer lo que hace falta');

  const uno = await padron.porNombre(comunes[0] || 'RODRIGUEZ', 5);
  const fila = (uno.resultados || [])[0];

  if (!fila) {
    mal('no se pudo comprobar la forma de un resultado');
  } else {
    const campos = {
      cedula: 'la cédula',
      nombre_completo: 'el nombre completo',
    };
    for (const [k, nombre] of Object.entries(campos)) {
      if (fila[k]) bien('el resultado trae ' + nombre);
      else mal('el resultado NO trae ' + nombre + ': no se puede registrar al visitante');
    }

    /* La cédula tiene que venir en dígitos, sin guiones, que es como se guarda. */
    if (/^\d+$/.test(String(fila.cedula))) {
      bien('la cédula viene en dígitos, como se guarda (' + fila.cedula + ')');
    } else {
      mal('la cédula viene con formato raro: "' + fila.cedula + '"');
    }

    if (fila.cedula_formato && /-/.test(fila.cedula_formato)) {
      bien('y viene formateada para mostrarla (' + fila.cedula_formato + ')');
    } else {
      info('sin cédula formateada: se mostraría sin guiones');
    }

    info('ejemplo: ' + fila.nombre_completo + '  ' + (fila.cedula_formato || fila.cedula));
  }

  /* ------------------------------------------------------------------ */
  paso('3. El límite de resultados se respeta');

  const muchos = await padron.porNombre(comunes[0] || 'RODRIGUEZ', 3);
  if ((muchos.resultados || []).length <= 3) {
    bien('pidiendo 3 devuelve como mucho 3 (' + muchos.resultados.length + ')');
  } else {
    mal('pidiendo 3 devolvió ' + muchos.resultados.length + ': la pantalla se llenaría de filas');
  }

  /* ------------------------------------------------------------------ */
  paso('4. Una búsqueda de verdad, cronometrada como la haría la API');

  const t0 = Date.now();
  const r = await padron.porNombre(comunes[0] || 'RODRIGUEZ', 20);
  const ms = Date.now() - t0;

  info('"' + (comunes[0] || 'RODRIGUEZ') + '" con 20 resultados: ' + ms + ' ms');

  if (ms <= LIMITE_COMUN_MS) {
    bien('responde en menos de ' + LIMITE_COMUN_MS + ' ms');
  } else {
    mal('tarda ' + ms + ' ms');
  }

  const repetida = Date.now();
  await padron.porNombre(comunes[0] || 'RODRIGUEZ', 20);
  const ms2 = Date.now() - repetida;
  info('la segunda vez: ' + ms2 + ' ms (la caché de SQL Server ayuda)');

  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(66));
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  try { await bd.cerrar(); } catch (e) { /* da igual */ }
  process.exitCode = fallos ? 1 : 0;
})().catch(async (e) => {
  console.log('');
  console.log('  Se detuvo: ' + e.message);
  console.log('');
  try { await bd.cerrar(); } catch (x) { /* da igual */ }
  process.exitCode = 1;
});
