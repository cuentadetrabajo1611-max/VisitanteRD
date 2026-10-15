# Auditoría de seguridad — VisitaFlow

Fecha: 15 de octubre de 2026. Alcance: los 97 archivos versionados en `main`
(`git ls-files`), el historial completo de git (incluida la rama remota
`feat/visitor-system-foundation` y los refs de PR), y las rutas que quedan
expuestas sin sesión.

## Resumen

**22 hallazgos: 1 crítica, 3 altas, 9 medias y 9 bajas.** No hay ningún secreto
versionado, ni ahora ni en ningún commit del historial: la llave privada del
licenciamiento nunca llegó al repositorio. **No hay inyección SQL**: los ~20
sitios donde se arma SQL con texto interpolan fragmentos literales o nombres de
columna de listas fijas, y todos los valores viajan parametrizados. La debilidad
grave no está en el código del sistema de visitantes sino en **el servidor de
licencias**, que es la pieza publicada en Internet: entrega la licencia firmada
de cualquier cliente a quien sepa su código, sin ninguna autenticación (probado
en vivo). La segunda es de configuración: con `JWT_SECRET` sin definir el sistema
arranca firmando las sesiones con un secreto que está en este repositorio, y eso
permite fabricar un token de administrador (probado).

---

## Tabla de hallazgos

| # | Gravedad | Qué es | Dónde | Cómo se arregla |
|---|---|---|---|---|
| 1 | **Crítica** | El secreto de las sesiones es un valor de ejemplo publicado aquí, y el sistema arranca igual. Cualquiera firma un token de administrador. | `src/config.js:58`, `src/config.js:149`, `server.js:337` | Quitar el valor por defecto y no arrancar si falta (parche 1) |
| 2 | **Alta** | `POST /api/licencia/consultar` devuelve la licencia firmada completa sólo con el código de la institución, sin token. La comprobación de equipo se salta omitiendo `huella`. Robo de licencias. | `server-licencias.js:174-239` (líneas 201-213) | Exigir huella y el token compartido (parche 2) |
| 3 | **Alta** | El registro de licencias se escribe sin atomicidad y `leerRegistro()` devuelve `[]` cuando el JSON está dañado. Un archivo a medio escribir borra **todos** los clientes en el siguiente guardado. | `server-licencias.js:44-56` | Temporal + `rename` + `fsync`, y fallar en vez de devolver `[]` (parche 3) |
| 4 | **Alta** | `POST /api/licencia/activada` es pública y escribe sin autenticar en el registro del vendedor. Permite corromper el inventario y engordar el archivo sin límite (cada petición lo lee entero). | `server-licencias.js:324-348` | Exigir token de activación, exigir huella y tope de instalaciones (parche 4) |
| 5 | **Media** | `/api/acceso/entrar` y `/api/acceso/recuperar` aceptan el `tenant` del cuerpo de la petición: es el único sitio del sistema donde la institución no sale del token. Con credenciales válidas de otra institución alojada en la misma base se entra a ella. No es un salto de autenticación (la contraseña sigue haciendo falta), pero rompe la garantía de aislamiento. | `src/rutas.js:261`, `src/rutas.js:348` | Ignorar `tenant` cuando la instalación ya tiene licencia; usar sólo `tenantDeLaInstalacion()` |
| 6 | **Media** | El límite de intentos por cuenta se convierte en un bloqueo permanente del administrador: 6 fallos cada 15 minutos dejan la cuenta bloqueada para siempre. El usuario del admin es deducible (`admin@<código>.local`). | `src/auth.js:21-22`, `src/auth.js:139-168` | No bloquear por cuenta desde IPs distintas, y desbloquear solo con el token de recuperación |
| 7 | **Media** | El límite por IP usa `X-Forwarded-For` tal cual, tomando el primer valor. En una instalación sin proxy delante (el caso de `iniciar.bat`, que además deja `DETRAS_DE_PROXY=1` por defecto) se salta el límite mandando una cabecera falsa, y de paso se falsea la IP de la bitácora. | `src/util.js:340-347`, `server.js:52`, `src/config.js:53` | Usar `req.ip` (Express con `trust proxy`), o el último valor de la cabecera |
| 8 | **Media** | Los logos SVG se aceptan y se sirven desde el mismo origen con `image/svg+xml`. Un SVG con `<script>` ejecuta código al abrirlo y puede leer `sessionStorage.vf_token`. Quien tenga `personalizacion.editar` puede plantarlo y la URL es pública. | `src/rutas.js:1319-1339`, `src/rutas.js:1819-1823`, `server.js:117` | Servir `/archivos` con `Content-Security-Policy: default-src 'none'` y `nosniff`, o dejar de aceptar SVG |
| 9 | **Media** | Rutas públicas que revelan más de lo necesario: `/api/salud` da el nombre del cliente, la versión, el nombre de la base y el texto del error de SQL; `/api/acceso/instituciones` da el correo de contacto y el `id` interno, y de ahí sale el usuario del administrador. | `src/rutas.js:96-119`, `src/rutas.js:163-210`, `server.js:214` | Recortar `/api/salud` a lo que necesita el healthcheck y quitar `contacto_correo`/`id` de la ruta pública |
| 10 | **Media** | El ID de licencia se deriva del reloj (`LIC-` + base36 de `Date.now()`), no es aleatorio. Dentro de una ventana conocida se puede barrer. | `src/licencias/licencia.js:153` | `'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase()` |
| 11 | **Media** | `responderError` devuelve `e.message` también en los 500, y ahí caben mensajes del driver de SQL (servidor, usuario, nombre de objeto). | `src/util.js:32-38` | Responder un texto genérico en los 500 y dejar el detalle sólo en el registro del servidor |
| 12 | **Media** | Las rutas públicas del servidor de licencias no tienen límite de peticiones: se puede barrer el espacio de IDs y de códigos de institución a la velocidad que aguante el disco. | `server-licencias.js` (ninguna ruta lo tiene) | Un contador en memoria por IP, copiando el de `server.js:49-81` |
| 13 | **Media** | `POST /api/licencia/consultar` responde 404 o 200 según exista la institución, y `/api/salud` publica `licencias_emitidas`. Las dos cosas permiten enumerar la cartera de clientes. | `server-licencias.js:182-184`, `server-licencias.js:152` | Responder siempre el mismo error genérico y quitar el conteo de `/api/salud` |
| 14 | **Baja** | CORS con `origin: true` y `credentials: true`: refleja cualquier origen. Hoy no es explotable porque la cookie es `SameSite=Lax` (el navegador no la manda en peticiones de otro sitio), pero es una política demasiado abierta para lo que el sistema necesita. | `server.js:40` | Lista blanca con `URL_PUBLICA` |
| 15 | **Baja** | No hay ninguna cabecera de seguridad: ni CSP, ni `X-Frame-Options`, ni `X-Content-Type-Options`, ni HSTS. | `server.js:27-40` | Añadir cuatro cabeceras en un `app.use` |
| 16 | **Baja** | El token de sesión se guarda en `sessionStorage`, que es legible por cualquier script de la página, además de la cookie `HttpOnly`. | `public/app.js:49-56` | Quedarse sólo con la cookie |
| 17 | **Baja** | El enlace de recuperación, con el token dentro, se escribe en el registro del servidor en texto claro. En Dokploy esos registros los ve cualquiera con acceso al panel. | `src/rutas.js:355` | Registrar sólo «se generó un enlace para X», sin el token |
| 18 | **Baja** | La comparación del `ADMIN_TOKEN` no es de tiempo constante. Es una debilidad teórica: el token que genera `preparar-despliegue.js` son 36 bytes al azar. | `server-licencias.js:126` | Comparar con `crypto.timingSafeEqual` |
| 19 | **Baja** | `mode: 0o600` no restringe nada en Windows: el archivo hereda los permisos de la carpeta. Afecta al registro de licencias y a `CLAVE-ADMINISTRADOR.txt`, que es donde queda la contraseña del administrador. | `server-licencias.js:55`, `server.js:233` | En Windows, `ACL` explícita, o documentar que la carpeta de datos debe estar restringida |
| 20 | **Baja** | El repositorio público publica la ruta absoluta de la máquina de desarrollo y la IP del VPS con el puerto del panel de Dokploy. No es un secreto (la IP se resuelve por DNS), pero le ahorra el escaneo a quien busque el panel. | `README.md:192`, `DESPLIEGUE.md:273`, `scripts/desplegar-dokploy.js:43` | Ruta relativa en el README y la IP por variable de entorno |
| 21 | **Baja** | La imagen incluye `scripts/`, con herramientas destructivas (`borrar-institucion.js`, `respaldo.js` con restauración, `restablecer-admin.js`). No son alcanzables por HTTP —hacen falta `docker exec`—, pero están en el mismo contenedor que la llave privada. | `Dockerfile:50` | Copiar sólo los scripts que el arranque necesita |
| 22 | **Baja** | `esc()` en `src/impresion.js:82-84` **no escapa nada**: sólo recorta y trunca. Hoy no se usa (la plantilla usa `texto()`), pero el nombre invita a usar la equivocada en el próximo cambio. | `src/impresion.js:82-84` | Borrarla, o renombrarla a `recortar()` |

---

## Parches para lo crítico y lo alto

### Parche 1 — `JWT_SECRET` (crítica)

Hoy, si la variable no está definida, `config.js` cae en un valor escrito en el
código, y el aviso sólo se emite cuando `NODE_ENV=production`. La vía de
instalación local (`iniciar.bat`, que no define `NODE_ENV`) arranca sin ningún
aviso. Comprobado ejecutando el propio código del proyecto: un token firmado con
`cambie-este-secreto-en-produccion` para `rol: 'admin'` pasa `auth.verificarToken()`
sin objeción, y `config.revisar()` devuelve una lista vacía.

**Antes** — `src/config.js:57-62` y `:149-151`

```js
  sesion: {
    secreto: texto('JWT_SECRET', 'cambie-este-secreto-en-produccion'),
    expira: texto('JWT_EXPIRA', '12h'),
```

```js
  if (config.esProduccion() && config.sesion.secreto === 'cambie-este-secreto-en-produccion') {
    avisos.push('JWT_SECRET sigue con el valor de ejemplo. Cambielo antes de publicar el sistema.');
  }
```

**Después** — `src/config.js`

```js
  sesion: {
    /* Sin valor por defecto a proposito. Un secreto de sesion que viaja escrito
       en el codigo no es un secreto: este repositorio es publico, y con el
       cualquiera firma un token de administrador. Si falta, el servidor no
       arranca (vea server.js). */
    secreto: texto('JWT_SECRET', ''),
    expira: texto('JWT_EXPIRA', '12h'),
```

```js
  // No depende del entorno: la instalacion de escritorio tambien queda en la red
  // local, y era justo la que arrancaba sin ningun aviso.
  if (!config.sesion.secreto || config.sesion.secreto === 'cambie-este-secreto-en-produccion' || config.sesion.secreto.length < 32) {
    avisos.push('JWT_SECRET falta, es el valor de ejemplo o es demasiado corto. Con el se firman las sesiones.');
  }
```

**Antes** — `server.js:336-338`

```js
async function arrancar() {
  const avisos = config.revisar();
  for (const a of avisos) console.warn('[visitaflow] AVISO: ' + a);
```

**Después** — `server.js`

```js
/** ¿Sirve el secreto de sesion? Uno de ejemplo, publicado, no sirve. */
function secretoDeSesionValido() {
  const s = config.sesion.secreto;
  return Boolean(s) && s !== 'cambie-este-secreto-en-produccion' && s.length >= 32;
}

async function arrancar() {
  const avisos = config.revisar();
  for (const a of avisos) console.warn('[visitaflow] AVISO: ' + a);

  /* Se corta el arranque. Seguir con el secreto de ejemplo significa que
     cualquiera que lea el repositorio entra como administrador de cualquier
     institucion: es peor que no arrancar. */
  if (!secretoDeSesionValido()) {
    console.error('');
    console.error('  ATENCION: falta JWT_SECRET (o sigue con el valor de ejemplo).');
    console.error('  Con ese valor, cualquiera que lea el repositorio firma un token');
    console.error('  de administrador y entra sin contrasena.');
    console.error('');
    console.error('  Genere uno con:  node scripts/preparar-despliegue.js');
    console.error('  y pongalo en .env:  JWT_SECRET=<36 bytes al azar>');
    console.error('');
    process.exit(1);
  }
```

Si prefiere no cortar el arranque, la alternativa es generar un secreto al azar
en cada arranque (`crypto.randomBytes(36).toString('base64')`) cuando falte: eso
invalida las sesiones al reiniciar, pero cierra la puerta.

### Parche 2 — `/api/licencia/consultar` (alta)

Comprobado contra el servidor que está en marcha: una petición con **sólo** el
código de la institución, sin token y sin huella, devuelve `licencia_id`,
`hasta` y el archivo firmado completo (1186 caracteres). El amarre a un equipo no
protege porque la comprobación es `if (actual.huella && huella && ...)`: basta con
no mandar `huella`. Y `LICENCIA_TOKEN_ACTIVACION` ya lo envían las instalaciones
(`src/licencias/gestor.js:534`) pero el servidor **no lo mira en ningún sitio**.

**Antes** — `server-licencias.js:174-213`

```js
app.post(
  '/api/licencia/consultar',
  envolver(async (req, res) => {
    const { tenant, licencia_id, huella } = req.body || {};
    if (!tenant) throw error(400, 'Falta el identificador de la institución.');
    ...
    // La huella solo se exige si la licencia esta amarrada a un equipo.
    if (actual.huella && huella && actual.huella !== huella) {
      throw error(403, 'Esta licencia está amarrada a otro equipo (' + actual.huella + ').');
    }
```

**Después** — `server-licencias.js`

```js
/**
 * Token compartido que las instalaciones ya mandan al pedir su licencia.
 *
 * Antes no se comprobaba: esta ruta es publica, asi que cualquiera que supiera
 * el codigo de una institucion se llevaba su licencia firmada. Si la variable
 * esta vacia se responde 503 y no se entrega nada: mejor no renovar durante un
 * rato que repartir licencias a quien las pida.
 */
function activacion(req, res, next) {
  const token = config.licencia.tokenActivacion;
  if (!token) {
    return responderError(res, error(503, 'El servidor de licencias no tiene LICENCIA_TOKEN_ACTIVACION configurado.'));
  }
  const enviado = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (enviado !== token) return responderError(res, error(401, 'Token de activación inválido.'));
  next();
}
```

```js
app.post(
  '/api/licencia/consultar',
  activacion,
  envolver(async (req, res) => {
    const { tenant, licencia_id, huella } = req.body || {};
    if (!tenant) throw error(400, 'Falta el identificador de la institución.');

    /* La huella se EXIGE, no se acepta si viene. Sin ella no hay forma de saber
       a que equipo se le esta entregando la licencia, y esta ruta no pide sesion. */
    if (!huella) throw error(400, 'Falta la huella del equipo.');
    ...
    /* Amarre estricto: si la licencia esta amarrada y la huella no coincide (o no
       viene), no se entrega. La version anterior se saltaba el amarre con solo
       omitir el campo. */
    if (actual.huella && actual.huella !== huella) {
      throw error(403, 'Esta licencia está amarrada a otro equipo.');
    }
```

Ojo con el despliegue: hay que definir `LICENCIA_TOKEN_ACTIVACION` en el servidor
**y** en cada instalación (ya existe esa variable a los dos lados). Si se activa
sólo en el servidor, las instalaciones viejas dejan de poder renovar hasta que se
les ponga el valor.

### Parche 3 — registro de licencias (alta)

`leerRegistro()` se traga los errores de análisis y devuelve `[]`. Eso no sólo
oculta el problema: la siguiente emisión, renovación o suspensión escribe esa
lista vacía encima del archivo. Un JSON truncado por un corte a mitad de
`writeFileSync` borra **todos** los clientes en el siguiente guardado, y el panel
los muestra como si nunca hubieran existido.

**Antes** — `server-licencias.js:44-56`

```js
function leerRegistro() {
  try {
    if (!fs.existsSync(REGISTRO)) return [];
    return JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
  } catch (e) {
    return [];
  }
}

function guardarRegistro(lista) {
  fs.mkdirSync(path.dirname(REGISTRO), { recursive: true });
  fs.writeFileSync(REGISTRO, JSON.stringify(lista, null, 2), { mode: 0o600 });
}
```

**Después** — `server-licencias.js`

```js
function leerRegistro() {
  if (!fs.existsSync(REGISTRO)) return [];
  const datos = fs.readFileSync(REGISTRO, 'utf8');
  try {
    return JSON.parse(datos);
  } catch (e) {
    /* NO se devuelve [] a proposito. Devolverlo hacia que el siguiente guardado
       escribiera la lista vacia encima del archivo: un JSON a medio escribir
       borraba todos los clientes sin que nadie se enterara. */
    throw error(500, 'El registro de licencias está dañado (' + REGISTRO + '). Restaure una copia antes de seguir.');
  }
}

function guardarRegistro(lista) {
  fs.mkdirSync(path.dirname(REGISTRO), { recursive: true });
  const datos = JSON.stringify(lista, null, 2);

  /* Temporal + rename: el rename es atomico, asi que o queda el archivo viejo
     entero o el nuevo entero, nunca la mitad. Con writeFileSync directo, un
     reinicio del contenedor a mitad de escritura dejaba el archivo truncado. */
  const temporal = REGISTRO + '.tmp';
  const fd = fs.openSync(temporal, 'w', 0o600);
  try {
    fs.writeFileSync(fd, datos);
    fs.fsyncSync(fd); // que los bytes esten en disco antes de soltar el nombre
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporal, REGISTRO);
}
```

### Parche 4 — `/api/licencia/activada` (alta)

**Antes** — `server-licencias.js:324-345`

```js
app.post(
  '/api/licencia/activada',
  envolver(async (req, res) => {
    const { tenant, licencia_id, huella, equipo } = req.body || {};
    const lista = leerRegistro();
    const i = lista.findIndex((l) => l.licencia_id === licencia_id && l.tenant === String(tenant || '').toLowerCase());
    if (i < 0) throw error(404, 'Esa licencia no existe en este servidor.');
    lista[i].instalaciones = lista[i].instalaciones || [];
    const existente = lista[i].instalaciones.find((x) => x.huella === huella);
    ...
    guardarRegistro(lista);
```

**Después** — `server-licencias.js`

```js
/* Tope de equipos por licencia. Sin tope, esta ruta publica permite engordar el
   archivo sin fin: cada peticion lo lee entero, asi que el crecimiento se paga
   en memoria en TODAS las demas rutas. */
const MAX_INSTALACIONES = 50;

app.post(
  '/api/licencia/activada',
  activacion, // el mismo intermediario del parche 2
  envolver(async (req, res) => {
    const { tenant, licencia_id, huella, equipo } = req.body || {};
    // La huella deja de ser opcional: es lo unico que identifica la instalacion.
    if (!huella) throw error(400, 'Falta la huella del equipo.');

    const lista = leerRegistro();
    const i = lista.findIndex((l) => l.licencia_id === licencia_id && l.tenant === String(tenant || '').toLowerCase());
    if (i < 0) throw error(404, 'Esa licencia no existe en este servidor.');

    // Si la licencia esta amarrada, solo ese equipo puede darse de alta.
    if (lista[i].huella && lista[i].huella !== huella) {
      throw error(403, 'Esta licencia está amarrada a otro equipo.');
    }

    lista[i].instalaciones = lista[i].instalaciones || [];
    if (lista[i].instalaciones.length >= MAX_INSTALACIONES) {
      throw error(400, 'Esta licencia ya alcanzó el máximo de equipos registrados.');
    }
    const existente = lista[i].instalaciones.find((x) => x.huella === huella);
    ...
    guardarRegistro(lista);
```

---

## Lo que está bien

Conviene decirlo con la misma claridad, porque la mayor parte del trabajo de
seguridad del proyecto está hecho y bien hecho:

1. **No hay ningún secreto versionado, ni ahora ni nunca.** Revisé los 97
   archivos, los 10 commits, las 131 rutas que existieron alguna vez, la rama
   remota `feat/visitor-system-foundation`, los refs `refs/pull/1/*` y el único
   objeto suelto del repositorio. Nunca se subió un `.env`, un `.pem`, un
   `.vflow` ni `CLAVE-ADMINISTRADOR.txt`. Las credenciales que aparecen en el
   código (`Operador2026!`) son de las suites de prueba, se crean y se borran en
   un tenant de prueba.
2. **El `.gitignore` y el `.dockerignore` cubren lo que hay que cubrir**, y
   `scripts/preparar-despliegue.js` comprueba los dos antes de desplegar. La
   llave privada del licenciamiento no entra en la imagen: el `Dockerfile` copia
   código, nunca `licencias-keys/` ni `.env`.
3. **No hay inyección SQL.** Revisé uno por uno los ~20 sitios con plantillas
   `${}` y con concatenación. Todos interpolan o bien fragmentos literales
   (`'v.estado = @estado'`), o bien identificadores que salen de listas fijas del
   propio código (`CATALOGOS` en `rutas.js:1113`, `CAMPOS_EDITABLES` en
   `gafete.js:246`, `TABLAS` en `borrar-institucion.js:25`), o números ya
   convertidos con `util.entero` y acotados (`TOP`, `paginacion`). El nombre de
   la tabla del padrón pasa por una expresión regular
   (`identidad/padron.js:113-119`) y el orden de las visitas por un diccionario
   cerrado (`visitas.js`, `ordenSeguro`). Los valores siempre van con `@`.
4. **No hay XSS en la interfaz.** `VF.ui.esc` (en `public/app.js`) y `esc` (en
   `public-licencias/consola.js`) escapan `& < > " '`, incluidas las comillas, que
   es lo que hace falta porque el resultado se mete dentro de atributos. Pasé un
   barrido automático por todos los `innerHTML`, `insertAdjacentHTML` y `html:` de
   los dos frontends: los únicos que interpolan datos sin escapar son plantillas
   fijas. La hoja de impresión (`src/impresion.js`) escapa con `texto()`, y el SVG
   del QR y del código de barras escapan con `escapar()`.
5. **Las contraseñas están bien guardadas.** bcrypt con coste 10, mínimo de 8
   caracteres con letra y número, y el mismo mensaje de error tanto si el correo
   no existe como si la contraseña está mal: no se puede averiguar quién tiene
   cuenta. El token de recuperación son 32 bytes al azar, de un solo uso y con
   caducidad; al usarlo se borra.
6. **El aislamiento entre instituciones es sólido en todas las rutas de datos.**
   El `tenant_id` sale del token firmado (`acceso.js:82`) y además se revalida
   contra la base en cada petición, comparando `activo` y `tenant_estado`: dar de
   baja a un operador o suspender una institución surte efecto de inmediato, sin
   esperar a que venza el token. Comprobé las 71 rutas de `src/rutas.js`: todas
   las de datos llevan `conSesion` y su permiso.
7. **La administración del servidor de licencias está cerrada.** Probé
   `GET /api/admin/licencias` sin token y con un token inventado: 401 en los dos
   casos. Y si `ADMIN_TOKEN` está vacío responde 503, es decir, falla cerrado en
   vez de abrirse; el servidor tampoco arranca sin la llave privada. Las
   respuestas del panel no incluyen la llave privada ni el contenido de las
   licencias.
8. **El licenciamiento se verifica de verdad.** RSA-2048 con PKCS#1 v1.5 sobre
   el JSON canonicalizado, más la comprobación del `key_id`: editar el archivo
   `.vflow` para alargar una fecha o habilitar un módulo no sirve, y lo he
   confirmado leyendo `verificarFirma()`, que no se puede rodear porque la base
   de datos nunca es la que decide si una licencia vale.
9. **El contenedor está razonablemente bien.** Corre como usuario sin
   privilegios (`USER visitaflow`), con `dumb-init`, sin secretos dentro de la
   imagen, y el `docker-compose.yml` exige las cinco variables obligatorias con
   `${VAR:?...}`, así que un despliegue con un secreto vacío se detiene en vez de
   arrancar. Los tres servicios no publican puertos al host: sólo los expone a la
   red interna de Compose.
10. **Las pruebas de aislamiento existen y son buenas.** `sql/90-pruebas.js:710`
    crea una segunda institución y comprueba que un administrador de una no ve
    los datos de la otra. Esa prueba es la que demuestra que el diseño
    multi-inquilino se toma en serio.

---

## Notas de método

* No ejecuté `test:primer-arranque`, `test:produccion` ni `test:despliegue`.
  Tampoco reinicié ni detuve ningún servidor, ni escribí en ninguna base.
* Lo probado en vivo, contra los servidores que ya estaban en marcha y sólo con
  peticiones de lectura, fue: `GET /api/salud` (3000 y 4100),
  `GET /api/acceso/instituciones`, `GET /api/licencia/estado-inicial`,
  `GET /api/admin/licencias` sin token y con token inventado, y
  `POST /api/licencia/consultar` con un código inexistente y con el código de
  prueba local. No llamé a `POST /api/licencia/activada` porque escribe: su fallo
  está demostrado por lectura del código.
* El salto del límite por `X-Forwarded-For` (hallazgo 7) está confirmado por
  lectura, no con peticiones: habría dejado filas falsas en la bitácora de
  auditoría. Detrás de Traefik con la configuración por defecto no aplica, porque
  Traefik descarta las cabeceras que llegan de fuera; aplica en la instalación
  directa, sin proxy delante.
* Ningún archivo de código fue modificado. Los parches de este documento están
  escritos para aplicarse, no aplicados.
* Mientras se hacía esta auditoría, otro agente estaba modificando
  `src/identidad/padron.js` (búsqueda por nombre) y `package.json`. Volví a
  comprobar el trozo de SQL de ese archivo después del cambio: la consulta sigue
  parametrizada y lo único que se interpola es `TOP` con un número acotado y el
  nombre de tabla validado por expresión regular. Las demás conclusiones no se
  ven afectadas porque el resto de archivos citados no cambió.
