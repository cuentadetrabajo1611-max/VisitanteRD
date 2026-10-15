# Desplegar VisitaFlow en el VPS con Dokploy

Guía paso a paso, desde cero hasta el sistema funcionando con HTTPS.

Dokploy levanta el `docker-compose.yml` del proyecto tal cual, así que no hay
nada especial que configurar del lado del código: los tres servicios (base de
datos, servidor de licencias y aplicación) ya están definidos.

---

## Antes de empezar: qué hace falta

| Cosa | Detalle |
|---|---|
| Un VPS | Con Dokploy instalado y Docker funcionando |
| Un dominio o subdominio | Por ejemplo `visitas.su-dominio.com`, apuntando a la IP del VPS |
| El repositorio | VisitaFlow subido a GitHub, GitLab o el Git propio de Dokploy |
| El par de llaves | Generadas con `npm run keys:gen` en su máquina |
| La base de cédulas | `PadronLigero.bak`, unos 800 MB (se sube una sola vez) |

### Sobre los recursos

SQL Server es lo que más consume, y aquí hay un dato que conviene saber: **SQL
Server Express tiene un tope duro de 1.410 MB de memoria de buffer**, use la que
use el contenedor. Darle 8 GB no sirve de nada.

Por eso el compose ya viene ajustado así:

```yaml
bd-sistema:
  environment:
    MSSQL_MEMORY_LIMIT_MB: '1400'   # el motor no puede pasar de aquí
  deploy:
    resources:
      limits:
        memory: 2g                  # margen para el sistema y las herramientas
```

**Con esto el despliegue entra cómodo en un VPS de 4 GB.** El sistema completo
—base de datos, servidor de licencias y aplicación— no debería pasar de 1,5 GB
en uso normal.

Si el VPS tiene **menos de 3 GB**, asegúrese de que hay archivo de intercambio
(swap). SQL Server se cae solo si no encuentra memoria, y en el registro no dice
nada útil.

### Si la base de datos no arranca

El fallo más común de este despliegue no tiene nada que ver con VisitaFlow: el
contenedor de SQL Server corre con el usuario **10001** (`mssql`), no como root.
Si el volumen queda a nombre de root, la base no arranca y el registro dice:

```
Directory /var/opt/mssql/data is not writable
```

Con volúmenes **con nombre** (los que usa este compose) no pasa nada: Docker
copia los permisos de la imagen. Solo pasa si cambia el volumen por una carpeta
del host, y en ese caso:

```bash
mkdir -p ./datos-sql && sudo chown -R 10001:0 ./datos-sql
```

### Sobre el disco

Cuente con unos 3 GB para la base del sistema, la de cédulas y los respaldos.
La base de cédulas ocupa 1.536 MB en disco, de los cuales 427 MB son datos
reales.

SQL Server Express tiene un tope de **10 GB por base de datos**. La base del
sistema (visitas, usuarios, bitácora) no llega ni de lejos. La de cédulas son
unos 800 MB. Hay margen de sobra.

---

## Paso 1 — Generar las llaves del licenciamiento

Esto se hace **en su máquina**, una sola vez. Estas llaves son la identidad del
licenciamiento: con la privada se firman las licencias, con la pública cada
instalación las verifica.

```powershell
cd visitaflow
npm run keys:gen
```

Se crean en `licencias-keys/`: `privada.pem`, `publica.pem` y `keyid.txt`.

> **La llave privada no se sube nunca al repositorio.** El `.gitignore` y el
> `.dockerignore` ya la excluyen. Si se filtra, cualquiera puede emitir licencias
> válidas.

Conviértalas a base64 para pegarlas en Dokploy:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("licencias-keys\privada.pem"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("licencias-keys\publica.pem"))
```

Guarde los dos valores: se usan en el paso 3.

---

## Paso 2 — Crear la aplicación en Dokploy

1. Entre a Dokploy y vaya a **Projects** → cree un proyecto (por ejemplo
   `visitaflow`).
2. Dentro, **Create Service** → **Docker Compose**.
3. Conecte el repositorio de VisitaFlow y elija la rama.
4. En **Compose Path**, deje `docker-compose.yml` (está en la raíz del
   proyecto).

Aún no despliegue: primero hay que poner las variables.

---

## Paso 3 — Poner las variables de entorno

En la pestaña **Environment** de la aplicación, pegue esto con sus valores:

```env
# --- Base de datos ---------------------------------------------------------
CLAVE_SQL=una-clave-larga-y-sin-comillas-ni-cifrillas

# --- Sesiones y administración ---------------------------------------------
JWT_SECRET=otro-secreto-largo-distinto-del-anterior
ADMIN_TOKEN=un-token-largo-para-la-consola-de-licencias

# --- Dirección pública -----------------------------------------------------
URL_PUBLICA=https://visitas.su-dominio.com

# --- Llaves del licenciamiento (en base64, del paso 1) ---------------------
LICENCIA_LLAVE_PRIVADA_B64=<la privada en base64>
LICENCIA_LLAVE_PUBLICA_B64=<la pública en base64>
```

**Ninguna es opcional.** El `docker-compose.yml` usa `${VARIABLE:?mensaje}` en
las que no tienen valor por defecto, así que si falta alguna el despliegue se
detiene y dice cuál. Es a propósito: es mejor que falle al desplegar a que
arranque con un secreto vacío.

### Cómo generar los secretos

```powershell
# En PowerShell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Repítalo tres veces, una por cada secreto. **No use la misma cadena dos veces.**

### Aviso sobre las contraseñas de SQL Server

La contraseña de `sa` tiene que cumplir la política de SQL Server: **8
caracteres como mínimo, con mayúscula, minúscula y un símbolo**. Si no, el
contenedor de la base arranca y se muere en bucle sin decir por qué. Evite
comillas simples y dobles: el compose las interpretaría.

---

## Paso 4 — El dominio

En la pestaña **Domains** de la aplicación:

| Servicio | Puerto interno | Dominio |
|---|---|---|
| `app` | `3000` | `visitas.su-dominio.com` |
| `licencias` | `4100` | *(dejar sin dominio)* |

Dokploy pone Traefik delante y saca el certificado HTTPS solo. No hay que tocar
nginx ni configurar nada más.

> **No publique el servidor de licencias.** Solo lo usa usted desde su máquina
> para emitir licencias, y ya está en la red interna de Compose. Si lo deja
> abierto, cualquiera puede intentar emitir licencias. Adminístrelo por túnel
> SSH cuando lo necesite.

---

## Paso 5 — Desplegar

Dele a **Deploy** y siga los registros. Lo que debería ver:

1. Se descarga la imagen de SQL Server y arranca. **Tarda un minuto o dos** en
   aceptar conexiones.
2. El servidor de licencias arranca.
3. La aplicación arranca. Como la base todavía no existe, dice:

```
[visitaflow] No se pudo conectar a SQL Server: ...
[visitaflow] El servidor arranca igual para poder repararlo.
[visitaflow] Cree la base con:  docker exec -it visitaflow-app node sql/01-crear.js
```

**Esto es correcto y esperado.** El sistema arranca aunque falte la base, a
propósito: así se puede crear desde dentro del contenedor.

---

## Paso 6 — Crear la base del sistema

Desde el VPS, por SSH:

```bash
docker exec -it visitaflow-app node sql/01-crear.js
```

Crea las 20 tablas, los permisos y el catálogo de módulos. Es idempotente: se
puede repetir sin romper nada.

---

## Paso 7 — Subir la base de cédulas

Esto es lo único pesado del despliegue, y se hace **una sola vez**.

### Cuánto pesa, medido

Antes de empezar, conviene saber a qué se enfrenta. Los números reales de esta
base, medidos con `npm run padron:medir`:

| Concepto | Tamaño |
|---|---|
| Registros | 7.856.023 |
| Datos de la tabla `PADRON` | **427 MB** (57 bytes por registro) |
| Archivo en disco | 1.536 MB (el resto es espacio reservado sin usar) |
| **Respaldo comprimido** | **274 MB** ← esto es lo que se sube |

Y el tiempo de subida, según su conexión:

| Velocidad de subida | Tiempo |
|---|---|
| 1 Mbps | 38 min |
| 5 Mbps | 8 min |
| 20 Mbps | 2 min |

> **Compárelo con la alternativa.** La base original, con las fotos, son
> **86.508 MB**: subirla a 5 Mbps tarda **40 horas**. La ligera son 8 minutos.
> Esa es toda la razón de que exista este proyecto: solo nombres, apellidos y
> fechas.

### En su máquina

```powershell
sqlcmd -S localhost -U sa -P "SU_CLAVE" -C -Q "BACKUP DATABASE PadronLigero TO DISK = 'C:\TempSQL\PadronLigero.bak' WITH COMPRESSION"
```

Tarda unos segundos. El archivo queda en 274 MB.

### Al VPS

```bash
scp C:\TempSQL\PadronLigero.bak usuario@su-vps:/ruta/del/proyecto/respaldo-padron/
```

Descomente la línea del volumen `./respaldo-padron` en el servicio `bd-sistema`
del compose, y vuelva a desplegar.

### Dentro del contenedor

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "SU_CLAVE" -C -Q \
  "RESTORE DATABASE PadronLigero FROM DISK = '/respaldo/PadronLigero.bak' WITH MOVE 'PadronLigero' TO '/var/opt/mssql/data/PadronLigero.mdf', MOVE 'PadronLigero_log' TO '/var/opt/mssql/data/PadronLigero_log.ldf'"
```

Y después la vista que usa el sistema:

```bash
docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js
```

Tarda unos segundos. Crea `dbo.CIUDADANOS`, que es la vista con la collation
correcta para que las búsquedas por cédula usen el índice.

> **Sin esta vista, buscar una cédula tarda 2,4 segundos en vez de 10
> milisegundos.** La diferencia es que la vista fuerza la collation y SQL Server
> puede usar el índice en vez de recorrer los 7,8 millones de registros.

### Comprobar que quedó bien

```bash
docker exec -it visitaflow-app node -e "require('./src/db.js').conectarPadron().then(async bd => { const r = await bd.consultarPadron('SELECT COUNT_BIG(*) AS n FROM dbo.CIUDADANOS'); console.log(r.recordset[0].n + ' registros'); await bd.cerrar(); })"
```

Debe decir `7856023 registros`.

---

## Paso 8 — Activar el sistema

Abra `https://visitas.su-dominio.com`. Como no hay licencia, el sistema muestra
**directamente la pantalla de activación**.

1. Emita una licencia desde su máquina:

   ```bash
   # Con el servidor de licencias a mano
   npm run licencias
   
   # O directamente, que es más rápido
   node scripts/licencia-demo.js junta-los-prados 365
   ```

   Se genera el archivo `.vflow`. **Ese archivo es la licencia**: entréguelo al
   cliente.

2. Pegue el contenido del `.vflow` en la pantalla de activación.

3. El sistema verifica la firma, crea la institución, sus catálogos (departamentos,
   motivos, categorías, sedes, plantilla de gafete) y **el administrador inicial**.

4. Lea la clave del administrador:

   ```bash
   docker exec -it visitaflow-app cat /app/datos/CLAVE-ADMINISTRADOR.txt
   ```

5. Entre con esas credenciales y **cámbiela** en Usuarios.

> La activación funciona sin sesión **solo** cuando la instalación está vacía. Es
> necesario: sin licencia no hay institución, y sin institución no hay usuarios,
> así que nadie podría activar el sistema. En cuanto existe una institución, la
> activación vuelve a exigir sesión y permiso.

---

## Paso 9 — Comprobar que quedó bien

```bash
# La aplicación responde
curl -s https://visitas.su-dominio.com/api/salud | head -c 400

# Los tres contenedores están arriba
docker compose ps
```

Lo que debe decir `/api/salud`:

```json
{
  "ok": true,
  "entorno": "production",
  "base_datos": { "disponible": true },
  "cedulas":    { "disponible": true },
  "licencia":   { "valida": true, "estado": "activa" }
}
```

Y desde su máquina, una comprobación de verdad:

```powershell
cd visitaflow
$env:PRUEBA_URL="https://visitas.su-dominio.com"
npm test
```

Son 69 pruebas de extremo a extremo contra el sistema en producción.

---

## Copias de seguridad

El respaldo lo escribe **SQL Server**, no la aplicación:

```bash
docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "SU_CLAVE" -C -Q \
  "BACKUP DATABASE VisitaFlow TO DISK = '/var/opt/mssql/backup/VisitaFlow.bak' WITH COMPRESSION"
```

Y sáquelo del servidor:

```bash
docker cp visitaflow-bd:/var/opt/mssql/backup/VisitaFlow.bak .
```

> **Un volumen que solo vive en el VPS no es una copia de seguridad: es el mismo
> disco.** Baje el `.bak` a su máquina, o a otro servidor.

La carpeta `/var/opt/mssql/backup` ya es parte del volumen de datos, así que el
archivo sobrevive a un redespliegue.

---

## Actualizar el sistema

Cuando haya cambios en el código, dele a **Deploy** otra vez. Dokploy vuelve a
construir la imagen y recrea los contenedores.

**Qué sobrevive y qué no:**

| Sobrevive (está en volúmenes) | Se pierde |
|---|---|
| La base de datos completa | Nada importante, si el código está en el repositorio |
| La base de cédulas | |
| La licencia (`/app/datos/licencia.vflow`) | |
| La clave del administrador (`/app/datos/CLAVE-ADMINISTRADOR.txt`) | |
| Los logos subidos (`/app/datos/archivos`) | |

Esto es así a propósito: la licencia y las credenciales viven **dentro** del
volumen, no en la raíz del proyecto. Si vivieran fuera, cada redespliegue se las
llevaría y habría que activar el sistema otra vez.

---

## Si algo va mal

| Síntoma | Qué pasa | Solución |
|---|---|---|
| El despliegue se detiene: *"Defina CLAVE_SQL en el archivo .env"* | Falta esa variable | Póngala en **Environment** |
| `bd-sistema` arranca y se muere en bucle | La contraseña de `sa` no cumple la política | Mínimo 8 caracteres, mayúscula, minúscula y símbolo. Sin comillas |
| La app dice que no hay base | Falta crearla | `docker exec -it visitaflow-app node sql/01-crear.js` |
| `/api/salud` dice `cedulas: disponible: false` | Falta la base de cédulas o la vista | Pasos 7 y la línea de `03-vista-ciudadanos.js` |
| Buscar una cédula tarda segundos | Falta la vista `CIUDADANOS` | `docker exec -it visitaflow-app node sql/03-vista-ciudadanos.js` |
| *"La firma de la licencia NO es válida"* | El archivo se editó, o se emitió con otras llaves | Emita una nueva con las llaves correctas |
| El servidor de licencias da 404 | Está detrás de Traefik sin dominio | Accédalo por túnel SSH al puerto 4100 |
| Perdió la clave del administrador | — | `docker exec -it visitaflow-app node scripts/restablecer-admin.js junta-los-prados` |
| El sistema quedó en solo lectura | La licencia venció | Emita una nueva y actívela. **El historial se sigue viendo y exportando** |

---

## Lo que NO hay que hacer

- **No** publique el servidor de licencias en Internet.
- **No** suba `licencias-keys/privada.pem` al repositorio.
- **No** use la misma cadena para `CLAVE_SQL`, `JWT_SECRET` y `ADMIN_TOKEN`.
- **No** borre el volumen `datos-sql` para "empezar limpio": ahí está todo.
- **No** confíe en que el VPS hace copias de seguridad. No las hace.
