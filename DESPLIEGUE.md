# Desplegar VisitaFlow en el VPS con Dokploy

Guía paso a paso, desde cero hasta el sistema funcionando con HTTPS y el panel de
licencias atendiendo a tus clientes.

---

## Dos formas de desplegar: elige una

| | **Por la API** (más rápido) | **A mano, en el panel** |
|---|---|---|
| Qué necesitas | Un token de API de Dokploy | El repositorio en Git |
| Quién lo hace | `npm run desplegar` | Tú, siguiendo los pasos |
| Dominios | Se configuran solos | Los pones en la pestaña Domains |
| Pasos | 3 | 9 |

**Si es la primera vez, usa la API**: está probado contra tu Dokploy y hace las
comprobaciones antes de tocar nada. Los pasos manuales están más abajo, por si
prefieres verlo todo en el panel o quieres entender qué hace cada cosa.

---

## Cómo funciona esto, en una frase

Este despliegue es **tu servidor**: levanta el sistema de visitantes y, sobre
todo, levanta **el servidor de licencias que atiende a todos tus clientes**. Cada
cliente instala su propia copia en su servidor y la activa con un ID que le das
tú.

```
   TU VPS (este despliegue)                    EL SERVIDOR DE CADA CLIENTE
   ┌─────────────────────────────┐             ┌──────────────────────────┐
   │  bd-sistema (SQL Server)    │             │  Su propia copia de      │
   │  app        → tu dominio    │             │  VisitaFlow, con su base │
   │  licencias  → su dominio    │◄────────────┤  y su base de cédulas    │
   │    · clientes               │  activa con │                          │
   │    · módulos                │  su ID      │                          │
   │    · activar / suspender    │             │                          │
   └─────────────────────────────┘             └──────────────────────────┘
```

**El servidor de licencias necesita dominio público.** Los clientes están en sus
propias redes, así que no llegan a una dirección interna de Docker: necesitan una
dirección de Internet con HTTPS. Eso es lo que se configura en
`LICENCIA_SERVIDOR_URL`.

---

## Camino A — Desplegar por la API (recomendado)

### Paso A1 — Generar el token de API

En tu panel de Dokploy: **Settings** → **Profile** → sección **API/CLI** →
**Generate token**.

> **Ese token da control total sobre tu Dokploy**: puede crear, desplegar y borrar
> cualquier cosa del servidor. Trátalo como la contraseña del VPS. Se puede
> revocar desde el mismo sitio donde lo generaste.

### Paso A2 — Preparar los valores

```powershell
cd visitaflow
npm run desplegar:preparar
```

Genera los secretos y las llaves en base64, y te dice si falta algo.

### Paso A3 — Desplegar

```powershell
$env:DOKPLOY_TOKEN = "el-token-que-generaste"

# Si ya tienes los dominios apuntando al VPS:
$env:VISITAS_DOMINIO   = "visitas.tu-dominio.com"
$env:LICENCIAS_DOMINIO = "licencias.tu-dominio.com"

# Primero comprueba sin tocar nada:
npm run desplegar:comprobar

# Y si todo está bien:
npm run desplegar
```

El script crea el proyecto, sube el `docker-compose.yml` **tal cual** (no hace
falta repositorio Git: Dokploy admite el compose en crudo), guarda las variables,
configura los dominios y despliega.

> **Los dominios se configuran ANTES de desplegar**, y no es un detalle menor: en
> un compose son etiquetas de Docker, así que si se crean después no surten efecto
> hasta el siguiente despliegue.

Luego puedes consultar cómo va con:

```powershell
npm run desplegar:estado
```

### Paso A4 — Terminar de preparar el sistema

Después del primer despliegue, dentro del contenedor:

```bash
docker exec -it visitaflow-app node sql/01-crear.js
```

Y si ya subiste la base de cédulas (paso 8 más abajo):

```bash
docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js
```

---

## Camino B — Desplegar a mano, en el panel

### Paso 1 — Generar las llaves del licenciamiento

En tu máquina, una sola vez. Estas llaves son la identidad del licenciamiento:
con la privada se firman las licencias, con la pública cada instalación las
verifica.

```powershell
cd visitaflow
npm run keys:gen
```

Se crean en `licencias-keys/`: `privada.pem`, `publica.pem` y `keyid.txt`.

> **La llave privada no se sube nunca al repositorio.** El `.gitignore` y el
> `.dockerignore` ya la excluyen. Si se filtra, cualquiera puede emitir licencias
> válidas.

`npm run desplegar:preparar` te las da ya convertidas a base64.

### Paso 2 — Subir el código a un repositorio

Dokploy despliega desde un repositorio Git. El proyecto ya está preparado como
repositorio local con sus commits hechos; solo falta subirlo:

```powershell
cd visitaflow
git remote add origin https://github.com/tu-usuario/visitaflow.git
git push -u origin main
```

Crea el repositorio **vacío** en GitHub o GitLab (sin README ni .gitignore, para
que no choque). Cualquier Git sirve.

> **Revísalo antes de subir.** Esto no debe devolver nada:
> ```powershell
> git ls-files | Select-String "\.env|licencias-keys|\.pem"
> ```

### Paso 3 — Crear la aplicación en Dokploy

1. **Projects** → crea un proyecto (`visitaflow`).
2. **Create Service** → **Docker Compose**.
3. Conecta el repositorio y elige la rama.
4. **Compose Path**: `docker-compose.yml` (está en la raíz).

Aún no despliegues: primero las variables.

---

## Paso 4 — Las variables de entorno

En la pestaña **Environment**, pega lo que te dio
`npm run desplegar:preparar`:

```env
CLAVE_SQL=<la que generó>
JWT_SECRET=<la que generó>
ADMIN_TOKEN=<la que generó>

URL_PUBLICA=https://visitas.tu-dominio.com
LICENCIA_SERVIDOR_URL=https://licencias.tu-dominio.com

LICENCIA_LLAVE_PRIVADA_B64=<la privada en base64>
LICENCIA_LLAVE_PUBLICA_B64=<la pública en base64>
```

**Ninguna es opcional.** El `docker-compose.yml` usa `${VARIABLE:?mensaje}`, así
que si falta alguna el despliegue se detiene y dice cuál. Es a propósito: mejor
que falle al desplegar a que arranque con un secreto vacío.

### Aviso sobre la contraseña de SQL Server

Tiene que cumplir la política de SQL Server: **8 caracteres como mínimo, con
mayúscula, minúscula y un símbolo**. Si no, el contenedor de la base arranca y se
muere en bucle sin decir por qué. Evita comillas simples y dobles.

---

## Paso 5 — Los dominios

En la pestaña **Domains**:

| Servicio | Puerto interno | Dominio |
|---|---|---|
| `app` | `3000` | `visitas.tu-dominio.com` |
| `licencias` | `4100` | `licencias.tu-dominio.com` |

**Los dos llevan dominio**, y esto es importante: el servidor de licencias ya no
es solo para ti. **Tus clientes tienen que poder alcanzarlo** para activar su
instalación. Sin dominio público, la activación por ID no funciona y habría que
mandar archivos a mano.

Dokploy pone Traefik delante y saca el certificado HTTPS solo.

> El servidor de licencias está protegido por `ADMIN_TOKEN`: sin ese token no se
> puede ver ni tocar nada. Lo único abierto es la activación por ID, que solo
> devuelve la licencia del cliente que ya tiene ese ID.

---

## Paso 6 — Desplegar

Dale a **Deploy**. Lo que deberías ver:

1. Se descarga la imagen de SQL Server y arranca. **Tarda un minuto o dos.**
2. El servidor de licencias arranca y dice su `key_id`.
3. La aplicación arranca. Como la base todavía no existe, dice que hay que
   crearla. **Esto es correcto y esperado.**

Lo importante está en los registros de la aplicación:

```
[visitaflow] Servidor de licencias OK: https://licencias.tu-dominio.com (llave 08e382e3...)
```

Si en vez de eso dice que no responde, **la activación por ID no va a funcionar**,
y ahí está el aviso con la dirección que intentó. Las causas típicas: el dominio
del servidor de licencias no está configurado, o le falta el HTTPS.

---

## Paso 7 — Crear la base del sistema

```bash
docker exec -it visitaflow-app node sql/01-crear.js
```

Crea las 22 tablas, los permisos y los catálogos. Es idempotente.

---

## Paso 8 — Subir la base de cédulas

Lo único pesado, y se hace **una sola vez**.

### Cuánto pesa, medido

| Concepto | Tamaño |
|---|---|
| Registros | 7.856.023 |
| Datos de la tabla `PADRON` | **427 MB** (57 bytes por registro) |
| Archivo en disco | 1.536 MB (el resto es espacio reservado) |
| **Respaldo comprimido** | **274 MB** ← lo que se sube |

A 5 Mbps son 8 minutos. La base original, con fotos, son 86.508 MB y 40 horas de
subida. Esa diferencia es toda la razón de que este sistema sea viable.

### En tu máquina

```powershell
sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -Q "BACKUP DATABASE PadronLigero TO DISK = 'C:\TempSQL\PadronLigero.bak' WITH COMPRESSION"
```

### Al VPS

```bash
scp C:\TempSQL\PadronLigero.bak usuario@206.183.130.121:/ruta/del/proyecto/respaldo-padron/
```

Descomenta la línea del volumen `./respaldo-padron` en el servicio `bd-sistema` y
vuelve a desplegar.

### Dentro del contenedor

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -Q \
  "RESTORE DATABASE PadronLigero FROM DISK = '/respaldo/PadronLigero.bak' WITH MOVE 'PadronLigero' TO '/var/opt/mssql/data/PadronLigero.mdf', MOVE 'PadronLigero_log' TO '/var/opt/mssql/data/PadronLigero_log.ldf'"
```

Y después la vista que usa el sistema:

```bash
docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js
```

> **Sin esta vista, buscar una cédula tarda 2,4 segundos en vez de 10
> milisegundos.** La vista fuerza la intercalación y SQL Server puede usar el
> índice en vez de recorrer los 7,8 millones de registros.

---

## Paso 9 — Emitir la primera licencia y activar

Entra a `https://licencias.tu-dominio.com` con tu `ADMIN_TOKEN` y pulsa
**+ Nueva licencia**: código de la institución, nombre del cliente y días. El
sistema te dará un **ID** con formato `LIC-XXXXXXXX`.

Después abre `https://visitas.tu-dominio.com`. Como no hay licencia, muestra la
**pantalla de activación**. Escribe el ID y listo: el sistema crea la institución,
sus catálogos y el administrador.

```bash
docker exec -it visitaflow-app cat /app/datos/CLAVE-ADMINISTRADOR.txt
```

### Y para un cliente

Igual, pero en **su** servidor:

1. Tú creas el cliente en tu panel y le das el **ID**.
2. El cliente instala VisitaFlow en su servidor.
3. En su pantalla de activación escribe el ID.
4. Su sistema queda activado, con los módulos que tú le hayas puesto.

Si el cliente no tiene salida a Internet, se activa con el archivo `.vflow`: en el
panel, botón **↓** de su fila, y se lo mandas.

---

## El día a día: tu panel de licencias

En `https://licencias.tu-dominio.com` tienes todos tus clientes. Por cada fila:

| Acción | Para qué |
|---|---|
| **Renovar** | Extiende la vigencia |
| **⏸ Suspender** | Corta el servicio, con un motivo que el cliente verá |
| **▶ Reactivar** | Lo devuelve al servicio |
| **☰ Módulos** | Elige qué incluye su licencia (de 10 posibles) |
| **🕘 Historial** | Todo lo que ha pasado con esa licencia |
| **↓** | Descarga el archivo `.vflow` para entregárselo |

**Suspender no borra nada.** El cliente conserva todo su historial de visitas y se
reactiva cuando quieras. Su sistema sigue funcionando en solo lectura, y el motivo
que escribas llega hasta su pantalla de licencia: dejar a alguien sin servicio sin
decirle por qué es lo peor que se puede hacer.

**Los módulos se venden por partes.** El cambio llega en la siguiente consulta, sin
reinstalar nada. Se pueden quitar los que se venden aparte (reportes, vigilancia,
pre-registro, API). Los que sostienen la operación (registro, recepción, gafetes,
configuración, usuarios) **no se bloquean nunca**: dejar a un recepcionista sin
poder registrar con gente en la puerta es peor que una licencia impagada.

---

## Copias de seguridad

El respaldo lo escribe **SQL Server**, no la aplicación:

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "TU_CLAVE" -C -Q \
  "BACKUP DATABASE VisitaFlow TO DISK = '/var/opt/mssql/backup/VisitaFlow.bak' WITH COMPRESSION"
docker cp visitaflow-bd:/var/opt/mssql/backup/VisitaFlow.bak .
```

> **Un volumen que solo vive en el VPS no es una copia de seguridad: es el mismo
> disco.**

Y **apunta el archivo del registro de licencias** (volumen `datos-licencias`,
`licencias-emitidas.json`): ahí están tus clientes. Si se pierde, los pierdes a
todos.

---

## Qué sobrevive a un redespliegue

| Sobrevive (está en volúmenes) | Se pierde |
|---|---|
| La base de datos completa | Nada importante, si el código está en el repositorio |
| La base de cédulas | |
| La licencia (`/app/datos/licencia.vflow`) | |
| La clave del administrador (`/app/datos/CLAVE-ADMINISTRADOR.txt`) | |
| Los logos subidos (`/app/datos/archivos`) | |
| **El registro de licencias** (`datos-licencias`) | |

Esto es así a propósito: la licencia y las credenciales viven **dentro** del
volumen, no en la raíz del proyecto. Si vivieran fuera, cada redespliegue se las
llevaría.

---

## Si algo va mal

| Síntoma | Qué pasa | Solución |
|---|---|---|
| El despliegue se detiene: *"Defina CLAVE_SQL"* | Falta esa variable | Póngala en **Environment** |
| `bd-sistema` arranca y se muere en bucle | La contraseña de `sa` no cumple la política | Mínimo 8 caracteres, mayúscula, minúscula y símbolo. Sin comillas |
| *"Servidor de licencias ... no respondió"* | No se llega al servidor, o el dominio no está | Revisa `LICENCIA_SERVIDOR_URL` y el dominio del servicio `licencias` |
| *"Las licencias de ese servidor NO se podrán verificar aquí"* | El servidor usa otras llaves | Vuelve a emitir con las llaves correctas |
| La app dice que no hay base | Falta crearla | `docker exec -it visitaflow-app node sql/01-crear.js` |
| `/api/salud` dice `cedulas: false` | Falta la base de cédulas o la vista | Paso 8 y `03-vista-ciudadanos.js` |
| Buscar una cédula tarda segundos | Falta la vista `CIUDADANOS` | `docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js` |
| *"Esa licencia está suspendida"* al activar | La suspendiste desde el panel | Reactívala; el motivo se le muestra al cliente |
| Perdiste la clave del administrador | — | `docker exec -it visitaflow-app node scripts/restablecer-admin.js <institucion>` |
| Perdiste el `ADMIN_TOKEN` | Está en las variables de Dokploy | Cópialo de ahí |

---

## Lo que NO hay que hacer

- **No** subas `licencias-keys/privada.pem` al repositorio.
- **No** uses la misma cadena para `CLAVE_SQL`, `JWT_SECRET` y `ADMIN_TOKEN`.
- **No** borres los volúmenes `datos-sql` ni `datos-licencias`.
- **No** confíes en que el VPS hace copias de seguridad. No las hace.
