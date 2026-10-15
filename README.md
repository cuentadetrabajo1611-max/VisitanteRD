# VisitaFlow

Sistema de gestión de visitantes **multi-tenant con licenciamiento firmado**.
Cada institución lo instala, lo activa con su licencia y opera con su propia
identidad: consulta la cédula del visitante contra una base local, registra la
entrada en segundos, imprime el gafete y deja la bitácora de quién entró, a
quién visitó y cuándo salió.

Funciona **sin Internet**. La red solo se usa para activar o renovar la
licencia.

---

## Alcance: los nueve módulos del diseño

El diseño original planteaba nueve módulos. Este es el estado de cada uno, para
que no haya dudas de lo que está y lo que no:

| # | Módulo del diseño | Estado |
|---|---|---|
| 1 | Panel principal | **Completo** — métricas del día, quiénes están dentro, últimas entradas y alertas |
| 2 | Registro de visitantes | **Completo** — cédula, autocompletado, persona visitada, motivo, registro rápido |
| 3 | Recepción y control de acceso | **Completo** — entradas, salidas, pendientes, quiénes están dentro, aprobación |
| 4 | Directorio de personas y anfitriones | **Completo** — directorio del personal interno y **aviso a quien recibe la visita** |
| 5 | Gafetes y plantillas | **Completo** — diseño, logo, colores, QR, código de barras y los tres formatos de impresión |
| 6 | Historial y reportes | **Completo** — búsqueda por texto y fechas, exportación a CSV y auditoría |
| 7 | Personalización institucional | **Completo** — nombre, logo, colores, textos y formato de fecha |
| 8 | Configuración y administración | **Completo** — usuarios, roles, permisos, departamentos, motivos, categorías, sedes y personas |
| 9 | Licencia y estado del sistema | **Completo** — activación, vencimiento, cliente, estado y diagnóstico |

### El directorio y el aviso al anfitrión

**El directorio** es la lista del personal interno que recibe visitas: nombre,
cargo, correo, teléfono y a qué departamento pertenece. Con él, el recepcionista
**elige a quién visita de una lista** en vez de escribir el nombre cada vez, y el
dato queda ligado a una persona concreta, no a un texto suelto.

Un interruptor por persona permite tener a toda la plantilla y marcar solo a
quienes atienden visitas, sin borrar al resto.

**El aviso** sale solo al registrar la entrada, y busca a quién avisar en este
orden:

1. La persona elegida del directorio, a su correo.
2. Si esa persona no tiene correo, el del departamento.
3. Si el recepcionista escribió el nombre a mano, se busca en el directorio por
   nombre exacto. Si está, se usa su correo.
4. Si no está en el directorio, se avisa al **encargado del departamento**, que
   es lo mejor que se puede hacer sin saber quién es.

#### El aviso no depende del correo

Esto es lo más importante del módulo. **El aviso se guarda siempre en la base**,
haya o no servidor de correo configurado. Si lo hay, además se manda.

Una junta de vecinos puede no tener correo, y quedarse sin avisar sería peor que
no mandar el correo. El aviso queda con estado `sin_correo` o `error`, con el
motivo del fallo, y **se ve igual en la pantalla de Recepción**.

#### El correo está escrito aquí, no es una librería

El sistema tiene seis dependencias y ninguna sobra. Enviar un correo son unas
cien líneas de protocolo SMTP; traer una librería para eso significaría
revisarla y actualizarla cada vez que salga un aviso de seguridad, en un sistema
que se instala en el servidor de un cliente y se queda ahí.

Está implementado lo mínimo: `EHLO`, `STARTTLS` si el servidor lo ofrece, `AUTH
LOGIN` si hace falta, y el mensaje en UTF-8. Nada de adjuntos ni de HTML.

```env
CORREO_ACTIVO=1
SMTP_HOST=smtp.su-proveedor.com
SMTP_PORT=587
SMTP_USER=avisos@su-dominio.com
SMTP_PASS=la-clave
MAIL_FROM=VisitaFlow <avisos@su-dominio.com>
```

Y se puede probar sin registrar una visita:

```powershell
POST /api/avisos/probar-correo   { "correo": "quien@ejemplo.com" }
```

---

## Lo que hace

**Registro rápido de visitantes**
- La cédula es el primer campo: se escribe, se consulta y el formulario se
  completa solo con lo que devuelve la base de cédulas.
- Verifica el **dígito verificador** de la cédula con el algoritmo oficial.
- Si la cédula no está en la base, lo dice y (según configuración) permite
  seguir a mano, dejando marcado que **la identidad no se pudo verificar**.
- Reconoce al **visitante frecuente** y recupera su teléfono, correo y empresa:
  la segunda visita de alguien toma segundos.
- Avisa si la persona **ya está dentro** para no registrarla dos veces.
- Guarda una **copia de los datos validados** dentro de la visita: la bitácora
  no cambia aunque después cambie la base de cédulas.

**Recepción y control**

- Panel con quiénes están dentro, entradas y salidas del día, visitas sin
  aprobar y visitas que llevan demasiado tiempo abiertas.
- Salida con un clic, o **pasando el gafete por el lector** (código QR o de
  barras).
- Cierre automático de las visitas que quedaron abiertas de días anteriores.
- Aprobación de las visitas cuyo motivo la exige.

**Gafetes**

- **Vista previa real** antes de imprimir, al tamaño de salida.
- **Código QR** (generado por el propio sistema, sin librerías) y **código de
  barras Code 128**.
- Plantillas configurables: tamaño, orientación, colores, qué se imprime y el
  texto al pie.
- Se imprime con el diálogo del navegador: funciona con cualquier impresora, sin
  drivers.

**Lista de vigilancia**

- **Bloqueados** (no entran) y **observados** (entran, pero recepción recibe un
  aviso), con severidad y vencimiento opcional.
- Al validar una cédula, el aviso aparece en el acto.
- Una cédula bloqueada **no puede registrar entrada** sin que alguien autorice
  expresamente y escriba el motivo; esa decisión queda guardada.
- Los registros **no se borran, se levantan**: queda el historial.
- Bitácora de avisos mostrados y de lo que decidió recepción.

**Visitas anunciadas (pre-registro)**

- El anfitrión anuncia la visita y recibe un **código para dictar por teléfono**
  (`KRT-4821`, sin O/0 ni I/1).
- Al llegar, recepción lo busca por el código o por la cédula y el formulario se
  completa solo.
- La cédula es opcional al anunciar y se exige al hacer el check-in.
- **Vigencia configurable**: pasado el plazo, el anuncio vence solo.

**Reportes**

- Panel con métricas del periodo y gráficos: visitas por día, hora de mayor
  afluencia, reparto por motivo, departamento, día de la semana, empresas y
  personas más visitadas. Los gráficos son SVG propios, sin librerías.
- Detalle paginado con filtros por fecha, departamento, motivo y texto.
- Ranking de visitantes frecuentes.
- **Exportación a CSV** con BOM UTF-8, para que Excel respete los acentos.
- Aviso de visitas activas que llevan más tiempo del previsto.

**Personalización institucional**

- Logo propio y **paleta de colores** que repinta todo el sistema y el gafete.
- El color del texto sobre el color de marca se calcula solo, para que cambiar
  la marca no rompa la legibilidad.

**Usuarios y permisos**

- Operadores con rol `admin`, `supervisor` u `operator`.
- **24 permisos** agrupados, editables por rol desde la pantalla.
- El rol `admin` conserva todos los permisos por diseño: si alguien borra una
  asignación por error, el sistema no queda sin acceso.
- Un operador no puede desactivarse ni cambiarse el rol a sí mismo, y no se
  puede dejar la institución sin ningún administrador activo.

**Licenciamiento**

- Licencia en un archivo `.vflow` **firmado con RSA-2048**. La clave privada
  vive solo en el servidor de licencias; cada instalación trae la pública.
- Editar la fecha o habilitar un módulo a mano **rompe la firma**: el sistema lo
  rechaza con un mensaje claro.
- Controla vigencia, **periodo de gracia** configurable, módulos habilitados,
  límite de usuarios e instalaciones, y puede **amarrarse a un equipo** por su
  huella.
- Al vencer de verdad, el sistema **no secuestra la información**: se restringe
  dar de alta datos nuevos, pero el historial sigue consultable y exportable.

---

## Requisitos

| Componente | Versión | Para qué |
|---|---|---|
| Node.js | 20 o superior | El sistema |
| SQL Server | 2019 o superior | Base del sistema y base de cédulas |

En local ya están: SQL Server en `localhost:1433` y Node 24.

---

## Poner en marcha (local)

```powershell
cd "C:\Users\Admin\Desktop\Escritorio\Padron Junta\visitaflow"

npm install              # dependencias
npm run keys:gen         # par de llaves del licenciamiento (una sola vez)

# 1. La base del sistema y su esquema
npm run db:crear

# 2. La vista de ciudadanos sobre la base de cédulas
node sql/03-vista-ciudadanos.js

# 3. Una licencia de desarrollo, con la institución lista
npm run db:licencia

# 4. Arrancar
npm start
```

Luego abrir **<http://localhost:3000>**.

La primera vez, el sistema **crea el administrador** y deja su contraseña en
`CLAVE-ADMINISTRADOR.txt` (en la raíz del proyecto). Cámbiela al entrar y borre
ese archivo.

### Con datos de ejemplo

```powershell
npm run demo      # ~60 visitas repartidas en 45 días
npm run limpiar   # las borra cuando ya no las quiera
```

El demo usa **cédulas reales de la base** y pasa por la API, así que los datos
cumplen las mismas validaciones que los de verdad. Borra solo lo que él mismo
creó.

### Servidor de licencias (en otra ventana)

```powershell
npm run licencias         # http://localhost:4100
```

> El puerto 4100 se eligió porque el 4000 ya lo ocupa otro proyecto en esta
> máquina. Se puede cambiar con `PUERTO_LICENCIAS`.

---

## Direcciones

| Dirección | Qué es |
|---|---|
| <http://localhost:3000> | El sistema (todo se llega desde la barra lateral) |
| <http://localhost:3000/api/salud> | Estado del sistema, de las bases y de la licencia |
| <http://localhost:4100> | Consola del servidor de licencias |

---

## Cómo se protegen los datos de cada institución

Una sola base y un solo esquema, con la columna `tenant_id` separando una
institución de otra. La regla que lo sostiene:

> **La institución sale del token de sesión firmado, nunca del navegador.**

Ninguna consulta lee el tenant del cuerpo ni de la dirección de la petición.
Cambiar un número ahí no da acceso a los datos de otra institución. Hay una
prueba que lo comprueba creando una segunda institución y verificando que
ninguno de los dos tokens alcanza los datos del otro.

Además:

- La sesión se revalida contra la base en **cada petición**, así que desactivar a
  un operador o suspender una institución surte efecto de inmediato.
- El acceso lleva **límite de intentos fallidos** por IP y bloqueo temporal de la
  cuenta tras varios fallos.
- Toda operación que cambia datos o expone información personal queda en la
  **bitácora de auditoría**.

---

## La base de cédulas

La base del sistema de visitantes es pequeña. La de cédulas es aparte y se
consulta **en modo lectura**.

| Base | Contenido | Acceso |
|---|---|---|
| `VisitaFlow` | Instituciones, usuarios, visitantes, visitas, catálogos | lectura/escritura |
| `PadronLigero` | Cédulas: nombres, apellidos y fechas. **Sin fotografías** | solo lectura |

**Sin fotografías a propósito.** El padrón completo con imágenes ocupa unos
86,5 GB, que no caben en un VPS razonable. La tabla delgada —cédula, nombres,
apellidos, fecha de nacimiento, sexo, estado civil, nacionalidad, ocupación y
municipio— ocupa alrededor de **767 MB** para 7.856.023 filas. Eso sí cabe.

La vista `dbo.CIUDADANOS` resuelve los códigos de los catálogos (sexo, estado
civil, ocupación…) a texto y deja una **interfaz estable**: si mañana cambia el
esquema del padrón, se ajusta la vista y el sistema no se entera.

Se crea con:

```powershell
node sql/03-vista-ciudadanos.js
```

Para inspeccionar la base:

```powershell
node scripts/inspeccionar-padron.js   # tablas, columnas, índices y una consulta de prueba
node scripts/esquema-padron.js        # volcado completo del esquema
```

> **Nota técnica que costó caro:** las columnas de cédula son `VARCHAR`. Si el
> driver envía `NVARCHAR`, SQL Server aplica una conversión implícita y **no
> puede usar el índice**: la búsqueda pasa de 10 ms a más de 2 segundos. Por eso
> los parámetros se declaran con su tipo explícito en `src/db.js`. Lo mismo
> aplica a la vista: la comparación de sexo y estado civil necesita `COLLATE`
> porque el padrón y sus catálogos usan intercalaciones distintas.

---

## Fechas: por qué todas son `DATETIMEOFFSET`

Las columnas de fecha y hora guardan el **instante con su zona**. No es un
detalle: con `DATETIME2` y `SYSDATETIME()`, el valor se guarda como hora local
sin decir a qué zona pertenece, y el driver de SQL Server lo lee **como si fuera
UTC**. Medido en esta máquina (servidor en UTC-4):

| Forma de guardar | Lo que lee el driver |
|---|---|
| `SYSDATETIME()` en `DATETIME2` | 4 horas atrás — **incorrecto** |
| `SYSDATETIMEOFFSET()` en `DATETIMEOFFSET` | correcto |
| `SYSUTCDATETIME()` en `DATETIME2` | correcto |

Con la primera forma, cada visita quedaba 4 horas en el futuro para el navegador
y **las duraciones salían negativas**.

**Y hay una segunda trampa, que costó más encontrar:** no basta con que la
columna sea `DATETIMEOFFSET`. El *parámetro* también tiene que declararse como
`DateTimeOffset`. Si se envía un `Date` de JavaScript sin declarar el tipo, el
driver lo manda como `DateTime2` con la hora local del proceso, SQL Server lo
guarda con offset `+00:00`, y el instante vuelve a quedar corrido las mismas
4 horas. La columna parecía correcta y el valor no lo estaba.

Las dos cosas se comprueban con `npm run fechas:probar`, que inserta la misma
fecha de cuatro maneras y dice cuál es la correcta.

Si tiene una base creada antes de estos cambios:

```powershell
node scripts/migrar-fechas.js            # convierte las columnas a DATETIMEOFFSET
node scripts/revisar-fechas.js           # diagnostica columna por columna
node scripts/revisar-fechas.js --reparar # corrige los valores desplazados
node scripts/auditar-horas.js            # comprueba el resultado sobre las visitas
```

---

## Estructura del proyecto

```
visitaflow/
├── server.js                  Sistema de visitantes (Express)
├── server-licencias.js        Servidor de licencias (el único con la clave privada)
├── Dockerfile                 Una imagen, dos comandos
├── docker-compose.yml         Despliegue en el VPS con Dokploy
├── PRODUCT.md / DESIGN.md     Contexto de producto y decisiones de diseño
│
├── src/
│   ├── config.js              Lectura centralizada del entorno
│   ├── db.js                  Pools de SQL Server y tipos de parámetros
│   ├── util.js                Texto, fechas, contraste de color, CSV, códigos
│   ├── acceso.js              Sesión, permisos, licencia, aislamiento por institución
│   ├── auth.js                Contraseñas, tokens, intentos fallidos
│   ├── auditoria.js           Bitácora de todo lo que cambia datos
│   ├── permisos.js            Catálogo de permisos y roles
│   ├── mantenimiento.js       Alta de una institución: catálogos, ajustes, marca
│   ├── identidad/padron.js    Consulta de cédulas (solo lectura)
│   ├── licencias/
│   │   ├── licencia.js        Firma y verificación RSA (núcleo)
│   │   └── gestor.js          Carga, vigencia y activación en la instalación
│   ├── visitas.js             Registrar entrada, salida, panel, listados
│   ├── gafete.js              Emisión, vista previa y plantillas
│   ├── vigilancia.js          Bloqueados y observados
│   ├── preregistro.js         Visitas anunciadas
│   ├── reportes.js            Métricas, series y exportación
│   ├── qr.js                  Generador de código QR (propio, verificado)
│   ├── code128.js             Generador de código de barras (propio)
│   └── rutas.js               Todas las rutas de la API
│
├── public/                    La interfaz: sin frameworks ni compilación
│   ├── index.html             Esqueleto
│   ├── app.css                Sistema de diseño con variables de marca
│   ├── app.js                 Estado, cliente de API, router, barra lateral
│   └── paginas*.js            Las 13 pantallas
│
├── public-licencias/          Consola del servidor de licencias
│
├── sql/
│   ├── 01-esquema.sql         Esquema completo (idempotente)
│   ├── 01-crear.js            Crea la base y aplica el esquema
│   ├── 03-vista-ciudadanos.js Crea la vista sobre el padrón
│   ├── 90-pruebas.js          Pruebas de extremo a extremo (69)
│   ├── 91-pruebas-licencias.js          Núcleo de licenciamiento (26)
│   ├── 91-pruebas-servidor-licencias.js Servidor de licencias (24)
│   ├── 92-pruebas-qr.js       Código QR: ida y vuelta (16)
│   ├── 93-demo.js             Datos de demostración
│   └── 94-limpiar.js          Borra los datos de prueba
│
├── scripts/
│   ├── generar-llaves.js      Par de llaves del licenciamiento
│   ├── capturar-pantallas.js  Capturas de la interfaz
│   ├── inspeccionar-padron.js Inspección de la base de cédulas
│   ├── verificar-capacidad-qr.js / verificar-tabla-qr.js
│   ├── migrar-fechas.js / revisar-fechas.js
│   └── reparar-texto.js / revisar-texto.js
│
├── licencias-keys/            Las llaves (NO se sube al repositorio)
└── capturas/                  Capturas de pantalla del sistema
```

---

## Pruebas

```powershell
npm run test:todo         # las seis suites, en orden
```

O por separado:

```powershell
npm test                  # 69 pruebas de extremo a extremo
npm run test:produccion   # 17 pruebas con NODE_ENV=production
npm run test:primer-arranque  # 11 pruebas de un despliegue nuevo desde cero
npm run test:impresion    # 23 pruebas de la impresión del gafete (imprime a PDF y mide)
npm run test:personas     # 26 pruebas del directorio de personas y los avisos
npm run test:licencias    # 26 pruebas del núcleo de licenciamiento
npm run test:servidor-licencias  # 24 pruebas del servidor de licencias (requiere npm run licencias)
npm run test:qr           # 16 pruebas del generador de QR
```

Las suites se limpian solas y se pueden repetir.

**`test:produccion` merece una explicación.** Las demás suites corren en modo
desarrollo, y hay cosas que solo se comportan distinto en producción. Esta
levanta una instancia aparte, en un puerto propio, con `NODE_ENV=production` y
su propia licencia, y comprueba que:

- la utilidad de acceso de desarrollo queda **desactivada** (404);
- la institución y su administrador **se crean solos** al arrancar;
- se puede entrar con la clave que el servidor dejó en el archivo;
- la consulta de cédulas, el registro, el gafete y la salida funcionan;
- **la hora de entrada no queda corrida** y la duración es positiva;
- los archivos estáticos **sí se cachean** en producción;
- la auditoría registra la operación.

**`test:primer-arranque` prueba el caso más delicado del despliegue.** Un VPS
recién instalado no tiene licencia, y sin licencia no hay institución; y sin
institución no hay ningún usuario, así que no hay forma de iniciar sesión. Si
activar la licencia exigiera sesión, el sistema quedaría **bloqueado para
siempre**.

La prueba vacía la base, comprueba que se puede activar sin sesión, y verifica
que la puerta **se cierra** en cuanto existe una institución. Antes de tocar
nada saca un respaldo completo a disco, y restaura al terminar.

### Copias de seguridad

```powershell
npm run respaldo:probar     # averigua en qué carpeta puede escribir SQL Server
npm run respaldo            # saca una copia
npm run respaldo:listar     # las que hay
npm run respaldo:restaurar  # restaura la más reciente
```

**Empiece por `respaldo:probar`.** El archivo del respaldo lo escribe **SQL
Server**, no este programa, y su cuenta de servicio no puede escribir en el
Escritorio del usuario. Ese script prueba varias carpetas, dice cuál funciona y
la deja anotada para los demás.

La restauración **no sobrescribe la base en uso**: la pone en una base nueva y
solo al final la renombra, para no quedarse sin nada si el respaldo estuviera mal.

### Cuánto pesa la base de cédulas

```powershell
npm run padron:medir        # mide de verdad y calcula el tiempo de subida
```

Hace un respaldo comprimido de prueba, lo mide y lo borra. Sirve para saber a qué
se enfrenta antes de subir la base al VPS:

| Concepto | Medido |
|---|---|
| Registros | 7.856.023 |
| Datos de la tabla `PADRON` | **427 MB** (57 bytes por registro) |
| Archivo en disco | 1.536 MB (el resto es espacio reservado) |
| **Respaldo comprimido** | **274 MB** ← lo que se sube |
| Subida a 5 Mbps | 8 minutos |

Compárelo con la base original, con fotos: **86.508 MB**, o **40 horas** de
subida a 5 Mbps. Esa diferencia es toda la razón de que este sistema exista.

### Impresión del gafete

```powershell
npm run test:impresion      # imprime a PDF en los tres formatos y mide el resultado
```

Comprueba de verdad, no de oído: genera las hojas, las imprime con Chrome sin
interfaz y **mide el tamaño del PDF resultante**. Los PDF quedan en
`tmp/impresion/` para mirarlos.

Hay tres formatos, y la institución elige el suyo (se recuerda en el navegador):

| Formato | Tamaño de página | Para qué |
|---|---|---|
| Hoja A4 | 210 × 297 mm | Cualquier impresora de oficina |
| A4 ajustado | 210 × 297 mm, sin márgenes de más | Aprovechar la hoja |
| Térmica | **el tamaño de la etiqueta** (105 × 74 mm por defecto) | Impresora de gafetes |

También se pueden pedir varias copias: en A4 salen todas en la misma hoja.

#### Lo que costó descubrir esto

El tamaño de la página no se puede resolver desde la hoja de estilos. Se probó
imprimiendo a PDF y midiendo, y el resultado fue:

| Cómo se intentó | Resultado |
|---|---|
| `@page { size: A4 }` sin condiciones | Vale para todos: no distingue formatos |
| `body.imp-termica { size: ... }` | **Chrome lo ignora.** Sale en A4 |
| `body:has(.gafete) { size: ... }` | **También lo ignora** |
| `@page` escrito en el documento | Funciona |
| `@page` inyectado con un retardo | Funciona |

Por eso la impresión **no se hace desde la pantalla**: el servidor genera una
hoja aparte (`/api/gafetes/visita/:id/hoja`) que contiene solo el gafete y su
propia regla `@page` desde el principio. Esa hoja es la que va a la impresora.
De paso, al no tener barra lateral ni diálogos, no hay nada que esconder al
imprimir — que es justo donde se cuelan estos errores.

**La hoja lleva el diseño incrustado**, no enlazado. Enlazarla parecía más
limpio, pero al imprimir desde un archivo el enlace no resuelve y el gafete sale
en texto plano. Eso llegó a pasar desapercibido: el PDF medía lo correcto y
estaba sin una sola línea de diseño. Ahora hay una prueba que lo vigila.

### Comprobaciones de fechas

Las fechas fueron el punto más delicado del sistema, así que tienen sus propias
herramientas de diagnóstico:

```powershell
npm run fechas:probar    # mide el viaje de una fecha por SQL Server, de cuatro formas
npm run fechas:revisar   # revisa columna por columna si algún valor quedó desplazado
npm run horas:auditar    # busca visitas con la entrada en el futuro o duraciones imposibles
```

**Si algo va mal con las horas o las duraciones, empiece por `npm run
fechas:probar`.** Mide, no adivina: inserta la misma fecha de cuatro maneras
distintas y dice cuál es la correcta en su servidor. La cuarta forma —declarar
el parámetro como `DateTimeOffset`— es la que usa el sistema, y fue justamente
la que faltaba al principio.

Y `npm run horas:auditar` responde a la pregunta práctica: *¿las horas que hay
guardadas son de fiar?* Separa los registros por antigüedad, así que distingue
entre «hay datos viejos mal fechados» y «el problema sigue ocurriendo».

### Comprobaciones del despliegue

Como Docker no está instalado en esta máquina, el despliegue se comprueba de
otras dos formas que no necesitan Docker:

```powershell
npm run despliegue:revisar   # revisa el Dockerfile, el Compose y el .dockerignore
npm run despliegue:simular   # reproduce el sistema de archivos de la imagen y arranca los servidores ahí
```

**`despliegue:revisar`** comprueba lo que suele romperse y no se descubre hasta
que el contenedor ya está arriba: que el Dockerfile copie todo lo que el código
necesita en ejecución, que ningún `require()` apunte a un archivo que quedaría
fuera, que el `.dockerignore` no excluya algo imprescindible, que el Compose
tenga los tres servicios con sus variables, y —lo más importante— que **la
aplicación no reciba la clave privada del licenciamiento**.

**`despliegue:simular`** va más allá: copia a una carpeta temporal exactamente
los archivos que copiaría el Dockerfile, respetando el `.dockerignore`, y
arranca los dos servidores desde ahí **sin `.env` y sin la carpeta
`licencias-keys/`**, con toda la configuración por variables de entorno y las
llaves en base64 — igual que en el VPS. Si algo dependiera de un archivo que no
entra en la imagen, falla aquí y no en el servidor.

```powershell
npm run verificar   # las dos comprobaciones anteriores, en orden
```

**Sobre el generador de QR:** no es una librería, está escrito aquí y está
verificado de dos formas independientes:

1. **Ida y vuelta**: las pruebas incluyen un decodificador propio que recorre la
   matriz como exige la norma, quita la máscara, desentrelaza los bloques y
   comprueba que el texto leído es el escrito. Si la colocación de los módulos,
   la máscara o la información de formato estuvieran mal, el texto no coincidiría.
2. **Contra una implementación de referencia**: se compararon las palabras de
   datos (no las celdas, porque la máscara puede elegirse legítimamente distinta)
   contra la librería `qrcode` en versiones 1 a 9 y los cuatro niveles de
   corrección: **idénticas**.

Además, 1200 tamaños de texto comprobados para verificar que la versión elegida
siempre tiene capacidad suficiente y es la más pequeña posible.

---

## Despliegue en el VPS con Dokploy

**La guía completa, paso a paso, está en [DESPLIEGUE.md](DESPLIEGUE.md).** Esto
es el resumen.

El proyecto trae `Dockerfile` y `docker-compose.yml` listos. Dokploy levanta
tres servicios: `bd-sistema` (SQL Server), `licencias` y `app`.

**Lo primero: las llaves.** En su máquina:

```powershell
npm run keys:gen
# Convertir a base64 para las variables de entorno:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("licencias-keys\privada.pem"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("licencias-keys\publica.pem"))
```

La **privada solo va en el servidor de licencias**. Si esa llave se filtra,
cualquiera puede emitir licencias válidas.

**Variables que hay que definir** en la pestaña *Environment* de Dokploy:

| Variable | Qué es |
|---|---|
| `CLAVE_SQL` | Contraseña del usuario `sa`. Invente una larga. |
| `JWT_SECRET` | Secreto de las sesiones. Largo y aleatorio. |
| `ADMIN_TOKEN` | Protege la consola de licencias. |
| `LICENCIA_LLAVE_PRIVADA_B64` | La llave privada, en base64. |
| `LICENCIA_LLAVE_PUBLICA_B64` | La llave pública, en base64. |
| `URL_PUBLICA` | El dominio real, para los enlaces de correo. |

Ninguna es opcional: el Compose usa `${VARIABLE:?mensaje}`, así que si falta
alguna el despliegue se detiene y dice cuál. Es a propósito.

**La base de cédulas** no se descarga: hay que subir el respaldo `.bak` una vez
y restaurarlo. En `DESPLIEGUE.md` están los comandos exactos.

**Preparar la base del sistema** la primera vez:

```bash
docker exec -it visitaflow-app node sql/01-crear.js
docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js
docker compose restart app
```

**No hay que emitir ninguna licencia a mano.** El sistema arranca sin licencia y
muestra la pantalla de activación: se pega ahí el archivo `.vflow` del cliente y
el propio sistema crea la institución, sus catálogos y el administrador. Después:

```bash
docker exec -it visitaflow-app cat /app/datos/CLAVE-ADMINISTRADOR.txt
```

El servidor de licencias **no se publica en Internet**: se queda en la red
interna de Compose y se administra por túnel SSH.

**La licencia y las credenciales del administrador viven dentro del volumen**
(`/app/datos`), no en la raíz del proyecto. Si vivieran fuera, cada redespliegue
se las llevaría y habría que activar el sistema otra vez.

---

## Notas de seguridad

- Las contraseñas se guardan con **bcrypt**. Nunca en texto plano.
- Las sesiones son **JWT** firmados; la cookie es `HttpOnly`.
- La **clave privada del licenciamiento nunca entra en la imagen** (excluida en
  `.dockerignore`) ni en el repositorio.
- El contenedor corre como **usuario sin privilegios**, no como root.
- El **límite de intentos** de acceso cuenta solo los fallos: entrar y salir
  varias veces al día es lo normal en recepción y no debe castigarse.
- Los catálogos y la lista de vigilancia usan **baja lógica**: los registros
  históricos siguen apuntando a ellos.

---

## Si algo va mal

| Síntoma | Qué mirar |
|---|---|
| **Perdió la contraseña del administrador** | `node scripts/restablecer-admin.js junta-los-prados` (sin argumento, lista las instituciones) |
| «No hay conexión con el sistema» | Que `npm start` esté corriendo y que `DB_PASSWORD` sea correcta |
| «La base de cédulas no está disponible» | Que `PadronLigero` exista y que `dbo.CIUDADANOS` esté creada |
| Las duraciones salen negativas o las horas están corridas | `npm run fechas:probar` para medir, y `npm run horas:auditar` para ver qué registros están mal |
| Hay visitas con la entrada en el futuro | `npm run horas:auditar`; si son datos de prueba, `npm run limpiar && npm run demo` |
| El CSV sale con acentos rotos | `npm run texto:revisar` y `npm run texto:reparar` |
| «La firma de la licencia NO es válida» | El archivo fue editado, o se emitió con otra llave. Pida una nueva. |
| El servidor de licencias da 404 | Otro proceso ocupa el puerto: `Get-NetTCPConnection -State Listen -LocalPort 4100` |
| Acentos raros en la consola | Es la consola de Windows, no los archivos: compruébelo con `npm run texto:revisar` |
| El nombre de la institución cambió solo | Ya no debería pasar: el nombre solo se escribe al crear la institución. Cámbielo en Personalización. |

---

## Estado

Probado de punta a punta en local con la base de cédulas real (7.856.023
registros):

| Suite | Pruebas |
|---|---|
| Extremo a extremo (registro, gafete, salida, vigilancia, pre-registro, reportes, configuración, usuarios, permisos, aislamiento entre instituciones, licenciamiento) | 69 |
| Directorio de personas y avisos al anfitrión | 26 |
| Núcleo de licenciamiento (incluida la manipulación del archivo) | 26 |
| Servidor de licencias | 24 |
| Impresión del gafete (tres formatos, tamaño de página medido sobre el PDF, copias) | 23 |
| Modo producción (arranque, acceso real, flujo completo, caché, auditoría) | 17 |
| Generador de QR | 16 |
| Primer arranque (instalación vacía, activación sin sesión, la puerta se cierra) | 11 |
| **Total** | **212** |

Además:

- El generador de QR se comparó contra la librería `qrcode` en las versiones 1 a
  9 y los cuatro niveles de corrección: **palabra por palabra idénticos**.
- 1200 tamaños de texto comprobados para verificar la elección de versión.
- El despliegue se validó con `npm run verificar`, que revisa el Dockerfile, el
  Compose y el `.dockerignore`, comprueba que **todos los comandos del manual
  apunten a archivos que existirán dentro del contenedor**, y además **arranca
  los dos servidores desde el sistema de archivos que tendría la imagen**, sin
  `.env` y sin las llaves en disco.

Las capturas en `capturas/` son del sistema funcionando.
