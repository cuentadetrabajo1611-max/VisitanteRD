/**
 * VisitaFlow - Pruebas del nucleo de licenciamiento.
 *
 *   node sql/91-pruebas-licencias.js
 *
 * Comprueba lo que de verdad importa: que la firma se verifique, que una
 * licencia alterada se rechace, que el vencimiento y la gracia se calculen bien
 * y que una licencia amarrada a otra maquina no sirva aqui.
 *
 * No necesita base de datos ni servidor en marcha.
 */
'use strict';

const path = require('path');
const lic = require(path.resolve(__dirname, '..', 'src', 'licencias', 'licencia.js'));

let ok = 0;
let fallos = 0;

function prueba(nombre, fn) {
  try {
    fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condicion no cumplida');
}

function esperarLanza(fn, fragmento) {
  try {
    fn();
  } catch (e) {
    if (fragmento && !String(e.message).toLowerCase().includes(fragmento.toLowerCase())) {
      throw new Error('lanzo, pero con otro mensaje: ' + e.message);
    }
    return;
  }
  throw new Error('se esperaba un error y no lanzo nada');
}

const dias = (n) => new Date(Date.now() + n * 86400000).toISOString();

console.log('\n=== VisitaFlow: pruebas de licenciamiento ===\n');

console.log('Llaves');
prueba('la llave publica tiene un key_id de 16 caracteres', () => {
  const id = lic.keyId();
  esperar(typeof id === 'string' && id.length === 16, 'key_id inesperado: ' + id);
});

console.log('\nEmision y verificacion');
const texto = lic.firmar({
  tenant: 'junta-prueba',
  tenant_nombre: 'Junta de Vecinos de Prueba',
  cliente: 'Junta de Vecinos de Prueba',
  desde: new Date().toISOString(),
  hasta: dias(365),
  tipo: 'anual',
  modulos: ['registro', 'recepcion', 'gafetes'],
  limites: { usuarios: 3, instalaciones: 1 },
});

prueba('la licencia emitida tiene cabecera y pie', () => {
  esperar(texto.startsWith(lic.CABECERA), 'falta la cabecera');
  esperar(texto.trim().endsWith(lic.PIE), 'falta el pie');
});

prueba('la firma se verifica con la llave publica', () => {
  const c = lic.verificarFirma(texto);
  esperar(c.tenant === 'junta-prueba', 'tenant incorrecto');
});

prueba('el contenido sobrevive al viaje de ida y vuelta', () => {
  const c = lic.verificarFirma(texto);
  esperar(c.limites.usuarios === 3, 'limite de usuarios incorrecto');
  esperar(c.modulos.length === 3, 'modulos incorrectos');
  esperar(c.tipo === 'anual', 'tipo incorrecto');
});

console.log('\nManipulacion (lo importante)');
prueba('cambiar la fecha en el contenido rompe la firma', () => {
  const cuerpo = texto
    .replace(lic.CABECERA, '')
    .replace(lic.PIE, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('');
  const [carga, firma] = cuerpo.split('.');
  const contenido = JSON.parse(lic.deBase64Url(carga).toString('utf8'));
  contenido.hasta = dias(3650); // el cliente intenta darse 10 anios mas
  const nuevaCarga = lic.aBase64Url(Buffer.from(JSON.stringify(contenido), 'utf8'));
  const alterada = lic.CABECERA + '\n' + nuevaCarga + '.' + firma + '\n' + lic.PIE + '\n';
  esperarLanza(() => lic.verificarFirma(alterada), 'firma');
});

prueba('habilitar un modulo a mano rompe la firma', () => {
  const cuerpo = texto.replace(lic.CABECERA, '').replace(lic.PIE, '').split('\n').map((l) => l.trim()).filter(Boolean).join('');
  const [carga, firma] = cuerpo.split('.');
  const contenido = JSON.parse(lic.deBase64Url(carga).toString('utf8'));
  contenido.modulos.push('api');
  const nuevaCarga = lic.aBase64Url(Buffer.from(JSON.stringify(contenido), 'utf8'));
  esperarLanza(() => lic.verificarFirma(lic.CABECERA + '\n' + nuevaCarga + '.' + firma + '\n' + lic.PIE), 'firma');
});

prueba('una licencia de otro emisor es rechazada', () => {
  const crypto = require('crypto');
  const otroPar = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const falsa = lic.firmar(
    { tenant: 'pirata', cliente: 'Pirata', desde: new Date().toISOString(), hasta: dias(365) },
    { llavePrivada: otroPar.privateKey }
  );
  esperarLanza(() => lic.verificarFirma(falsa), 'firma');
});

prueba('un archivo sin formato es rechazado con un mensaje claro', () => {
  esperarLanza(() => lic.verificarFirma('hola mundo'), 'formato');
});

prueba('un archivo vacio es rechazado', () => {
  esperarLanza(() => lic.verificarFirma(''), 'vac');
});

console.log('\nVigencia');
prueba('una licencia vigente se evalua como activa o por vencer', () => {
  const e = lic.evaluar(texto);
  esperar(e.valida, 'deberia ser valida: ' + e.estado);
  esperar(['activa', 'por_vencer'].includes(e.estado), 'estado raro: ' + e.estado);
  esperar(e.dias_restantes > 300, 'dias restantes raros: ' + e.dias_restantes);
});

prueba('una licencia vencida ayer queda en gracia, no bloqueada', () => {
  const t = lic.firmar({
    tenant: 'x', cliente: 'X', desde: dias(-400), hasta: dias(-1), gracia_dias: 15,
  });
  const e = lic.evaluar(t);
  esperar(e.estado === 'gracia', 'estado: ' + e.estado);
  esperar(e.valida, 'durante la gracia debe poder operar');
  esperar(e.en_gracia, 'deberia marcar en_gracia');
});

prueba('pasada la gracia queda vencida y no valida', () => {
  const t = lic.firmar({
    tenant: 'x', cliente: 'X', desde: dias(-400), hasta: dias(-30), gracia_dias: 15,
  });
  const e = lic.evaluar(t);
  esperar(e.estado === 'vencida', 'estado: ' + e.estado);
  esperar(!e.valida, 'no deberia ser valida');
  esperar(e.vencida, 'deberia marcar vencida');
});

prueba('una licencia que aun no entra en vigencia se detecta', () => {
  const t = lic.firmar({ tenant: 'x', cliente: 'X', desde: dias(10), hasta: dias(400) });
  const e = lic.evaluar(t);
  esperar(e.estado === 'no_vigente', 'estado: ' + e.estado);
  esperar(!e.valida, 'no deberia ser valida todavia');
});

prueba('avisa cuando esta por vencer', () => {
  const t = lic.firmar({ tenant: 'x', cliente: 'X', desde: dias(-300), hasta: dias(10) });
  const e = lic.evaluar(t);
  esperar(e.estado === 'por_vencer', 'estado: ' + e.estado);
  esperar(e.valida, 'una licencia por vencer sigue sirviendo');
});

prueba('el periodo de gracia es configurable', () => {
  const t = lic.firmar({ tenant: 'x', cliente: 'X', desde: dias(-100), hasta: dias(-20), gracia_dias: 60 });
  const e = lic.evaluar(t);
  esperar(e.estado === 'gracia', 'con 60 dias de gracia deberia seguir en gracia: ' + e.estado);
});

console.log('\nAmarre a un equipo');
const huellaA = 'abc123def456';
prueba('una licencia sin huella sirve en cualquier equipo', () => {
  const e = lic.evaluar(texto, { huella: 'cualquiera' });
  esperar(e.valida, 'deberia ser valida');
});

prueba('una licencia con huella sirve en su equipo', () => {
  const t = lic.firmar({ tenant: 'x', cliente: 'X', desde: dias(-1), hasta: dias(300), huella: huellaA });
  const e = lic.evaluar(t, { huella: huellaA });
  esperar(e.valida, 'deberia ser valida en su equipo: ' + e.estado);
  esperar(e.huella_ok, 'huella_ok deberia ser true');
});

prueba('una licencia con huella NO sirve en otro equipo', () => {
  const t = lic.firmar({ tenant: 'x', cliente: 'X', desde: dias(-1), hasta: dias(300), huella: huellaA });
  const e = lic.evaluar(t, { huella: 'otra-maquina-999' });
  esperar(!e.valida, 'no deberia ser valida en otro equipo');
  esperar(e.estado === 'otro_equipo', 'estado: ' + e.estado);
});

console.log('\nValidaciones de emision');
prueba('no se puede emitir sin cliente', () => {
  esperarLanza(() => lic.firmar({ tenant: 'x', hasta: dias(30) }), 'cliente');
});
prueba('no se puede emitir con fecha invalida', () => {
  esperarLanza(() => lic.firmar({ tenant: 'x', cliente: 'X', hasta: 'no-es-fecha' }), 'hasta');
});
prueba('no se puede emitir con hasta anterior a desde', () => {
  esperarLanza(() => lic.firmar({ tenant: 'x', cliente: 'X', desde: dias(30), hasta: dias(10) }), 'posterior');
});
prueba('no se puede emitir con un modulo que no existe', () => {
  esperarLanza(() => lic.firmar({ tenant: 'x', cliente: 'X', hasta: dias(30), modulos: ['teletransporte'] }), 'desconocidos');
});
prueba('sin modulos se habilitan todos', () => {
  const c = lic.verificarFirma(lic.firmar({ tenant: 'x', cliente: 'X', hasta: dias(30) }));
  esperar(c.modulos.length === lic.MODULOS.length, 'deberian venir todos los modulos');
});
prueba('los modulos quedan ordenados', () => {
  const c = lic.verificarFirma(lic.firmar({ tenant: 'x', cliente: 'X', hasta: dias(30), modulos: ['reportes', 'api', 'registro'] }));
  const ordenados = c.modulos.slice().sort();
  esperar(JSON.stringify(c.modulos) === JSON.stringify(ordenados), 'no quedaron ordenados');
});

console.log('\nArchivo en disco');
const fs = require('fs');
const os = require('os');
const rutaTmp = path.join(os.tmpdir(), 'visitaflow-prueba-' + Date.now() + '.vflow');
prueba('la licencia se guarda y se vuelve a leer igual', () => {
  fs.writeFileSync(rutaTmp, texto);
  const e = lic.evaluarArchivo(rutaTmp);
  esperar(e.valida, 'no se pudo evaluar el archivo: ' + e.motivo);
  esperar(e.contenido.tenant === 'junta-prueba', 'tenant incorrecto');
  fs.unlinkSync(rutaTmp);
});

prueba('el resumen legible trae los datos clave', () => {
  const r = lic.resumenLegible(lic.evaluar(texto));
  for (const fragmento of ['Estado', 'Cliente', 'Vigencia', 'Modulos', 'Limites']) {
    esperar(r.includes(fragmento), 'falta "' + fragmento + '" en el resumen');
  }
});

console.log('\n---------------------------------------------');
console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
console.log('---------------------------------------------\n');
process.exit(fallos ? 1 : 0);
