# Aquí va la base de cédulas (el padrón)

Esta carpeta es el volumen `./respaldo-padron:/respaldo:ro` del `docker-compose.yml`.

> **La forma recomendada de subir el padrón NO usa esta carpeta.** Súbelo con `scp` al
> VPS y luego mételo en el contenedor con `docker cp`: así no hay que tocar el compose
> ni volver a desplegar. Está explicado paso a paso en
> [`docs/DESPLIEGUE-VPS.md`](../docs/DESPLIEGUE-VPS.md), sección 9.
>
> Esta carpeta queda para quien prefiera el volumen, y para que la ruta del compose
> exista antes de desplegar (si no existe, Docker la crea vacía como root).

## Qué tiene que haber aquí

Un solo archivo:

```
PadronLigero.bak    275 MB    SHA-256 43E0912CBB79ECC984EF6A257CA5E2E4BAE7B5471D2D23113755A9492A7D2AB4
```

Ese archivo **no viaja en el repositorio**: pesa 275 MB y GitHub rechaza archivos de más
de 100 MB. El `.gitignore` lo excluye a propósito (`*.bak`).

El respaldo es el padrón **sin fotografías**, como se pidió: 22 columnas con cédula,
nombres, apellidos, fecha de nacimiento, sexo, estado civil, nacionalidad, ocupación y
municipio. Nada de imágenes. Comprobado con `npm run padron:comprobar`.

## Cómo se sube (la vía recomendada, sin tocar el compose)

Desde tu PC:

```powershell
scp "C:\TempSQL\PadronLigero.bak" root@206.183.130.121:/root/
```

Tarda unos 8 minutos a 5 Mbps. Al terminar, comprueba que llegó entero —un archivo a
medias da un error de SQL Server que no dice nada de la causa—:

```bash
# En el VPS
sha256sum /root/PadronLigero.bak
```

Tiene que dar exactamente:

```
43e0912cbb79ecc984ef6a257ca5e2e4bae7b5471d2d23113755a9492a7d2ab4
```

Luego, dentro del contenedor y restaurar:

```bash
docker exec visitaflow-bd mkdir -p /var/opt/mssql/backup
docker cp /root/PadronLigero.bak visitaflow-bd:/var/opt/mssql/backup/PadronLigero.bak

docker exec -it visitaflow-bd /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "TU_CLAVE" -C -Q \
  "RESTORE DATABASE PadronLigero FROM DISK = '/var/opt/mssql/backup/PadronLigero.bak' \
   WITH MOVE 'PadronLigero' TO '/var/opt/mssql/data/PadronLigero.mdf', \
        MOVE 'PadronLigero_log' TO '/var/opt/mssql/data/PadronLigero_log.ldf', REPLACE"
```

`WITH REPLACE` es para poder repetirlo: sin él, la segunda vez falla porque la base ya
existe. El respaldo **ya trae la vista `dbo.CIUDADANOS`**, así que no hay que crearla.

## Comprobar que quedó bien

```bash
npm run padron:comprobar
```

Dice cuántos ciudadanos hay (tienen que ser **7.856.023**), si la vista responde, cuántas
columnas trae, **si trae fotografías**, cuánto ocupa y si la búsqueda por cédula y por
apellido funcionan de verdad. Sale con código 1 si algo está mal, así que sirve para
encadenarlo en un despliegue automático.

## Si el respaldo no está

El sistema funciona igual: se pueden registrar visitantes escribiendo el nombre a mano.
Lo que se pierde es la búsqueda por cédula y el autocompletado de nombres. El ajuste
`IDENTIDAD_EXIGIR_EN_PADRON` en `0` (que es como viene) permite registrar a alguien que
no esté en la base.

## Lo que NO hay que hacer

- **No modificar el padrón.** Es de solo lectura a propósito: es el registro oficial
  copiado tal cual. El sistema solo lo consulta.
- **No crear índices** en sus tablas sin hablarlo antes. Está medido: las búsquedas por
  nombre tardan entre 50 y 150 milisegundos tal como está.
- **No volver a subirlo** si ya está restaurado. La restauración no se repite sola.
