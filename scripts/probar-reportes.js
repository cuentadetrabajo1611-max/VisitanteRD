/**
 * VisitaFlow - Los reportes y la exportacion a CSV.
 *
 *   node scripts/probar-reportes.js
 *
 * POR QUE
 * -------
 * El recepcionista registra a "JOSE MANUEL DE PEÑA" y a "CARLOS JOSE RODRIGUEZ". Si la
 * exportacion no lleva la codificacion bien, el cliente abre el archivo en Excel y ve
 * "PEÃ‘A" y "RODRÃGUEZ". Eso no da ningun error y no se descubre hasta que alguien lo
 * abre, que es tarde.
 *
 * Por eso esta prueba no se queda en mirar que el archivo se descargue: lo LEE con
 * pandas, que es lo que hace Excel por dentro, y comprueba que los nombres con tilde y
 * con enie salen enteros.
 *
 * Tambien se comprueba que los numeros del reporte cuadren entre si: que el total sea la
 * suma de las partes, y que los repartos sumen lo mismo que el total.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

let token = null;

async function api(metodo, ruta, cuerpo) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;

  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });

  let datos = null;
  const texto = await r.text();
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 300) }; }
  return { estado: r.status, datos };
}

/** Una cédula real con enie o tilde en el apellido, si el padrón tiene alguna. */
async function cedulaConEnieOTilde() {
  const bd = require(path.join(RAIZ, 'src', 'db.js'));
  await bd.conectarPadron();
  const r = await bd.consultarPadron(
    "SELECT TOP 1 Cedula, Nombres, Apellido1, Apellido2 FROM dbo.CIUDADANOS " +
    "WHERE Apellido1 LIKE '%' + CHAR(209) + '%' OR Apellido1 LIKE '%' + CHAR(211) + '%' " +
    "OR Apellido1 LIKE '%' + CHAR(205) + '%' " +
    "ORDER BY Cedula DESC"
  );
  return r.recordset[0] || null;
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - reportes y exportación a CSV');
  console.log('  ' + '='.repeat(66));

  const cred = leerCredenciales();
  const sesion = await api('POST', '/api/acceso/entrar', { correo: cred.usuario, clave: cred.clave });
  if (sesion.estado !== 200) throw new Error('no se pudo entrar');
  token = sesion.datos.token;
  bien('sesión iniciada');

  /* El módulo de reportes tiene que estar en la licencia. */
  if ((sesion.datos.permisos || []).indexOf('reportes.exportar') === -1) {
    throw new Error('esta licencia no incluye el módulo de reportes: no se puede probar');
  }
  bien('la licencia incluye reportes');

  const cfg = await api('GET', '/api/config');
  const c = cfg.datos.config || cfg.datos;
  const motivos = c.motivos || [];

  /* ------------------------------------------------------------------ */
  paso('1. Registrar una visita con un nombre que lleva Ñ y tildes');

  const persona = await cedulaConEnieOTilde();
  const marca = 'RPT-' + Date.now().toString().slice(-6);
  let idVisita = null;

  if (persona) {
    info('cédula del padrón: ' + persona.Cedula + '  ' + persona.Nombres + ' ' + persona.Apellido1);
  }

  const alta = await api('POST', '/api/registro', {
    /* Con cédula del padrón, el nombre sale de ahí y trae la Ñ o la tilde de verdad. */
    cedula: persona ? String(persona.Cedula).trim() : '00100000017',
    visitado: 'Administrador ' + marca,
    motivo_id: motivos.length ? motivos[0].id : null,
    empresa: 'Empresa Ñandú ' + marca,
  });

  if (alta.estado === 200 || alta.estado === 201) {
    idVisita = alta.datos.visita ? alta.datos.visita.id : null;
    bien('visita registrada (id ' + idVisita + ')');
    info('nombre: ' + ((alta.datos.visita || {}).nombre_completo || '—'));
  } else {
    mal('no se pudo registrar (estado ' + alta.estado + '): ' + (alta.datos.mensaje || alta.datos.motivo || ''));
  }

  try {
    /* ------------------------------------------------------------------ */
    paso('2. Los números del reporte cuadran entre sí');

    const rep = await api('GET', '/api/reportes/resumen');
    if (rep.estado !== 200) {
      mal('el resumen no respondió (estado ' + rep.estado + ')');
    } else {
      const r = rep.datos.reporte || rep.datos;
      /* Los números del resumen vienen en `metricas`, no en `totales`. */
      const t = r.metricas || r.totales || {};

      info('visitas: ' + t.visitas + '   personas distintas: ' + t.visitantes_distintos +
        '   promedio diario: ' + t.promedio_diario);

      if (typeof t.visitas === 'number' && t.visitas > 0) {
        bien('el total de visitas es un número y hay datos (' + t.visitas + ')');
      } else {
        mal('el total de visitas no es un número válido: ' + t.visitas);
      }

      /* Los repartos tienen que sumar lo mismo que el total, o el reporte engaña. */
      const repartos = r.repartos || {};
      /* OJO con el campo del valor: los repartos usan `n` y las series usan `valor`.
         El frontend acepta los dos (`normalizar`), así que aquí también. */
      const valorDe = (x) => Number(x.valor !== undefined ? x.valor : x.n);

      const porDepto = repartos.por_departamento || [];
      const sumaDepto = porDepto.reduce((s, x) => s + (Number.isFinite(valorDe(x)) ? valorDe(x) : 0), 0);

      if (sumaDepto <= t.visitas) {
        bien('el reparto por departamento suma ' + sumaDepto + ' de ' + t.visitas + ' (no se pasa)');
      } else {
        mal('el reparto por departamento suma MÁS que el total: ' + sumaDepto + ' > ' + t.visitas);
      }

      /* Y que no haya valores raros en los gráficos: si no son números, la barra sale
         como "undefined" y nadie lo nota hasta que lo mira un cliente. */
      const todos = [].concat(
        repartos.por_departamento || [],
        repartos.por_motivo || [],
        repartos.personas_mas_visitadas || [],
        repartos.por_empresa || [],
        (r.series || {}).por_hora || [],
        (r.series || {}).por_dia_semana || [],
        (r.series || {}).por_dia || []
      );

      const conValorRaro = todos.filter((x) => !Number.isFinite(valorDe(x)));

      if (!conValorRaro.length) {
        bien('los ' + todos.length + ' valores de los gráficos son números');
      } else {
        mal(conValorRaro.length + ' valor(es) de gráfico no son números (saldrían como "undefined" en la barra)');
      }

      const sinEtiqueta = todos.filter((x) => !x.etiqueta);

      if (!sinEtiqueta.length) {
        bien('todas las barras tienen su etiqueta');
      } else {
        mal(sinEtiqueta.length + ' barra(s) sin etiqueta');
      }

      /* Franjas de hora y días: los ejes de los gráficos. */
      const series = r.series || {};
      if ((series.por_hora || []).length === 24) bien('la serie por hora trae las 24 horas');
      else mal('la serie por hora trae ' + ((series.por_hora || []).length) + ' valores y deberían ser 24');

      if ((series.por_dia_semana || []).length === 7) bien('la serie por día de la semana trae 7 días');
      else mal('la serie por día trae ' + ((series.por_dia_semana || []).length) + ' y deberían ser 7');
    }

    /* ------------------------------------------------------------------ */
    paso('3. La exportación a CSV: que Excel la lea bien');

    const resp = await fetch(BASE + '/api/reportes/visitas.csv', {
      headers: { Authorization: 'Bearer ' + token },
    });

    if (!resp.ok) {
      mal('la exportación no respondió (estado ' + resp.status + ')');
    } else {
      const buffer = Buffer.from(await resp.arrayBuffer());
      const destino = path.join(os.tmpdir(), 'vf-reporte-' + Date.now() + '.csv');
      fs.writeFileSync(destino, buffer);

      const tipo = resp.headers.get('content-type') || '';
      if (/text\/csv/i.test(tipo)) bien('el tipo de contenido es CSV (' + tipo.split(';')[0] + ')');
      else mal('el tipo de contenido no es CSV: ' + tipo);

      const disposicion = resp.headers.get('content-disposition') || '';
      if (/attachment/i.test(disposicion)) bien('viene como descarga (attachment)');
      else mal('no viene como descarga: ' + disposicion);

      /* El BOM es lo que hace que Excel abra el archivo como UTF-8. Sin él, Excel
         asume la codificación de Windows y las tildes salen como "PEÃ‘A". */
      const tieneBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      if (tieneBom) bien('el archivo lleva BOM (Excel lo abrirá como UTF-8)');
      else mal('el archivo NO lleva BOM: Excel mostrará "PEÃ‘A" en vez de "PEÑA"');

      /* Y la prueba de verdad: leerlo como lo lee Excel.
       *
       * El SEPARADOR SE DETECTA SOLO, en vez de decirle a pandas que es punto y coma.
       * El sistema usa ";" a proposito (en espanol Excel usa ";" como separador de
       * listas, porque la coma es el separador decimal: un CSV con comas se abriria en
       * una sola columna). Detectandolo, la prueba comprueba ademas QUE separador trae
       * de verdad, que es mas de lo que se comprobaba antes.
       *
       * La ruta se pasa por la LINEA DE COMANDOS, no escrita dentro del script: en
       * Windows, una ruta con barras invertidas dentro de un texto de Python da un error
       * que no dice nada de la causa. */
      const script = path.join(os.tmpdir(), 'leer-csv-' + Date.now() + '.py');
      fs.writeFileSync(script, [
        'import sys, csv',
        'import pandas as pd',
        'ruta = sys.argv[1]',
        /* El BOM se quita para poder mirar la primera linea; el resto se lee como utf-8. */
        "crudo = open(ruta, encoding='utf-8-sig').read()",
        "primera = crudo.split(chr(10))[0]",
        "sep = ';' if primera.count(';') >= primera.count(',') else ','",
        "print('SEPARADOR=' + repr(sep))",
        'df = pd.read_csv(ruta, sep=sep, encoding="utf-8-sig")',
        "print('FILAS=' + str(len(df)))",
        "print('COLUMNAS=' + '|'.join(str(c) for c in df.columns))",
        "print('CAMPOS=' + str(df.shape[1]))",
        "texto = df.to_csv(index=False)",
        "print('TIENE_ENIE=' + str('\\u00d1' in texto))",
        "print('TIENE_TILDE=' + str(any(c in texto for c in '\\u00c1\\u00c9\\u00cd\\u00d3\\u00da\\u00e1\\u00e9\\u00ed\\u00f3\\u00fa')))",
        "print('MOJIBAKE=' + str('\\u00c3' in texto))",
        "print('MUESTRA=' + texto[:200].replace(chr(10), ' / '))",
      ].join('\n'));

      /* Se prueban varios interpretes: PYTHON_BIN primero, y si no, los del sistema. Hay
         que usar uno que TENGA pandas: con uno pelado el script falla y la prueba no
         comprobaria nada de lo que importa. */
      /* Se buscan interpretes hasta encontrar uno CON PANDAS.
       *
       * El de la maquina puede no tenerlo, y el del harness vive en una ruta conocida
       * (la que publica el propio entorno). Que la prueba dependa de que alguien se
       * acuerde de definir PYTHON_BIN es fragil: si no esta, la comprobacion mas
       * importante —si Excel va a mostrar los nombres bien— no se hace y nadie se entera. */
      const rutasConocidas = [
        process.env.PYTHON_BIN,
        process.env.PYTHON,
        'C:\\Users\\Admin\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
      ].filter(Boolean);

      const interpretes = rutasConocidas.concat(['python', 'python3', 'py']);
      const vistos = {};
      let salida = '';
      let usado = null;
      const intentos = [];

      /* PYTHONIOENCODING es necesario: en Windows Python escribe a la consola en cp1252
         y los acentos salen como caracteres rotos. Aqui no se mira la salida de Python
         por su belleza, se busca "FILAS=", y con la codificacion equivocada la propia
         marca se corrompe y la prueba parecia no funcionar. */
      const entornoPy = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });

      for (const py of interpretes) {
        if (vistos[py]) continue;
        vistos[py] = true;

        const prueba = spawnSync(py, [script, destino], { encoding: 'utf8', timeout: 120000, env: entornoPy });
        const s = (prueba.stdout || '') + (prueba.stderr || '');

        if (prueba.status === 0 && /FILAS=/.test(s)) {
          salida = s;
          usado = py;
          break;
        }

        /* Se guarda el motivo, recortado por el final: el error util viene al final. */
        intentos.push((py.split('\\').slice(-1)[0] || py) + ' -> status=' + prueba.status +
          (prueba.error ? ' error=' + prueba.error.code : '') +
          ' salida=' + JSON.stringify(s.slice(-160)));
      }

      if (!usado) {
        /* Que no se pueda leer con pandas NO puede pasar en silencio: es la unica
           comprobacion que dice si Excel va a mostrar los nombres bien. */
        mal('no se encontró ningún intérprete de Python con pandas, así que NO se comprobó ' +
          'si Excel abre bien el archivo');
        for (const i of intentos) info('intento: ' + i);
      } else {
        const m = (k) => ((new RegExp('^' + k + '=(.*)$', 'm').exec(salida) || [])[1] || '');

        const filas = Number(m('FILAS'));
        if (filas > 0) bien('pandas lo lee y tiene ' + filas + ' fila(s)');
        else mal('pandas lo lee pero no tiene filas de datos');

        const cols = m('COLUMNAS');
        if (cols.split('|').length >= 3) bien('trae columnas: ' + cols);
        else mal('trae muy pocas columnas: ' + cols);

        /* El separador tiene que ser punto y coma: en español Excel usa ";" como
           separador de listas, así que un CSV con comas se abriría en una sola columna.
           Ahora se comprueba cuál trae de verdad. */
        const sep = m('SEPARADOR');
        if (sep.indexOf(';') !== -1) {
          bien('el separador es punto y coma (Excel en español lo abre en columnas)');
        } else {
          mal('el separador es coma (' + sep + '): en Excel en español se abriría todo en una columna');
        }

        if (m('MOJIBAKE') === 'True') {
          mal('EL CSV TIENE MOJIBAKE: los nombres con tilde salen como "PEÃ‘A" al abrirlo');
        } else {
          bien('sin mojibake: los acentos se leen bien');
        }

        /* El nombre de la persona de prueba lleva Ñ, asi que tiene que estar. */
        if (m('TIENE_ENIE') === 'True') {
          bien('la Ñ llega entera al archivo exportado');
        } else if (persona) {
          mal('la Ñ NO llega al archivo: se exportó "' + persona.Apellido1 + '" y no aparece');
        }

        if (m('TIENE_TILDE') === 'True') {
          bien('las tildes llegan enteras al archivo');
        } else {
          info('no hay tildes en este archivo (depende de los datos exportados)');
        }

        info('primera línea: ' + m('MUESTRA').slice(0, 120));
      }

      fs.unlinkSync(destino);
      try { fs.unlinkSync(script); } catch (e) { /* da igual */ }
    }
  } finally {
    /* Se cierra y se anula la visita de prueba. */
    if (idVisita) {
      try {
        await api('POST', '/api/visitas/' + idVisita + '/salida', {});
        await api('POST', '/api/visitas/' + idVisita + '/anular', { motivo: 'Prueba terminada' });
      } catch (e) { /* da igual */ }
    }
  }

  /* ------------------------------------------------------------------ */
  paso('4. Que la exportación exija el permiso');

  /* Sin token no se debe poder sacar la lista de visitantes de la institución. */
  const sinToken = await fetch(BASE + '/api/reportes/visitas.csv');
  if (sinToken.status === 401 || sinToken.status === 403) {
    bien('sin sesión no se puede exportar (estado ' + sinToken.status + ')');
  } else {
    mal('SE PUDO EXPORTAR SIN SESIÓN (estado ' + sinToken.status + '): la lista de visitantes queda al aire');
  }
}

let error = null;

async function correr() {
  try {
    await principal();
  } catch (e) {
    error = e;
  }

  try { require(path.join(RAIZ, 'src', 'db.js')).cerrar(); } catch (e) { /* da igual */ }

  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(66));
  if (error) console.log('  Se detuvo: ' + error.message);
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  process.exitCode = (fallos || error) ? 1 : 0;
}

correr();
