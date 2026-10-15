# VisitaFlow en el VPS 206.183.130.121

Cuaderno operativo. Se sigue de arriba abajo, en orden, y al terminar queda el sistema
de visitantes con HTTPS, la base de cédulas cargada y el servidor de licencias
atendiendo a los clientes.

**Los valores son los de este servidor.** El único que falta por decidir es el nombre
del dominio: aparece como `<tu-dominio>` y hay que sustituirlo en todo el documento.

> `DESPLIEGUE.md` cuenta lo mismo en general, con dominios de ejemplo. **Este documento
> es el de este servidor**: mismos pasos, valores reales y lo que se ha aprendido
> desplegando. Si los dos se contradicen, manda este.

| Dato | Valor |
|---|---|
| VPS | `206.183.130.121`, 8 GB de RAM |
| Panel de Dokploy | <http://206.183.130.121:3000> |
| Repositorio | <https://github.com/cuentadetrabajo1611-max/VisitanteRD> (público, rama `main`) |
| Servicios | `bd-sistema` (SQL Server), `licencias` (4100), `app` (3000) |

---

## Índice

1. Lo que necesitas antes de empezar
2. Las dos vías para desplegar, y cuál usar
3. Vía A — a mano en el panel (la recomendada)
4. Vía B — por la API de Dokploy (3 comandos)
5. Los valores exactos que hay que poner
6. La contraseña de SQL Server
7. Los dos dominios, y por qué el de licencias no es opcional
8. Terminar de armar la instalación: base, activación y primer acceso
9. Subir la base de cédulas (el padrón)
10. Comprobar que quedó bien
11. Problemas conocidos y cómo se arreglan
12. Qué sobrevive a un redespliegue y qué no
13. El día a día: tu panel de licencias
14. Copias de seguridad
15. Lo que no hay que hacer

---

## 1. Lo que necesitas antes de empezar

| Necesitas | Valor concreto | Cómo se comprueba |
|---|---|---|
| El VPS encendido, con Dokploy | `206.183.130.121` · panel en <http://206.183.130.121:3000> | Abrir esa dirección |
| Acceso SSH | `ssh root@206.183.130.121` (usa tu usuario real) | Que entre |
| El repositorio, accesible | `cuentadetrabajo1611-max/VisitanteRD`, rama `main` | Abrilo en el navegador sin sesión: es público |
| Los dos nombres de dominio | `visitas.<tu-dominio>` y `licencias.<tu-dominio>` | `Resolve-DnsName visitas.<tu-dominio> -Type A` → `206.183.130.121` |
| Puertos 80 y 443 abiertos al mundo | — | `Test-NetConnection 206.183.130.121 -Port 443` desde tu máquina |
| El par de llaves del licenciamiento | `licencias-keys\privada.pem` y `publica.pem` | `dir licencias-keys` |
| Node 20 o superior en tu máquina | — | `node -v` |
| El respaldo del padrón | `C:\TempSQL\PadronLigero.bak`, 274 MB | `(Get-Item C:\TempSQL\PadronLigero.bak).Length` |
| Espacio libre en el VPS | 5 GB o más | En el VPS: `df -h /var/lib/docker` |

Dos avisos sobre esta lista:

- **Las llaves se generan una sola vez en la vida** (`npm run keys:gen`). Si ya
  existen, no las vuelvas a generar: cada instalación que tenga la llave pública vieja
  dejaría de verificar las licencias nuevas. Guarda `privada.pem` en dos sitios
  distintos: sin ella no puedes emitir ni renovar nada.
- **El dominio no es decorativo**: es la dirección por la que tus clientes alcanzan tu
  servidor de licencias. Sin él, la activación por ID solo funciona dentro de tu red.

---

## 2. Las dos vías para desplegar, y cuál usar

| | **Vía A — panel + repositorio** | **Vía B — API de Dokploy** |
|---|---|---|
| Quién lo hace | Tú, en el panel | `npm run desplegar` |
| Qué llega al servidor | El repositorio completo: código y compose | Solo el `docker-compose.yml` (modo `raw`) |
| Dominios | Los pones en la pestaña **Domains** | Los configura el script, antes de desplegar |
| Sirve para | Desplegar de verdad | Comprobar y consultar estado |

**Usa la Vía A.** El motivo es el `Dockerfile`: la imagen se construye a partir del
código (`COPY server.js`, `COPY src`, `COPY sql`…) y el contexto de construcción tiene
que ser el repositorio. La API de Dokploy sube el compose en modo `raw`, sin
repositorio, así que en el servidor solo quedaría el `docker-compose.yml` y la
construcción fallaría en el primer `COPY`.

De la Vía B sí conviene quedarse con dos comandos, que no cambian nada:
`npm run desplegar:comprobar` (revisa el token, el compose, las variables y los
dominios) y `npm run desplegar:estado` (dice cómo va y consulta `/api/salud`).

---

## 3. Vía A — a mano en el panel (la recomendada)

### Paso A1 — Generar y guardar los valores, una sola vez

```powershell
cd "C:\Users\Admin\Desktop\Escritorio\Padron Junta\visitaflow"

npm run keys:gen              # solo si NO existe la carpeta licencias-keys\
npm run desplegar:preparar    # imprime CLAVE_SQL, JWT_SECRET, ADMIN_TOKEN y las llaves en base64
```

Copia los cinco valores a tu gestor de contraseñas antes de seguir: el script no los
vuelve a mostrar y `CLAVE_SQL` no se puede cambiar después sin consecuencias (ver la
sección 6). Ninguna de esas cosas se sube al repositorio: `.env` y `licencias-keys/`
están excluidos en `.gitignore` y en `.dockerignore`.

> **Mira la `CLAVE_SQL` que te dio el script.** Se genera al azar y **puede no llevar
> ningún símbolo**, y SQL Server la rechaza si no lo lleva. Cerca de una de cada cinco
> veces pasa. Si no tiene símbolo, añádele uno (por ejemplo `!7` al final) antes de
> pegarla en Dokploy.

### Paso A2 — Apuntar los dos dominios al VPS

En tu proveedor de DNS, dos registros **A** que apunten a `206.183.130.121`:
`visitas.<tu-dominio>` y `licencias.<tu-dominio>`.

```powershell
Resolve-DnsName visitas.<tu-dominio> -Type A      # tiene que devolver 206.183.130.121
Resolve-DnsName licencias.<tu-dominio> -Type A
```

Hazlo **antes** de desplegar. Traefik pide el certificado a Let's Encrypt durante el
despliegue y Let's Encrypt comprueba el dominio: si el DNS todavía no responde, el
certificado falla y el HTTPS queda roto aunque los contenedores estén perfectos.

### Paso A3 — Crear el proyecto y el servicio

1. <http://206.183.130.121:3000> → **Projects** → **Create Project** → `visitaflow`.
2. Dentro del proyecto: **Create Service** → **Docker Compose**.
3. **Source**: conecta el repositorio con el proveedor que tengas dado de alta en
   Dokploy (GitHub, o Git con la clave que Dokploy genera y que subes como *deploy
   key* en GitHub). Comprueba que quedan exactamente así:
   - Propietario/organización: `cuentadetrabajo1611-max`
   - Repositorio: `VisitanteRD`
   - Rama: `main`
4. **Compose Path**: `docker-compose.yml` (está en la raíz del repositorio).

No despliegues todavía: primero el dominio y las variables. En un compose, los
dominios y las variables son etiquetas de Docker y se aplican al desplegar; si los
pones después, no surten efecto hasta el despliegue siguiente.

### Paso A4 — Las variables, en la pestaña Environment

> **El despliegue se detiene solo** si falta alguna de las obligatorias, con un mensaje
> que dice cuál, porque el compose usa `${VARIABLE:?mensaje}`. Es a propósito: mejor
> que falle al desplegar a que arranque con un secreto vacío.

Pega esto, con tus valores (tabla completa en la sección 5):

```env
# --- Secretos: los imprime "npm run desplegar:preparar" ---
CLAVE_SQL=<la que generó, con símbolo>
JWT_SECRET=<la que generó>
ADMIN_TOKEN=<la que generó>

# --- Direcciones públicas de ESTE servidor ---
URL_PUBLICA=https://visitas.<tu-dominio>
LICENCIA_SERVIDOR_URL=https://licencias.<tu-dominio>

# --- Llaves del licenciamiento, en base64 y en UNA sola línea cada una ---
LICENCIA_LLAVE_PRIVADA_B64=<la privada>
LICENCIA_LLAVE_PUBLICA_B64=<la pública>
```

La llave privada **solo la usa el servicio `licencias`**; el compose ya la separa y la
aplicación nunca la recibe.

### Paso A5 — Los dos dominios, en la pestaña Domains

| Servicio | Puerto interno | Dominio | HTTPS |
|---|---|---|---|
| `app` | `3000` | `visitas.<tu-dominio>` | Let's Encrypt |
| `licencias` | `4100` | `licencias.<tu-dominio>` | Let's Encrypt |

El campo **Service Name** tiene que ser el nombre del servicio **dentro del compose**
(`app` y `licencias`), no el nombre del servicio en Dokploy: es lo que Traefik usa para
enrutar. Los dos llevan dominio; el motivo está en la sección 7.

### Paso A6 — Deploy

Dale a **Deploy** y mira los registros. El orden es este:

1. Se descarga la imagen de SQL Server y arranca. **Tarda un minuto o dos.**
2. `licencias` arranca e imprime su `key_id`.
3. `app` arranca. Como la base todavía no existe, **dice que hay que crearla: es
   correcto y esperado.** La aplicación no se cae sin base a propósito, para poder
   arreglarlo con el contenedor en marcha.

Sigue por la **sección 8** para crear la base, activar y entrar, y por la **sección 9**
para el padrón.

---

## 4. Vía B — por la API de Dokploy (3 comandos)

```powershell
cd "C:\Users\Admin\Desktop\Escritorio\Padron Junta\visitaflow"

# 1. Los valores y las llaves en base64 (no toca el servidor)
npm run desplegar:preparar

# 2. El token y los dominios, solo en esta sesión de PowerShell
$env:DOKPLOY_TOKEN = "<token de Settings -> Profile -> API/CLI -> Generate token>"
$env:VISITAS_DOMINIO   = "visitas.<tu-dominio>"
$env:LICENCIAS_DOMINIO = "licencias.<tu-dominio>"

# 3. Revisar sin tocar nada y, si todo está bien, desplegar
npm run desplegar:comprobar
npm run desplegar
```

Después: `npm run desplegar:estado`, que dice el estado del compose y consulta
`URL_PUBLICA/api/salud`.

Tres cosas que hay que saber de esta vía:

- **Ese token da control total sobre tu Dokploy**: puede crear, desplegar y borrar
  cualquier cosa del servidor. Trátalo como la contraseña del VPS y revócalo donde lo
  generaste cuando termines.
- **El script deja el servicio en modo `raw`** (`sourceType: 'raw'`), sin repositorio
  conectado. Si el servicio ya estaba conectado al repositorio, se lo lleva por delante:
  no lo ejecutes sobre un servicio que ya funciona. Si al desplegar los registros dicen
  `COPY failed: file not found in build context`, es justo esto: vuelve a conectar el
  repositorio en **Source** y despliega desde el panel.
- Los dominios se crean **antes** de desplegar. Si creas el servicio con la API y los
  dominios después, hay que volver a desplegar para que Traefik los vea.

---

## 5. Los valores exactos que hay que poner

| Variable | Valor exacto para este servidor | Quién la usa | ¿Obligatoria? |
|---|---|---|---|
| `CLAVE_SQL` | la imprime `npm run desplegar:preparar` (unos 48 caracteres al azar) | `bd-sistema`, `app` | **Sí** |
| `JWT_SECRET` | la imprime el mismo script | `app` | **Sí** |
| `ADMIN_TOKEN` | la imprime el mismo script | `licencias` | **Sí** |
| `LICENCIA_LLAVE_PRIVADA_B64` | `privada.pem` en base64, una línea | `licencias` | **Sí** |
| `LICENCIA_LLAVE_PUBLICA_B64` | `publica.pem` en base64, una línea | `licencias` y `app` | **Sí** |
| `URL_PUBLICA` | `https://visitas.<tu-dominio>` | `app` | No, pero sin ella los enlaces de los correos salen con `localhost` |
| `LICENCIA_SERVIDOR_URL` | `https://licencias.<tu-dominio>` | `app` | No, pero su valor por defecto es la dirección interna `http://licencias:4100` |
| `PADRON_ACTIVO` | `1` | `app` | No (por defecto `1`) |
| `IDENTIDAD_EXIGIR_EN_PADRON` | `0` | `app` | No (por defecto `0`: se puede registrar a mano si la cédula no aparece) |
| `CORREO_ACTIVO`, `SMTP_*`, `MAIL_FROM` | `0` y vacíos | `app` | No |
| `VISITAS_DOMINIO`, `LICENCIAS_DOMINIO` | los dos dominios | solo el script de la Vía B | No; sin ellas no configura ningún dominio |

Dos detalles que se pagan caros:

- **`LICENCIA_SERVIDOR_URL` es el nombre en el compose; la aplicación lee
  `LICENCIA_SERVIDOR`.** El compose hace la traducción; en la pestaña Environment se
  escribe `LICENCIA_SERVIDOR_URL`, nunca `LICENCIA_SERVIDOR`.
- **Ponla pública aunque este servidor se alcance por dentro.** Al arrancar, la
  aplicación consulta esa dirección y escribe en el registro la llave que encontró. Si
  apunta a la dirección interna, esa comprobación siempre pasa y no prueba nada; si
  apunta a la pública, estás probando en cada arranque exactamente el camino que van a
  recorrer tus clientes: DNS, HTTPS y llaves.

---

## 6. La contraseña de SQL Server

`CLAVE_SQL` es la contraseña del usuario `sa` y la usan los tres servicios. Tiene que
cumplir la política de SQL Server:

- **8 caracteres como mínimo** (la que genera el script tiene unos 48),
- **una mayúscula, una minúscula y un símbolo**,
- sin comillas simples ni dobles, y sin `$` ni `#` (rompen el `.env`, el `-P` de
  `sqlcmd` y el shell).

**Si no la cumple, `bd-sistema` arranca y se muere en bucle.** El motivo está en su
registro, en una línea fácil de perder entre el ruido de arranque:

```bash
docker logs visitaflow-bd 2>&1 | grep -i "password"
# Password validation failed. The password does not meet SQL Server password policy requirements...
```

Arréglalo cambiando `CLAVE_SQL` en **Environment**, poniendo un símbolo, y desplegando
otra vez. Como el volumen de datos todavía no existe, el contenedor la toma sin
problema.

> **Si cambias `CLAVE_SQL` con el volumen ya creado, la aplicación deja de conectar.**
> La contraseña de `sa` se fija al inicializar la base la primera vez; cambiar la
> variable después **no** la cambia, y `app` empieza a fallar con
> `Login failed for user 'sa'`. Si necesitas cambiarla de verdad, hay que hacer las dos
> cosas: cambiarla en SQL Server y cambiarla en la variable.
>
> ```bash
> docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "LA_VIEJA" -C \
>   -Q "ALTER LOGIN sa WITH PASSWORD = 'LA_NUEVA'"
> ```
>
> Y no uses la misma cadena para `CLAVE_SQL`, `JWT_SECRET` y `ADMIN_TOKEN`.

---

## 7. Los dos dominios, y por qué el de licencias no es opcional

| Dominio | Servicio | Puerto | Quién lo usa |
|---|---|---|---|
| `visitas.<tu-dominio>` | `app` | `3000` | Tú y tus operadores: el sistema de visitantes |
| `licencias.<tu-dominio>` | `licencias` | `4100` | **Tus clientes**, para activar y renovar |

El de `app` podría quedarse sin dominio si solo lo usaras tú. **El de `licencias` no**:
cada instalación de cliente pregunta a esa dirección cuando alguien escribe un ID
`LIC-XXXXXXXX`. Los clientes están en sus propias redes, así que no llegan a una
dirección interna de Docker como `http://licencias:4100`.

Qué protege y qué no: las rutas de administración exigen el `ADMIN_TOKEN` (sin él,
`401`), y lo único abierto es la activación por ID, que solo devuelve la licencia del
cliente que ya tiene ese ID.

**Si no tienes dominio**, hay dos salidas y ninguna es tan buena:

1. Un nombre que resuelva solo a la IP: `licencias.206.183.130.121.sslip.io`. Apunta a
   `206.183.130.121` sin tocar el DNS y Let's Encrypt puede emitir el certificado.
   Vale para empezar; para vender, un dominio propio.
2. Publicar el puerto y usar la IP en claro (`http://206.183.130.121:4100`): hay que
   añadir `ports: - '4100:4100'` al servicio, no hay HTTPS y el `ADMIN_TOKEN` viaja sin
   cifrar. No lo dejes así.

---

## 8. Terminar de armar la instalación: base, activación y primer acceso

### Paso 8.1 — Crear la base del sistema

```bash
docker exec -it visitaflow-app node sql/01-crear.js
```

Crea las 22 tablas, los permisos y los catálogos. Es idempotente: se puede repetir sin
miedo. No hace falta reiniciar nada, la aplicación reintenta la conexión sola.

### Paso 8.2 — Emitir la licencia de esta instalación

Entra a `https://licencias.<tu-dominio>` y pega el `ADMIN_TOKEN` (se guarda solo
mientras dure la pestaña del navegador). Pulsa **+ Nueva licencia** y rellena:

| Campo | Qué poner |
|---|---|
| Código de la institución (`tenant`) | `junta-los-prados` — **minúsculas, números y guiones, entre 3 y 40 caracteres** |
| Cliente | El nombre que quieres ver en el panel |
| Días | `365` por defecto |
| Usuarios / Instalaciones | `5` y `1` por defecto |
| Días de gracia | `15` por defecto: sigue operando después de vencer |
| Módulos | Los 10 vienen marcados |

Te devuelve un **ID** con formato `LIC-XXXXXXXX`.

> **El código de institución no se cambia nunca.** Es la identidad de esa instalación
> (su nombre es otra cosa, y se cambia en Personalización). Si lo cambias, su licencia
> deja de reconocerla.

### Paso 8.3 — Activar

Abre `https://visitas.<tu-dominio>`. Como no hay licencia, sale la pantalla de
activación: escribe el ID y pulsa **Activar con el ID**. Si el cliente no tiene salida
a Internet, se activa con el archivo `.vflow` (botón **↓** de su fila en el panel): se
pega su contenido, o se sube el archivo, en la misma pantalla.

### Paso 8.4 — El sistema queda listo solo, sin reiniciar

No hay que hacer nada más: al activar, el sistema crea su institución, sus catálogos y su
administrador en el momento, y **la propia pantalla de activación te dice el usuario y la
contraseña** para entrar.

> Antes había que reiniciar el contenedor aquí, porque la activación solo guardaba la
> licencia y todo lo demás se creaba al arrancar. Quien activaba se quedaba mirando una
> pantalla que le decía que entrara, sin ningún usuario con el que entrar. Ya no: la
> activación y el arranque usan la misma función.

Para verlo en los registros:

```bash
docker logs --tail 20 visitaflow-app
```

```
[visitaflow] Institución "junta-los-prados" preparada (N registros iniciales).
```

### Paso 8.5 — La clave del administrador, si hace falta

La pantalla de activación ya te la muestra, y además queda en un archivo dentro del
volumen:

```bash
docker exec -it visitaflow-app cat /app/datos/CLAVE-ADMINISTRADOR.txt
```

Ahí están el usuario (`admin@<código>.local`), la contraseña y la dirección. Entra,
**cámbiala** (Usuarios → restablecer) y borra el archivo:

```bash
docker exec -it visitaflow-app rm /app/datos/CLAVE-ADMINISTRADOR.txt
```

Si esa clave se pierde, se restablece sin tocar la base:

```bash
docker exec -it visitaflow-app node scripts/restablecer-admin.js junta-los-prados
```

---

## 9. Subir la base de cédulas (el padrón)

Lo único pesado del despliegue, y se hace **una sola vez por servidor**.

> **De dónde salen estas cifras.** No existe `tmp/informe-padron.md` en el proyecto: los
> números de abajo son los de `DESPLIEGUE.md` y del propio medidor `npm run
> padron:medir`. Si vuelves a medir, actualiza esta tabla con lo que te diga.

| Concepto | Medido |
|---|---|
| Registros | 7.856.023 |
| Datos de la tabla `PADRON` | **427 MB** (57 bytes por registro) |
| Archivo en disco | 1.536 MB (el resto es espacio reservado) |
| **Respaldo comprimido** | **274 MB** ← lo que se sube |
| Subida a 5 Mbps | **~8 minutos** |
| La misma base con fotografías | 86.508 MB y 40 horas de subida |

### Paso 9.1 — Sacar el respaldo en tu máquina

```powershell
sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -Q "BACKUP DATABASE PadronLigero TO DISK = 'C:\TempSQL\PadronLigero.bak' WITH COMPRESSION"
(Get-Item C:\TempSQL\PadronLigero.bak).Length / 1MB     # tiene que dar unos 274
```

Si falla con `Cannot open backup device ... Access is denied`, es que la cuenta de
servicio de SQL Server no puede escribir en esa carpeta: `npm run respaldo:probar`
prueba varias y dice cuál sirve.

### Paso 9.2 — Subirlo al VPS

```powershell
scp "C:\TempSQL\PadronLigero.bak" root@206.183.130.121:/root/
Get-FileHash "C:\TempSQL\PadronLigero.bak" -Algorithm SHA256
```

En el VPS, comprueba que llegó entero antes de restaurar:

```bash
sha256sum /root/PadronLigero.bak        # el mismo hash que en Windows
df -h /var/lib/docker                   # quedan 5 GB libres, ¿verdad?
```

Dos cosas que salen mal aquí y conviene saber de antemano: **a 5 Mbps son 8 minutos, y
si la conexión se corta el archivo queda a medias**; el `sha256sum` es lo que lo
detecta, porque el `RESTORE` solo dirá que la cabecera no se entiende. Y el espacio: el
respaldo ocupa 274 MB fuera y otros 274 MB dentro del volumen, más 1.536 MB al
restaurar.

### Paso 9.3 — Meterlo donde el contenedor lo vea

```bash
# El contenedor corre como el usuario mssql (10001): /var/opt/mssql es suyo y es volumen.
docker exec visitaflow-bd mkdir -p /var/opt/mssql/backup
docker cp /root/PadronLigero.bak visitaflow-bd:/var/opt/mssql/backup/PadronLigero.bak
```

Es la vía recomendada porque **no toca el compose**. La alternativa que trae el propio
compose (descomentar `- ./respaldo-padron:/respaldo:ro` y volver a desplegar) tiene dos
pegas: la ruta es relativa a la carpeta del compose que administra Dokploy —no a la
tuya— y ese cambio se pierde en el siguiente despliegue hecho desde el repositorio, que
manda sobre lo que haya en el servidor. Si la usas, súbela al repositorio.

### Paso 9.4 — Restaurar

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -Q \
  "RESTORE DATABASE PadronLigero FROM DISK = '/var/opt/mssql/backup/PadronLigero.bak' WITH MOVE 'PadronLigero' TO '/var/opt/mssql/data/PadronLigero.mdf', MOVE 'PadronLigero_log' TO '/var/opt/mssql/data/PadronLigero_log.ldf', REPLACE"
```

`WITH REPLACE` es para poder repetirlo: sin él, la segunda vez falla porque la base ya
existe. Tarda varios minutos; no cierres la sesión. Si se queja de que la base está en
uso, para la aplicación, restaura y vuelve a arrancarla:

```bash
docker stop visitaflow-app
# ... el RESTORE ...
docker start visitaflow-app
```

Y comprueba que están los 7.856.023:

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -h -1 \
  -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM PadronLigero.dbo.PADRON"
```

### Paso 9.5 — Reiniciar la aplicación (la vista ya viene en el respaldo)

```bash
docker restart visitaflow-app
```

> **La vista `dbo.CIUDADANOS` no hay que crearla**: viaja dentro del respaldo del padrón y
> ya está en la copia restaurada. Se comprobó restaurando el `.bak` en una base aparte y
> consultando la vista. El comando `node sql/03-vista-ciudadanos.js` es idempotente y no
> molesta si lo ejecutas, pero no es lo que hace que la búsqueda sea rápida.

El reinicio es solo para que la aplicación vuelva a probar la conexión con el padrón y lo
informe en `/api/salud`.

Al terminar puedes borrar el archivo del directorio personal del VPS
(`rm /root/PadronLigero.bak`). El que está dentro del volumen puedes dejarlo: es tu copia
de la base de cédulas.

---

## 10. Comprobar que quedó bien

### 10.1 Lo que dicen los registros al arrancar

```bash
docker logs --tail 60 visitaflow-licencias
docker logs --tail 60 visitaflow-app
docker ps            # los tres, en "healthy"
```

| Línea que debe aparecer | Qué significa | Si no está |
|---|---|---|
| `[licencias] llave privada disponible, key_id xxxxxxxx` | El servidor de licencias tiene su llave | Falta `LICENCIA_LLAVE_PRIVADA_B64`, o está mal pegada |
| `[visitaflow] Base de datos conectada: bd-sistema/VisitaFlow` | La base del sistema existe | Paso 8.1 |
| `[visitaflow] Base de cédulas conectada: PadronLigero (dbo.CIUDADANOS)` | El padrón está | Sección 9 |
| `[visitaflow] Servidor de licencias OK: https://licencias... (llave xxxxxxxx)` | Tu instalación alcanza tu servidor por la dirección pública | Revisa la sección 7 antes de darle el ID a un cliente |
| `AVISO: el servidor de licencias usa la llave X y esta instalación espera Y` | Las llaves no son las mismas | Vuelve a activar con las llaves correctas |

**El contenedor se ve `healthy` aunque falte la base**: `/api/salud` contesta `200` y
avisa dentro del JSON. No te fíes del semáforo; mira el JSON.

### 10.2 `/api/salud`

```powershell
$a = Invoke-RestMethod https://visitas.<tu-dominio>/api/salud
"base=$($a.base_datos.disponible) cedulas=$($a.cedulas.disponible) licencia=$($a.licencia.estado) hasta=$($a.licencia.hasta)"
```

| Campo | Valor bueno | Si sale mal |
|---|---|---|
| `base_datos.disponible` | `true` | Paso 8.1; mira `base_datos.motivo` |
| `cedulas.disponible` | `true` | Sección 9 (falta la base o la vista) |
| `licencia.estado` | `activa`, `por_vencer` o `gracia` | `sin_licencia`: paso 8.3 |
| `licencia.dias_restantes` | los que queden | — |
| `servidor_licencias.direccion` | `https://licencias.<tu-dominio>` | Sección 5 |

Y la del servidor de licencias, que además tiene que dar el **mismo `key_id`** que
imprime la aplicación:

```powershell
Invoke-RestMethod https://licencias.<tu-dominio>/api/salud | ConvertTo-Json -Depth 4
```

### 10.3 Pruebas

En tu máquina, contra la base local (no tocan el VPS):

```powershell
npm run despliegue:revisar    # Dockerfile, compose y .dockerignore
npm run despliegue:simular    # arranca los dos servidores como si estuvieran en la imagen (puertos 3210 y 4210)
npm run verificar             # lo anterior, en orden, más la revisión de acentos

npm run test:licencias        # el núcleo del licenciamiento
npm run test:qr               # el generador de QR
npm run test:servidor-licencias   # necesita "npm run licencias" en marcha (puerto 4100)
```

`npm run test:todo` corre las 12 suites, pero **`test:primer-arranque`,
`test:produccion` y `test:despliegue` vacían y restauran la base del sistema de esta
máquina**: no las lances mientras alguien más esté trabajando con esa misma base.

No hay ninguna suite que corra contra el VPS. Lo que se comprueba en el VPS es esto:
los registros del arranque, `/api/salud` y una visita de verdad —registra una cédula
real, mira que el nombre aparezca al instante (con la vista son milisegundos), saca el
gafete e imprímelo.

---

## 11. Problemas conocidos y cómo se arreglan

| Síntoma | Qué pasa | Solución |
|---|---|---|
| El despliegue se detiene: *"Defina CLAVE_SQL"* | Falta esa variable | Pestaña **Environment** |
| `bd-sistema` arranca y se muere en bucle | La contraseña de `sa` no cumple la política | Sección 6: símbolo, y mira `docker logs visitaflow-bd` |
| `COPY failed: file not found in build context` al construir | El servicio quedó en modo `raw`, sin repositorio | Vuelve a conectar el repositorio en **Source** y despliega desde el panel |
| El HTTPS no sale, o Traefik responde 404 | El dominio no apunta al VPS, o faltan los puertos 80/443 | `Resolve-DnsName ... -Type A`; el dominio se configura **antes** de desplegar |
| *"Servidor de licencias ... no respondió"* | No se llega al servidor, o el dominio no está | Revisa `LICENCIA_SERVIDOR_URL` y el dominio del servicio `licencias` |
| *"Las licencias de ese servidor NO se podrán verificar aquí"* | Ese servidor usa otras llaves | Vuelve a emitir con las llaves correctas |
| La aplicación dice que no hay base | Falta crearla | `docker exec -it visitaflow-app node sql/01-crear.js` |
| `/api/salud` dice `cedulas: false` | Falta el padrón o la vista | Sección 9, pasos 9.4 y 9.5 |
| Buscar una cédula tarda segundos | Falta la vista `CIUDADANOS` | `docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js` |
| Tras activar, sigue saliendo el formulario de activación o no hay ningún usuario | La institución y el administrador se crean al arrancar | `docker restart visitaflow-app` (paso 8.4) |
| `Login failed for user 'sa'` después de cambiar `CLAVE_SQL` | El contenedor conserva la contraseña vieja | Sección 6: cámbiala también en SQL Server |
| *"Esa licencia está suspendida"* al activar | La suspendiste desde el panel | Reactívala; el motivo se le muestra al cliente |
| Perdiste la clave del administrador | — | `docker exec -it visitaflow-app node scripts/restablecer-admin.js <institucion>` |
| Perdiste el `ADMIN_TOKEN` | Está en las variables de Dokploy | Cópialo de la pestaña **Environment** |
| `docker exec -it` falla dentro de un script | No hay terminal interactiva | Quita `-it`: `docker exec visitaflow-app node ...` |
| El RESTORE dice que la base está en uso | Hay conexiones abiertas | `docker stop visitaflow-app`, restaura, `docker start visitaflow-app` |
| Dos despliegues del mismo compose en el mismo VPS | Los contenedores tienen nombre fijo (`visitaflow-bd`, `visitaflow-app`, `visitaflow-licencias`) | No lo hagas: chocarían |

---

## 12. Qué sobrevive a un redespliegue y qué no

| Sobrevive (está en un volumen) | Qué hay ahí |
|---|---|
| `datos-sql` | La base del sistema **y** la base de cédulas, con sus respaldos |
| `datos-licencias` | Los clientes: `licencias-emitidas.json` |
| `datos-app` | `licencia.vflow`, `CLAVE-ADMINISTRADOR.txt` y los logos (`archivos/`) |
| Las variables de Dokploy | Los secretos y las direcciones |
| Los dominios configurados | Traefik los vuelve a levantar con su certificado |

| No sobrevive | Por qué |
|---|---|
| Lo que escribas dentro del contenedor fuera de `/app/datos` | El contenedor se recrea con la imagen nueva |
| Los cambios hechos a mano en el compose del servidor | **Manda el compose del repositorio**: si descomentaste algo en el servidor, súbelo al repositorio o se pierde |
| La imagen | Se construye otra vez en cada despliegue |

Esto es así a propósito: la licencia y las credenciales viven **dentro** del volumen. Si
vivieran en la raíz del proyecto, cada redespliegue se las llevaría y habría que volver a
activar el sistema.

---

## 13. El día a día: tu panel de licencias

En `https://licencias.<tu-dominio>`, con el `ADMIN_TOKEN`. Este servidor no guarda datos
de visitantes: solo la lista de clientes y sus licencias.

| Acción | Para qué sirve |
|---|---|
| **+ Nueva licencia** | Crear un cliente: código de institución, cliente, contacto y días. Devuelve su ID `LIC-XXXXXXXX` |
| **Renovar** | Alarga la vigencia. Renueva desde la fecha de vencimiento, así que renovar antes de tiempo no regala días |
| **⏸ Suspender** | Corta el servicio, con un motivo que el cliente verá en su pantalla |
| **▶ Reactivar** | Lo devuelve al servicio |
| **☰ Módulos** | Elige qué incluye su licencia, de los 10 posibles |
| **🕘 Historial** | Todo lo que ha pasado con esa licencia: emisiones, renovaciones, cambios de módulos y suspensiones |
| **↓** | Descarga el archivo `.vflow`, para el cliente sin salida a Internet |

**Entregar una licencia.** Dos caminos, y el cliente elige:

1. **Por ID**: le das el `LIC-XXXXXXXX` y lo escribe en su pantalla de activación. En su
   servidor tiene que estar puesta la dirección pública de tu servidor de licencias.
2. **Con el archivo `.vflow`**: se lo mandas y lo pega en la misma pantalla. Es lo que
   hay que hacer cuando el cliente no tiene Internet.

**Lo que ve el cliente cuando lo suspendes.** Su sistema sigue funcionando en **solo
lectura**: no pierde nada de lo registrado y se reactiva cuando quieras. El motivo que
escribas llega hasta su pantalla de licencia; dejar a alguien sin servicio sin decirle
por qué es lo peor que se puede hacer.

**Si tu servidor de licencias no responde, sus instalaciones no se quedan tiradas**: el
sistema sigue funcionando con la última licencia buena hasta que venza, más los días de
gracia que le hayas puesto al emitirla (15 por defecto).

**Los módulos se venden por partes.** El cambio llega en la siguiente consulta, sin
reinstalar nada. Se pueden quitar los que se venden aparte (reportes, vigilancia,
pre-registro, API). Los que sostienen la operación (registro, recepción, gafetes,
personalización, usuarios) **no se bloquean nunca**: dejar a un recepcionista sin poder
registrar con gente en la puerta es peor que una licencia impagada.

**Las activaciones quedan anotadas**: cada vez que una instalación se activa o renueva,
el servidor guarda la huella del equipo, su descripción y cuántas veces lo ha hecho. En
la ficha del cliente ves en qué máquinas está instalado y cuántos equipos permite su
licencia: es el dato con el que se decide si una licencia se está repartiendo más de la
cuenta.

---

## 14. Copias de seguridad

El respaldo de la base lo escribe **SQL Server**, no la aplicación:

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -Q \
  "BACKUP DATABASE VisitaFlow TO DISK = '/var/opt/mssql/backup/VisitaFlow.bak' WITH COMPRESSION"
docker cp visitaflow-bd:/var/opt/mssql/backup/VisitaFlow.bak .
```

Y tres cosas que hay que sacar del VPS, porque un volumen que solo vive ahí **no es una
copia de seguridad: es el mismo disco**:

```bash
docker cp visitaflow-licencias:/app/datos/licencias-emitidas.json .   # tus clientes
docker cp visitaflow-app:/app/datos/licencia.vflow .                  # la licencia de esta instalación
```

La tercera no se saca de ningún contenedor: **`licencias-keys\privada.pem`**. Es la llave
con la que se firman todas las licencias. Guárdala en dos sitios y fuera de este
proyecto. Si se pierde, no puedes renovar ni emitir nada que las instalaciones ya
desplegadas acepten.

---

## 15. Lo que no hay que hacer

- **No** subas `licencias-keys/privada.pem` al repositorio.
- **No** uses la misma cadena para `CLAVE_SQL`, `JWT_SECRET` y `ADMIN_TOKEN`.
- **No** borres los volúmenes `datos-sql`, `datos-licencias` ni `datos-app`.
- **No** ejecutes `npm run desplegar` sobre un servicio que ya está conectado al
  repositorio: lo pasa a modo `raw` y la próxima construcción falla.
- **No** cambies `CLAVE_SQL` con la base ya creada sin cambiarla también en SQL Server.
- **No** cambies el código de institución (`tenant`) de un cliente que ya está operando.
- **No** confíes en que el VPS hace copias de seguridad. No las hace.
