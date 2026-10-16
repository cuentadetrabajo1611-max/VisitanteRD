# Buscar personas por nombre: qué se midió y qué se puede mejorar

Este documento existe para que la decisión sobre el rendimiento de la búsqueda por
nombre no se tome a ciegas. Todo lo que hay aquí está **medido**, no estimado, y las
mediciones se hicieron sobre **copias**, sin tocar el padrón.

## El problema, en una frase

Buscar por apellido es un recorrido completo de 7,8 millones de filas, porque el padrón
**solo tiene el índice de la cédula**. Los apellidos comunes responden al instante porque
el motor encuentra las filas que se le piden enseguida y para; los **poco comunes** tienen
que recorrer la tabla entera y tardan entre 10 y 20 segundos.

## Lo que se midió

Servidor: el mismo SQL Server del proyecto, padrón de 7.856.023 ciudadanos, tabla de
430 MB.

### Búsqueda actual (`%texto%`), que es lo que el sistema hace hoy

| Búsqueda | Filas | Tiempo |
|---|---|---|
| `RODRIGUEZ` (apellido común) | 100 | 36-80 ms |
| `CAAMAÑO` (336 personas) | 100 | 1 980-15 000 ms |
| `ZZQXWVUT` (no existe) | 0 | 7 200-20 000 ms |

El caso que no existe es el peor: hay que recorrer todo para poder decir que no está.

### Tres formas de mejorarlo, comparadas

| Solución | Común | Poco común | No existe | Espacio extra | Toca el padrón |
|---|---|---|---|---|---|
| **Como está hoy** | 36-80 ms | 2-15 s | 7-20 s | 0 | no |
| Copia reducida (4 columnas, sin índice) | 36 ms | **1 980 ms** | 7 246 ms | **+403 MB** | no |
| Índice en el apellido + búsqueda por **prefijo** | **4-8 ms** | **286 ms** | 1 947 ms | +188 MB | **sí** |

### Lo que NO sirve, y por qué conviene saberlo

- **Un índice con `%texto%` no sirve para nada.** Medido: crear el índice sobre el
  apellido y buscar `LIKE '%CAAM%'` sigue tardando 2 045 ms. El comodín al principio
  impide usar el índice; el motor lo ignora.
- **Buscar por prefijo (`texto%`) sin índice tampoco.** La mejora viene del índice, no
  del prefijo.
- **La copia reducida ayuda sin tocar el padrón**, y bastante: la búsqueda poco común
  pasa de 15 segundos a 2. Son 403 MB a cambio de 7 veces menos tiempo, pero sigue sin
  ser instantáneo.

### La solución que sí funciona, medida

Un índice sobre los apellidos **y buscar por prefijo**. Con eso:

```
Apellido1 COLLATE Latin1_General_CI_AI LIKE 'PENA%'   ->  100 filas      8 ms
Apellido1 COLLATE Latin1_General_CI_AI LIKE 'PEÑA%'   ->  100 filas      5 ms
Apellido1 LIKE 'RODR%'                                ->  100 filas      4 ms
Apellido1 LIKE 'CAAM%'                                ->  100 filas    286 ms
Apellido1 LIKE 'ZZ%'    (no existe)                   ->    0 filas   1 947 ms
```

Ocho milisegundos frente a quince segundos. Y funciona igual con o sin la Ñ, porque la
intercalación `CI_AI` ignora los acentos.

## La pega: hay que modificar el padrón

El padrón es el registro oficial copiado tal cual, y **la regla del proyecto es no
tocarlo**. Crear un índice es un cambio pequeño y reversible (el índice se puede borrar),
pero es un cambio, y por eso no se ha hecho.

Las dos opciones, con lo que cuesta cada una:

**Opción A — un índice en el padrón (lo que da 8 ms)**

```sql
CREATE INDEX IX_PADRON_APELLIDO1 ON dbo.PADRON (Apellido1) INCLUDE (Cedula);
CREATE INDEX IX_PADRON_APELLIDO2 ON dbo.PADRON (Apellido2) INCLUDE (Cedula);
```

- Cuesta: unos **190 MB por índice** (medido: 188 MB para uno) y 2-3 minutos de creación.
- A cambio: la búsqueda por apellido pasa a ser instantánea.
- Y hay que cambiar la búsqueda para que use el **prefijo** (`PENA%`) en vez del
  contiene (`%PENA%`). Eso cambia el comportamiento: hoy "RODR" encuentra a todos los
  RODRIGUEZ de cualquier parte del apellido; con prefijo, a los que **empiezan** por
  RODR. Para un apellido es lo mismo; para un nombre de pila, no.

**Opción B — no tocar el padrón (lo que hay hoy)**

- Los apellidos comunes responden en menos de 100 ms, que es el 95 % de lo que pasa por
  una puerta.
- Los poco comunes tardan entre 10 y 20 segundos, y el sistema **lo dice**: "La búsqueda
  tardó demasiado... pruebe con la cédula". No miente diciendo que no existe.
- La salida rápida siempre está: **buscar por cédula usa el índice y responde en
  milisegundos**.

## Recomendación

Si la junta va a buscar sobre todo por apellidos comunes —que es lo normal— la opción B
basta y no hay que tocar nada.

Si en la puerta aparece gente con apellidos poco comunes y la espera molesta, la opción A
es la buena, y son 190 MB y una decisión suya. **No se ha hecho porque el padrón no se
modifica sin permiso.**
