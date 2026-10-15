/**
 * VisitaFlow - Creacion de la vista de ciudadanos en la base de cedulas.
 *
 *   node sql/03-vista-ciudadanos.js
 *
 * La base del padron ligero guarda los codigos (sexo, estado civil, ocupacion,
 * nacionalidad, municipio) y sus catalogos en tablas aparte. Eso esta bien para
 * almacenar, pero no para consultar: el sistema no deberia tener que repetir
 * cinco JOIN cada vez que valida una cedula.
 *
 * Esta vista resuelve los codigos a texto y deja una INTERFAZ ESTABLE:
 *
 *     dbo.CIUDADANOS (Cedula, Nombres, Apellido1, Apellido2, FechaNacimiento,
 *                     Sexo, EstadoCivil, Nacionalidad, Ocupacion, Municipio,
 *                     Provincia, Zona, Region)
 *
 * Si manana cambia el esquema del padron, se ajusta ESTA vista y el sistema no
 * se entera. Es de solo lectura y se crea en la base del padron ligero, no en
 * la del padron original.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

/* La vista se define con los nombres reales del padron. Se comprueba que existan
   las columnas antes de crearla, para no dejar una vista rota si el padron tiene
   otro esquema.

   Tres detalles que costaron encontrar:

   1. Los catalogos del padron no siguen un nombre uniforme: unos usan ID y otros
      Id, unos Descripcion y otros Nombre. Los JOIN van con las columnas exactas
      de cada uno.

   2. Hay un conflicto de intercalaciones (collations) entre las tablas: el
      padron usa SQL_AltDiction_CP850_CI_AI y los catalogos
      Modern_Spanish_CI_AS. Sin COLLATE explicito, SQL Server no puede comparar
      las columnas y la vista ni se crea. Se convierte SIEMPRE el lado del
      catalogo, no el del padron, para no perder el indice de la cedula.

   3. El padron es de solo lectura: la vista se crea con CREATE OR ALTER VIEW y
      no toca ningun dato.
*/
const COLLATION = 'SQL_AltDiction_CP850_CI_AI';

const SQL_VISTA = `
CREATE OR ALTER VIEW dbo.CIUDADANOS AS
SELECT
    p.Cedula,
    p.Nombres,
    p.Apellido1,
    p.Apellido2,
    p.FechaNacimiento,
    p.LugarNacimiento,
    s.Descripcion   AS Sexo,
    p.IdSexo,
    ec.Descripcion  AS EstadoCivil,
    p.IdEstadoCivil,
    cat.Descripcion AS Categoria,
    p.IDCategoria,
    n.Descripcion   AS Nacionalidad,
    p.IDNacionalidad,
    o.Descripcion   AS Ocupacion,
    p.IdOcupacion,
    m.Descripcion   AS Municipio,
    p.IDMunicipio,
    pr.Descripcion  AS Provincia,
    pr.ZONA         AS Zona,
    r.Descripcion   AS Region,
    p.CedulaAnterior
FROM dbo.PADRON p
LEFT JOIN dbo.Sexo          s   ON s.IdSexo   COLLATE ${COLLATION} = p.IdSexo
LEFT JOIN dbo.EstadoCivil   ec  ON ec.Id      COLLATE ${COLLATION} = p.IdEstadoCivil
LEFT JOIN dbo.Categoria     cat ON cat.ID     = p.IDCategoria
LEFT JOIN dbo.Nacionalidad  n   ON n.ID       = p.IDNacionalidad
LEFT JOIN dbo.Ocupacion     o   ON o.ID       = p.IdOcupacion
LEFT JOIN dbo.Municipio     m   ON m.ID       = p.IDMunicipio
LEFT JOIN dbo.Provincia     pr  ON pr.ID      = m.IDProvincia
LEFT JOIN dbo.Region        r   ON r.ID       = pr.Region
`;

async function principal() {
  const cfg = config.bd.padron;
  console.log('');
  console.log('  Base de cedulas: ' + cfg.server + '/' + cfg.database);
  console.log('');

  const pool = await new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  // Comprobar que existan la tabla y las columnas que la vista necesita.
  const requeridas = {
    PADRON: ['Cedula', 'Nombres', 'Apellido1', 'Apellido2', 'FechaNacimiento', 'LugarNacimiento', 'IdSexo', 'IdEstadoCivil', 'IDCategoria', 'IdOcupacion', 'IDNacionalidad', 'IDMunicipio', 'CedulaAnterior'],
    Sexo: ['IdSexo', 'Descripcion'],
    EstadoCivil: ['Id', 'Descripcion'],
    Categoria: ['ID', 'Descripcion'],
    Nacionalidad: ['ID', 'Descripcion'],
    Ocupacion: ['ID', 'Descripcion'],
    Municipio: ['ID', 'Descripcion', 'IDProvincia'],
    Provincia: ['ID', 'Descripcion', 'ZONA', 'Region'],
    Region: ['ID', 'Descripcion'],
  };

  const faltantes = [];
  for (const [tabla, columnas] of Object.entries(requeridas)) {
    const r = await pool
      .request()
      .input('tabla', sql.NVarChar(128), tabla)
      .query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tabla');
    if (!r.recordset.length) {
      faltantes.push('falta la tabla ' + tabla);
      continue;
    }
    const existentes = r.recordset.map((c) => c.COLUMN_NAME.toLowerCase());
    for (const c of columnas) {
      if (!existentes.includes(c.toLowerCase())) faltantes.push('falta ' + tabla + '.' + c);
    }
  }

  if (faltantes.length) {
    console.error('  No se puede crear la vista. El padron no tiene la forma esperada:');
    for (const f of faltantes) console.error('    - ' + f);
    console.error('');
    console.error('  Ajuste la vista en sql/03-vista-ciudadanos.js a los nombres reales.');
    console.error('');
    await pool.close();
    process.exit(1);
  }

  await pool.request().batch(SQL_VISTA);
  console.log('  Vista dbo.CIUDADANOS creada (o actualizada).');

  // Comprobar que responde y que resuelve los codigos.
  const n = await pool.request().query('SELECT COUNT_BIG(*) AS n FROM dbo.CIUDADANOS');
  console.log('  Filas en la vista: ' + n.recordset[0].n);

  const inicio = Date.now();
  const muestra = await pool
    .request()
    .input('cedula', sql.VarChar(11), '00100000017')
    .query('SELECT TOP 2 Cedula, Nombres, Apellido1, Apellido2, FechaNacimiento, Sexo, EstadoCivil, Categoria, Nacionalidad, Ocupacion, Municipio, Provincia, Region FROM dbo.CIUDADANOS WHERE Cedula >= @cedula ORDER BY Cedula');
  const ms = Date.now() - inicio;

  if (muestra.recordset.length) {
    console.log('');
    console.log('  Consulta de prueba por cedula: ' + ms + ' ms');
    for (const f of muestra.recordset) {
      console.log('    ' + f.Cedula + '  ' + f.Nombres + ' ' + f.Apellido1 + ' ' + (f.Apellido2 || ''));
      console.log('      Nacimiento: ' + String(f.FechaNacimiento).slice(0, 10) + '   Sexo: ' + f.Sexo + '   Estado civil: ' + f.EstadoCivil + '   Categoría: ' + f.Categoria);
      console.log('      Nacionalidad: ' + f.Nacionalidad + '   Ocupación: ' + f.Ocupacion);
      console.log('      Municipio: ' + f.Municipio + '   Provincia: ' + f.Provincia + '   Región: ' + f.Region);
    }
  } else {
    console.log('  No se pudo leer ninguna fila de la vista.');
  }

  console.log('');
  await pool.close();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
