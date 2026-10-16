/**
 * VisitaFlow - ¿Está todo listo para desplegar?
 *
 *   node scripts/comprobar-preparacion.js
 *
 * QUE HACE
 * --------
 * Recorre, en un solo sitio, todo lo que tiene que estar bien ANTES de tocar el VPS, y
 * lo que hay que pegar en Dokploy. No despliega nada y no necesita token.
 *
 * Existe porque el despliegue se hace una vez y conviene que sea a la primera: cada
 * comprobacion aqui es algo que, si esta mal, hace fallar el despliegue o hace que el
 * sistema arranque roto sin decir por que.
 *
 * Sale con codigo 1 si algo impide desplegar.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));

let ok = 0;
let problemas = 0;
let avisos = 0;

const bien = (t) => { ok++; console.log('  [ok]    ' + t); };
const mal = (t) => { problemas++; console.log('  [FALTA] ' + t); };
const aviso = (t) => { avisos++; console.log('  [ojo]   ' + t); };
const info = (t) => console.log('          ' + t);
const paso = (t) => { console.log(''); console.log('  ' + t); };

const existe = (rel) => fs.existsSync(path.join(RAIZ, rel));

(async () => {
  console.log('');
  console.log('  VisitaFlow - ¿está todo listo para desplegar?');
  console.log('  ' + '='.repeat(66));

  /* ------------------------------------------------------------------ */
  paso('1. Lo que se sube al servidor');

  for (const f of ['Dockerfile', 'docker-compose.yml', '.dockerignore', 'package.json']) {
    if (existe(f)) bien(f);
    else mal(f + ' no existe');
  }

  /* Los dos servidores. */
  for (const f of ['server.js', 'server-licencias.js']) {
    if (existe(f)) bien(f + ' (punto de entrada)');
    else mal(f + ' no existe');
  }

  /* ------------------------------------------------------------------ */
  paso('2. Lo que NO debe subirse');

  const dockerignore = existe('.dockerignore') ? fs.readFileSync(path.join(RAIZ, '.dockerignore'), 'utf8') : '';
  const gitignore = existe('.gitignore') ? fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf8') : '';

  for (const [archivo, porQue] of [
    ['.env', 'lleva los secretos de producción'],
    ['licencias-keys', 'lleva la llave privada que firma las licencias'],
    ['datos', 'lleva la licencia y los datos del cliente'],
  ]) {
    const enImagen = dockerignore.split('\n').some((l) => l.trim() === archivo || l.trim() === archivo + '/');
    const enRepo = gitignore.split('\n').some((l) => l.trim() === archivo || l.trim() === archivo + '/');
    if (enImagen) bien(archivo + ' queda fuera de la imagen (' + porQue + ')');
    else mal(archivo + ' NO está en .dockerignore (' + porQue + ')');
    if (enRepo) bien(archivo + ' queda fuera del repositorio');
    else mal(archivo + ' NO está en .gitignore');
  }

  /* Y que de verdad no estén en el repositorio publicado. */
  const r = spawnSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' });
  const enRepo = (r.stdout || '').split('\n');
  for (const f of ['.env', 'licencias-keys/privada.pem', 'licencias-keys/publica.pem']) {
    if (enRepo.indexOf(f) === -1) bien(f + ' no está en el repositorio (comprobado con git)');
    else mal(f + ' ESTÁ EN EL REPOSITORIO: cualquiera puede verlo');
  }

  /* ------------------------------------------------------------------ */
  paso('3. Las variables que el compose exige');

  const compose = fs.readFileSync(path.join(RAIZ, 'docker-compose.yml'), 'utf8');
  const sinComentarios = compose.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const requeridas = new Set();
  let m;
  const re = /\$\{([A-Z_][A-Z0-9_]*):\?/g;
  while ((m = re.exec(sinComentarios)) !== null) requeridas.add(m[1]);

  for (const n of [...requeridas].sort()) {
    const v = process.env[n];
    if (v) {
      const mostrando = /LLAVE|SECRET|TOKEN|CLAVE|PASSWORD/i.test(n) ? '(definida, ' + v.length + ' caracteres)' : v;
      bien(n + '  ' + mostrando);
    } else {
      mal(n + ' no tiene valor: el despliegue mandaría un compose que no arranca');
    }
  }

  /* ------------------------------------------------------------------ */
  paso('4. Los valores que hay que pegar en Dokploy');

  const privada = path.join(RAIZ, 'licencias-keys', 'privada.pem');
  const publica = path.join(RAIZ, 'licencias-keys', 'publica.pem');

  if (fs.existsSync(privada) && fs.existsSync(publica)) {
    bien('el par de llaves existe');
    info('LICENCIA_LLAVE_PRIVADA_B64  ->  ' + fs.readFileSync(privada).toString('base64').length + ' caracteres (solo el servicio "licencias")');
    info('LICENCIA_LLAVE_PUBLICA_B64  ->  ' + fs.readFileSync(publica).toString('base64').length + ' caracteres (app y licencias)');
  } else {
    mal('no hay par de llaves: genérelas con npm run keys:gen');
  }

  const faltan = [];
  if (!process.env.DOKPLOY_TOKEN) faltan.push('DOKPLOY_TOKEN (para desplegar sin tocar el panel)');
  if (!process.env.LICENCIAS_DOMINIO) faltan.push('LICENCIAS_DOMINIO (el servidor de licencias necesita dirección pública)');
  if (!process.env.VISITAS_DOMINIO) faltan.push('VISITAS_DOMINIO (el sistema necesita dirección pública)');

  if (faltan.length) {
    aviso('para el despliegue automático faltan:');
    for (const f of faltan) info('  $env:' + f);
    info('También puede hacerlo a mano en el panel de Dokploy.');
  } else {
    bien('están el token y los dos dominios: se puede desplegar solo');
  }

  /* ------------------------------------------------------------------ */
  paso('5. El respaldo de la base de cédulas');

  const bak = 'C:\\TempSQL\\PadronLigero.bak';
  if (fs.existsSync(bak)) {
    const mb = Math.round(fs.statSync(bak).size / 1048576);
    bien('el respaldo está (' + mb + ' MB)');
    info('se sube una sola vez:  scp "' + bak + '" root@206.183.130.121:/root/');
  } else {
    aviso('no se encontró el respaldo en ' + bak);
    info('sin él, el sistema funciona pero no se puede buscar por cédula');
  }

  /* ------------------------------------------------------------------ */
  paso('6. Que el código que se va a subir esté sano');

  const revision = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'revisar-despliegue.js')], {
    cwd: RAIZ, encoding: 'utf8', timeout: 240000,
  });
  const salida = ((revision.stdout || '') + (revision.stderr || '')).replace(/\u001b\[[0-9;]*m/g, '');

  if (revision.status === 0) {
    const compilan = /(\d+) archivos ejecutables compilan/.exec(salida);
    const cargan = /(\d+) módulos del sistema se cargan/.exec(salida);
    bien('la revisión del despliegue pasa' + (compilan ? ' (' + compilan[1] + ' archivos compilan' : '') +
      (cargan ? ', ' + cargan[1] + ' módulos cargan)' : ')'));
  } else {
    mal('la revisión del despliegue encontró problemas:');
    for (const l of salida.split('\n').filter((x) => /^\s*\[X\]/.test(x)).slice(0, 5)) info(l.trim());
  }

  /* ------------------------------------------------------------------ */
  paso('7. Que el sistema esté funcionando aquí');

  let salud = null;
  try {
    const resp = await fetch('http://localhost:' + config.servidor.puerto + '/api/salud');
    salud = await resp.json();
    bien('el sistema responde en el puerto ' + config.servidor.puerto);
    if (salud.base_datos && salud.base_datos.disponible) bien('su base de datos responde');
    else mal('su base de datos NO responde');
    if (salud.cedulas && salud.cedulas.disponible) bien('la base de cédulas responde');
    else aviso('la base de cédulas no responde (el sistema funciona igual, sin buscar por cédula)');
    if (salud.licencia && salud.licencia.valida) bien('la licencia es válida (' + (salud.licencia.cliente || '') + ')');
    else aviso('la licencia no es válida: ' + (salud.licencia ? salud.licencia.estado : 'sin datos'));
  } catch (e) {
    aviso('el sistema no está corriendo en este momento (arránquelo con npm start)');
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  ' + '='.repeat(66));

  if (problemas) {
    console.log('  ' + problemas + ' cosa(s) que impiden desplegar. Arréglelas y vuelva a ejecutar.');
    console.log('  ' + ok + ' comprobación(es) correcta(s)' + (avisos ? ', ' + avisos + ' aviso(s)' : ''));
  } else {
    console.log('  LISTO PARA DESPLEGAR.');
    console.log('  ' + ok + ' comprobación(es) correcta(s)' + (avisos ? ', ' + avisos + ' aviso(s) que leer' : ''));
    console.log('');
    console.log('  Los tres pasos, en orden:');
    console.log('');
    console.log('    1. Subir la base de cédulas (una sola vez, 275 MB):');
    console.log('         scp "C:\\TempSQL\\PadronLigero.bak" root@206.183.130.121:/root/');
    console.log('');
    console.log('    2. Desplegar:');
    console.log('         $env:DOKPLOY_TOKEN = "el-token-de-dokploy"');
    console.log('         $env:LICENCIAS_DOMINIO = "licencias.su-dominio.com"');
    console.log('         $env:VISITAS_DOMINIO = "visitas.su-dominio.com"');
    console.log('         npm run desplegar');
    console.log('');
    console.log('    3. Restaurar el padrón dentro del contenedor (lo dice DESPLIEGUE-VPS.md,');
    console.log('       sección 9) y comprobar con:  npm run padron:comprobar');
  }

  console.log('  ' + '='.repeat(66));
  console.log('');

  process.exitCode = problemas ? 1 : 0;
})().catch((e) => {
  console.log('');
  console.log('  Se detuvo: ' + e.message);
  console.log('');
  process.exitCode = 1;
});
