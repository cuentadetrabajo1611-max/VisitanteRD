# ============================================================================
# VisitaFlow - Imagen de la aplicacion
# ----------------------------------------------------------------------------
# Un solo archivo sirve para las dos piezas del sistema:
#
#   docker build -t visitaflow .
#   docker run ... visitaflow node server.js            -> sistema de visitantes
#   docker run ... visitaflow node server-licencias.js  -> servidor de licencias
#
# Se usa la misma imagen porque comparten codigo (el nucleo de licencias y el
# generador de QR y codigos de barras). Lo que cambia es el comando.
# ============================================================================

FROM node:22-alpine AS dependencias

WORKDIR /app

# Solo el manifiesto, para que la capa de dependencias se reutilice mientras no
# cambien las versiones.
COPY package.json package-lock.json ./

# Se instalan TODAS las dependencias y despues se podan las de desarrollo. Asi
# el cache de npm funciona aunque no haya devDependencies declaradas.
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------

FROM node:22-alpine AS aplicacion

# dumb-init reparte bien las senales: sin el, el proceso de Node no recibe
# SIGTERM al reiniciar el contenedor y se queda colgado hasta que lo matan.
RUN apk add --no-cache dumb-init tzdata curl

WORKDIR /app

# La zona horaria del contenedor. Las fechas se guardan con su desfase, pero
# conviene que el reloj del sistema coincida con el de la institucion.
ENV TZ=America/Santo_Domingo
RUN cp /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY server.js server-licencias.js ./
COPY src ./src
COPY sql ./sql
COPY scripts ./scripts
COPY public ./public
COPY public-licencias ./public-licencias

# Carpetas que el sistema escribe: archivos subidos (logos) y datos sueltos.
# Se declaran como volumen para que sobrevivan a un redespliegue.
RUN mkdir -p /app/datos/archivos /app/datos/logos && \
    addgroup -S visitaflow && adduser -S visitaflow -G visitaflow && \
    chown -R visitaflow:visitaflow /app/datos

# El sistema NO corre como root. Si alguien lograra ejecutar codigo, no tendria
# permiso para tocar nada fuera de sus carpetas.
USER visitaflow

EXPOSE 3000

# Comprobacion de salud: la usa Docker y la usa Dokploy para saber si el
# contenedor esta listo antes de mandarle trafico.
HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/salud > /dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
