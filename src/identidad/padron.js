/**
 * VisitaFlow - Consulta de cedulas contra el padron ligero.
 *
 * El padron ligero tiene SOLO datos de identidad: cedula, nombres, apellidos,
 * fechas, sexo, estado civil, nacionalidad, ocupacion y municipio. NO tiene
 * fotografias, y esa es la razon de que quepa en un VPS.
 *
 * Reglas que se respetan aqui:
 *   - Solo lectura. Nunca se escribe en la base del padron.
 *   - Los parametros de texto se declaran como VARCHAR, no NVARCHAR: si el
 *     driver manda NVARCHAR contra una columna VARCHAR, SQL Server no puede
 *     usar el indice y la consulta pasa de milisegundos a segundos.
 *   - Si el padron no esta disponible, el sistema NO se cae: devuelve
 *     disponible:false y recepcion sigue trabajando a mano.
 */
'use strict';

const config = require('../config');
const bd = require('../db');
const util = require('../util');

/** Limpia una cedula: deja solo digitos. */
function soloDigitos(texto) {
  return String(texto || '').replace(/\D/g, '');
}

/** Valida el digito verificador de la cedula dominicana. */
function validarCedula(cedula) {
  const d = soloDigitos(cedula);
  if (d.length !== 11) return { valida: false, motivo: 'La cédula debe tener 11 dígitos.' };
  if (/^0+$/.test(d)) return { valida: false, motivo: 'La cédula no puede ser todo ceros.' };

  const pesos = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) {
    let v = Number(d[i]) * pesos[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    suma += v;
  }
  const decena = Math.ceil(suma / 10) * 10;
  const esperado = decena - suma === 10 ? 0 : decena - suma;

  if (esperado !== Number(d[10])) {
    return { valida: false, motivo: 'El dígito verificador no corresponde.' };
  }
  return { valida: true };
}

/** Formatea la cedula como 001-1234567-8. */
function formatear(cedula) {
  const d = soloDigitos(cedula);
  if (d.length !== 11) return String(cedula || '');
  return d.slice(0, 3) + '-' + d.slice(3, 10) + '-' + d.slice(10);
}

/** Edad a partir de la fecha de nacimiento. */
function edad(fechaNacimiento) {
  if (!fechaNacimiento) return null;
  const n = new Date(fechaNacimiento);
  if (Number.isNaN(n.getTime())) return null;
  const hoy = new Date();
  let e = hoy.getFullYear() - n.getFullYear();
  const m = hoy.getMonth() - n.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < n.getDate())) e--;
  return e;
}

/**
 * Normaliza el sexo a una sola letra.
 *
 * El padron no es uniforme: la tabla base guarda el codigo ("F"/"M"), pero las
 * vistas suelen traer la descripcion completa ("FEMENINO"/"MASCULINO"). Si eso
 * llegara tal cual a la columna de la visita, SQL Server lo cortaria y fallaria
 * el registro. Aqui se reduce a M o F, que es lo que el sistema usa.
 */
function normalizarSexo(valor) {
  const t = String(valor || '').trim().toUpperCase();
  if (!t) return null;
  if (t === 'F' || t.startsWith('FEM') || t === 'MUJER') return 'F';
  if (t === 'M' || t.startsWith('MAS') || t === 'HOMBRE') return 'M';
  return t.slice(0, 1);
}

/** Arma la respuesta publica a partir de una fila del padron. */
function comoCiudadano(fila) {
  if (!fila) return null;
  const nombres = (fila.Nombres || '').trim();
  const apellidos = [fila.Apellido1, fila.Apellido2].filter(Boolean).join(' ').trim();
  const completo = [nombres, apellidos].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  return {
    cedula: soloDigitos(fila.Cedula),
    cedula_formato: formatear(fila.Cedula),
    nombres: config.identidad.mostrarNombres ? nombres : null,
    apellidos: config.identidad.mostrarNombres ? apellidos : null,
    nombre_completo: config.identidad.mostrarNombres ? completo : null,
    fecha_nacimiento: config.identidad.mostrarFechaNacimiento && fila.FechaNacimiento ? util.fechaISO(fila.FechaNacimiento) : null,
    edad: config.identidad.mostrarFechaNacimiento ? edad(fila.FechaNacimiento) : null,
    sexo: config.identidad.mostrarSexo ? normalizarSexo(fila.Sexo) : null,
    estado_civil: util.limpiar(fila.EstadoCivil, 40),
    nacionalidad: util.limpiar(fila.Nacionalidad, 80),
    ocupacion: util.limpiar(fila.Ocupacion, 120),
    municipio: config.identidad.mostrarMunicipio ? util.limpiar(fila.Municipio, 120) : null,
    provincia: config.identidad.mostrarMunicipio ? util.limpiar(fila.Provincia, 120) : null,
    en_padron: true,
  };
}

/** Columnas que se leen del padron ligero. */
const COLUMNAS = 'Cedula, Nombres, Apellido1, Apellido2, FechaNacimiento, Sexo, EstadoCivil, Nacionalidad, Ocupacion, Municipio, Provincia';

/** Nombre calificado de la tabla, sin permitir inyeccion desde la configuracion. */
function tabla() {
  const t = config.bd.tablaPadron;
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    throw new Error('PADRON_TABLA no tiene el formato esquema.tabla: ' + t);
  }
  return t;
}

/**
 * Busca por cedula exacta.
 * @returns {{disponible:boolean, encontrado:boolean, ciudadano?:object, motivo?:string}}
 */
async function porCedula(cedula) {
  const d = soloDigitos(cedula);
  if (d.length !== 11) {
    return { disponible: true, encontrado: false, motivo: 'La cédula debe tener 11 dígitos.', ciudadano: null };
  }

  const salud = bd.saludPadron();
  if (!salud.disponible) {
    return { disponible: false, encontrado: false, ciudadano: null, motivo: 'La base de cédulas no está disponible.' };
  }

  try {
    // Se prueban las dos formas: con guiones y sin guiones. El padron guarda la
    // cedula en un solo formato, pero no todos los respaldos coinciden.
    const r = await bd.consultarPadron(
      `SELECT TOP 1 ${COLUMNAS} FROM ${tabla()} WHERE Cedula = @cedula`,
      { cedula: d },
      { tipos: { cedula: bd.tipos.varChar(11) }, espera: config.bd.msEsperaPadron }
    );

    if (!r.recordset.length) {
      const conGuiones = formatear(d);
      const r2 = await bd.consultarPadron(
        `SELECT TOP 1 ${COLUMNAS} FROM ${tabla()} WHERE Cedula = @cedula`,
        { cedula: conGuiones },
        { tipos: { cedula: bd.tipos.varChar(20) }, espera: config.bd.msEsperaPadron }
      );
      if (!r2.recordset.length) {
        return {
          disponible: true,
          encontrado: false,
          ciudadano: null,
          motivo: 'Esa cédula no aparece en la base de datos.',
        };
      }
      return { disponible: true, encontrado: true, ciudadano: comoCiudadano(r2.recordset[0]) };
    }

    return { disponible: true, encontrado: true, ciudadano: comoCiudadano(r.recordset[0]) };
  } catch (e) {
    return { disponible: false, encontrado: false, ciudadano: null, motivo: 'Error al consultar la base de cédulas: ' + e.message };
  }
}

/**
 * Busca por nombre o apellido. Exige que TODAS las palabras aparezcan (en los
 * nombres o en cualquiera de los apellidos): es lo que permite encontrar
 * "ABREU GUZMAN" cuando el apellido esta partido en dos columnas.
 */
async function porNombre(texto, limite) {
  const terminos = String(texto || '')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 4);

  if (!terminos.length) {
    return { disponible: true, resultados: [], motivo: 'Escriba al menos dos letras.' };
  }

  const salud = bd.saludPadron();
  if (!salud.disponible) {
    return { disponible: false, resultados: [], motivo: 'La base de cédulas no está disponible.' };
  }

  const condiciones = [];
  const parametros = {};
  terminos.forEach((t, i) => {
    parametros['t' + i] = '%' + t.toUpperCase() + '%';
    condiciones.push(
      `(UPPER(Nombres) LIKE @t${i} OR UPPER(Apellido1) LIKE @t${i} OR UPPER(Apellido2) LIKE @t${i})`
    );
  });

  const tipos = {};
  terminos.forEach((t, i) => (tipos['t' + i] = bd.tipos.varChar(60)));

  try {
    /* LA BASE BUSCA UN SOLO TERMINO, y los demas se filtran aqui.
     *
     * Esto no es una optimizacion: es que la otra forma NO FUNCIONA. Exigir en la
     * base que coincidan todos los terminos obliga a recorrer los 7,8 millones de
     * registros, porque ninguna de esas condiciones puede usar un indice (el UPPER
     * envuelve la columna y el comodin inicial impide buscar por prefijo).
     *
     * Medido con "ABREU GUZMAN", que es justo lo que escribe un recepcionista
     * (nombre y apellido): la consulta con los dos terminos NO TERMINA, revienta el
     * tiempo de espera de 15 segundos y la busqueda falla entera. El recepcionista
     * ve "la base de cedulas no esta disponible" y no encuentra a nadie.
     *
     * Buscando el termino MAS LARGO (que es el mas selectivo: el apellido suele ser
     * mas largo y mas distintivo que el nombre) la base devuelve candidatos enseguida
     * y el filtro del resto se hace aqui, sobre decenas de filas.
     *
     * Se piden mas candidatos que el limite pedido (4 veces, hasta 200) para que al
     * filtrar queden suficientes. */
    const ordenados = terminos.slice().sort((a, b) => b.length - a.length);
    const principal = ordenados[0];
    const resto = ordenados.slice(1);

    const iPrincipal = terminos.indexOf(principal);

    /* Cuantos candidatos se piden a la base.
     *
     * Es un equilibrio: mas candidatos dan mejores resultados al filtrar, pero
     * cuestan mas cuando el termino es comun. Con "JUAN CARLOS" el termino largo es
     * CARLOS, que es muy comun: con 80 candidatos solo quedaban 9 resultados de 20.
     * Con 400 quedan los 20 y sigue siendo rapido, porque la base se detiene en
     * cuanto junta 400 coincidencias, y con un termino comun las junta enseguida. */
    const tope = Math.min(Math.max(Number(limite) || 20, 1), 50);
    const candidatos = Math.min(Math.max(tope * 20, 100), 400);

    /* Tampoco se ordena en la base: ORDER BY se aplica a TODAS las filas que pasan
       el WHERE antes de quedarse con las primeras. Con un apellido comun como
       RODRIGUEZ (235.463 personas), eso eran 11 segundos para devolver 20 filas.
       Se ordena aqui abajo, sobre 20 filas. */
    const r = await bd.consultarPadron(
      `SELECT TOP ${candidatos} ${COLUMNAS}
         FROM ${tabla()}
        WHERE ${condiciones[iPrincipal]}`,
      { ['t' + iPrincipal]: parametros['t' + iPrincipal] },
      { tipos: { ['t' + iPrincipal]: tipos['t' + iPrincipal] }, espera: config.bd.msEsperaPadron }
    );

    /* El filtro del resto de los terminos, sobre las filas que ya vinieron. */
    const normalizar = (f) => ((f.Nombres || '') + ' ' + (f.Apellido1 || '') + ' ' + (f.Apellido2 || '')).toUpperCase();

    const filtradas = resto.length
      ? r.recordset.filter((f) => {
          const todo = normalizar(f);
          return resto.every((t) => todo.indexOf(t.toUpperCase()) !== -1);
        })
      : r.recordset;

    const filas = filtradas.slice(0, tope).sort((a, b) => {
      const ap = String(a.Apellido1 || '').localeCompare(String(b.Apellido1 || ''), 'es');
      if (ap !== 0) return ap;
      const ap2 = String(a.Apellido2 || '').localeCompare(String(b.Apellido2 || ''), 'es');
      if (ap2 !== 0) return ap2;
      return String(a.Nombres || '').localeCompare(String(b.Nombres || ''), 'es');
    });

    return { disponible: true, resultados: filas.map(comoCiudadano), motivo: null };
  } catch (e) {
    return { disponible: false, resultados: [], motivo: 'Error al consultar la base de cédulas: ' + e.message };
  }
}

/**
 * Resuelve la identidad de alguien que se esta registrando.
 * Devuelve el ciudadano si esta en el padron, o un objeto "manual" si no lo
 * esta y la configuracion permite continuar.
 */
async function resolver({ cedula, nombres, apellidos }) {
  const digitos = soloDigitos(cedula);
  const revision = validarCedula(digitos);

  if (!revision.valida) {
    return {
      ok: false,
      origen: 'invalida',
      motivo: revision.motivo,
      ciudadano: null,
    };
  }

  const consulta = await porCedula(digitos);

  if (consulta.disponible && consulta.encontrado) {
    return { ok: true, origen: 'padron', motivo: null, ciudadano: consulta.ciudadano };
  }

  const motivo = consulta.disponible
    ? 'La cédula no está en la base de datos.'
    : 'La base de cédulas no está disponible en este momento.';

  if (config.identidad.exigirEnPadron) {
    return { ok: false, origen: 'no_encontrado', motivo, ciudadano: null };
  }

  // Se permite continuar con los datos escritos a mano, pero queda marcado que
  // NO fueron verificados contra el padron.
  return {
    ok: true,
    origen: 'manual',
    motivo,
    ciudadano: {
      cedula: digitos,
      cedula_formato: formatear(digitos),
      nombres: nombres || null,
      apellidos: apellidos || null,
      nombre_completo: [nombres, apellidos].filter(Boolean).join(' ').trim() || null,
      fecha_nacimiento: null,
      edad: null,
      sexo: null,
      estado_civil: null,
      nacionalidad: null,
      ocupacion: null,
      municipio: null,
      provincia: null,
      en_padron: false,
    },
  };
}

/** Estado del padron para la pantalla de salud del sistema. */
function estado() {
  const salud = bd.saludPadron();
  return {
    activo: config.bd.padronActivo,
    disponible: salud.disponible,
    motivo: salud.motivo,
    base: config.bd.padron.database,
    tabla: config.bd.tablaPadron,
    exigir_en_padron: config.identidad.exigirEnPadron,
    muestra: {
      nombres: config.identidad.mostrarNombres,
      fecha_nacimiento: config.identidad.mostrarFechaNacimiento,
      sexo: config.identidad.mostrarSexo,
      municipio: config.identidad.mostrarMunicipio,
    },
  };
}

module.exports = {
  soloDigitos,
  validarCedula,
  formatear,
  edad,
  porCedula,
  porNombre,
  resolver,
  estado,
  COLUMNAS,
};
