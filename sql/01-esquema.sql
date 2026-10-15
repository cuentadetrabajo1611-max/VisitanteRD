/* ============================================================================
   VisitaFlow - Esquema de la base del sistema (multi-tenant)
   ----------------------------------------------------------------------------
   Una sola base y un solo esquema, con la columna tenant_id separando una
   institucion de otra. Cada consulta del sistema filtra por tenant_id, y ese
   filtro NO se toma nunca del cuerpo de la peticion: se saca del token de la
   sesion. Asi una institucion no puede ver ni tocar los datos de otra.

   Este archivo se puede ejecutar varias veces sin dano: todo se crea con
   comprobaciones de existencia.
   ============================================================================ */

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   1. Instituciones (tenants)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_tenants', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_tenants (
    id                INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_tenants PRIMARY KEY,
    codigo            VARCHAR(40)   NOT NULL,          -- identificador corto: "junta-los-prados"
    nombre            NVARCHAR(200) NOT NULL,          -- nombre legal
    nombre_comercial  NVARCHAR(200) NULL,
    contacto_nombre   NVARCHAR(160) NULL,
    contacto_correo   NVARCHAR(200) NULL,
    contacto_telefono VARCHAR(40)   NULL,
    pais              VARCHAR(60)   NOT NULL CONSTRAINT DF_vf_tenants_pais DEFAULT 'Republica Dominicana',
    zona_horaria      VARCHAR(60)   NOT NULL CONSTRAINT DF_vf_tenants_tz DEFAULT 'America/Santo_Domingo',
    -- Personalizacion institucional
    logo_url          NVARCHAR(400) NULL,
    logo_archivo      NVARCHAR(200) NULL,
    color_primario    VARCHAR(9)    NOT NULL CONSTRAINT DF_vf_tenants_c1 DEFAULT '#1e3a8a',
    color_secundario  VARCHAR(9)    NOT NULL CONSTRAINT DF_vf_tenants_c2 DEFAULT '#f59e0b',
    color_acento      VARCHAR(9)    NOT NULL CONSTRAINT DF_vf_tenants_c3 DEFAULT '#0ea5e9',
    color_texto       VARCHAR(9)    NOT NULL CONSTRAINT DF_vf_tenants_c4 DEFAULT '#0f172a',
    tipografia        VARCHAR(60)   NOT NULL CONSTRAINT DF_vf_tenants_font DEFAULT 'Inter',
    texto_gafete      NVARCHAR(300) NULL,              -- leyenda al pie del gafete
    estado            VARCHAR(20)   NOT NULL CONSTRAINT DF_vf_tenants_estado DEFAULT 'activo', -- activo | suspendido
    creado            DATETIMEOFFSET(0)  NOT NULL CONSTRAINT DF_vf_tenants_creado DEFAULT SYSDATETIMEOFFSET(),
    actualizado       DATETIMEOFFSET(0)  NULL
  );
  CREATE UNIQUE INDEX UX_vf_tenants_codigo ON dbo.vf_tenants (codigo);
END
GO

/* ---------------------------------------------------------------------------
   2. Licencias instaladas (espejo de lo que emitio el servidor de licencias)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_licencias', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_licencias (
    id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_licencias PRIMARY KEY,
    tenant_id       INT NOT NULL CONSTRAINT FK_vf_licencias_tenant REFERENCES dbo.vf_tenants(id),
    licencia_id     VARCHAR(60)   NOT NULL,   -- identificador que viene dentro del archivo firmado
    key_id          VARCHAR(32)   NULL,       -- con que llave se firmo
    cliente         NVARCHAR(200) NULL,
    tipo            VARCHAR(20)   NULL,       -- prueba | periodo | anual | permanente
    desde           DATE          NULL,
    hasta           DATE          NULL,
    gracia_dias     INT           NOT NULL CONSTRAINT DF_vf_licencias_gracia DEFAULT 15,
    modulos         NVARCHAR(600) NULL,       -- lista separada por comas
    limite_usuarios INT           NULL,
    limite_instalaciones INT      NULL,
    huella          VARCHAR(120)  NULL,
    archivo         NVARCHAR(MAX) NULL,       -- el texto .vflow completo, tal como llego
    estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_vf_licencias_estado DEFAULT 'activa',
    activada        DATETIMEOFFSET(0)  NOT NULL CONSTRAINT DF_vf_licencias_activada DEFAULT SYSDATETIMEOFFSET(),
    ultima_revision DATETIMEOFFSET(0)  NULL,
    notas           NVARCHAR(400) NULL
  );
  CREATE UNIQUE INDEX UX_vf_licencias_licencia ON dbo.vf_licencias (licencia_id);
  CREATE INDEX IX_vf_licencias_tenant ON dbo.vf_licencias (tenant_id, estado);
END
GO

/* ---------------------------------------------------------------------------
   3. Instalaciones (equipos autorizados por la licencia)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_instalaciones', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_instalaciones (
    id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_instalaciones PRIMARY KEY,
    tenant_id     INT NOT NULL CONSTRAINT FK_vf_instalaciones_tenant REFERENCES dbo.vf_tenants(id),
    huella        VARCHAR(120)  NOT NULL,
    nombre_equipo NVARCHAR(160) NULL,
    sistema       NVARCHAR(120) NULL,
    version       VARCHAR(30)   NULL,
    ip            VARCHAR(60)   NULL,
    autorizada    BIT           NOT NULL CONSTRAINT DF_vf_instalaciones_aut DEFAULT 0,
    primera_vez   DATETIMEOFFSET(0)  NOT NULL CONSTRAINT DF_vf_instalaciones_pv DEFAULT SYSDATETIMEOFFSET(),
    ultima_vez    DATETIMEOFFSET(0)  NOT NULL CONSTRAINT DF_vf_instalaciones_uv DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE UNIQUE INDEX UX_vf_instalaciones_huella ON dbo.vf_instalaciones (tenant_id, huella);
END
GO

/* ---------------------------------------------------------------------------
   4. Usuarios y permisos
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_usuarios', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_usuarios (
    id             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_usuarios PRIMARY KEY,
    tenant_id      INT NOT NULL CONSTRAINT FK_vf_usuarios_tenant REFERENCES dbo.vf_tenants(id),
    correo         NVARCHAR(200) NOT NULL,
    clave_hash     NVARCHAR(200) NOT NULL,
    nombre         NVARCHAR(160) NOT NULL,
    rol            VARCHAR(20)   NOT NULL CONSTRAINT DF_vf_usuarios_rol DEFAULT 'operator', -- admin | supervisor | operator
    telefono       VARCHAR(40)   NULL,
    sede_id        INT           NULL,
    activo         BIT           NOT NULL CONSTRAINT DF_vf_usuarios_activo DEFAULT 1,
    -- Bloqueo por intentos fallidos
    intentos       INT           NOT NULL CONSTRAINT DF_vf_usuarios_intentos DEFAULT 0,
    bloqueado_hasta DATETIMEOFFSET(0) NULL,
    ultimo_acceso  DATETIMEOFFSET(0)  NULL,
    ultima_ip      VARCHAR(60)   NULL,
    -- Recuperacion de contrasena
    reset_token    VARCHAR(120)  NULL,
    reset_expira   DATETIMEOFFSET(0)  NULL,
    creado         DATETIMEOFFSET(0)  NOT NULL CONSTRAINT DF_vf_usuarios_creado DEFAULT SYSDATETIMEOFFSET(),
    actualizado    DATETIMEOFFSET(0)  NULL
  );
  CREATE UNIQUE INDEX UX_vf_usuarios_correo ON dbo.vf_usuarios (tenant_id, correo);
  CREATE INDEX IX_vf_usuarios_tenant ON dbo.vf_usuarios (tenant_id, activo);
END
GO

IF OBJECT_ID('dbo.vf_permisos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_permisos (
    clave       VARCHAR(60)  NOT NULL CONSTRAINT PK_vf_permisos PRIMARY KEY,
    grupo       VARCHAR(40)  NOT NULL,
    descripcion NVARCHAR(240) NOT NULL,
    orden       INT          NOT NULL CONSTRAINT DF_vf_permisos_orden DEFAULT 0
  );
END
GO

IF OBJECT_ID('dbo.vf_rol_permisos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_rol_permisos (
    tenant_id INT         NOT NULL CONSTRAINT FK_vf_rol_permisos_tenant REFERENCES dbo.vf_tenants(id),
    rol       VARCHAR(20) NOT NULL,
    permiso   VARCHAR(60) NOT NULL,
    CONSTRAINT PK_vf_rol_permisos PRIMARY KEY (tenant_id, rol, permiso)
  );
END
GO

/* ---------------------------------------------------------------------------
   5. Catalogos configurables por institucion
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_departamentos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_departamentos (
    id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_departamentos PRIMARY KEY,
    tenant_id   INT NOT NULL CONSTRAINT FK_vf_departamentos_tenant REFERENCES dbo.vf_tenants(id),
    nombre      NVARCHAR(160) NOT NULL,
    encargado   NVARCHAR(160) NULL,
    correo      NVARCHAR(200) NULL,
    telefono    VARCHAR(40)   NULL,
    activo      BIT NOT NULL CONSTRAINT DF_vf_departamentos_activo DEFAULT 1,
    creado      DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_departamentos_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_departamentos_tenant ON dbo.vf_departamentos (tenant_id, activo);
END
GO

IF OBJECT_ID('dbo.vf_motivos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_motivos (
    id                 INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_motivos PRIMARY KEY,
    tenant_id          INT NOT NULL CONSTRAINT FK_vf_motivos_tenant REFERENCES dbo.vf_tenants(id),
    nombre             NVARCHAR(160) NOT NULL,
    avisa_anfitrion    BIT NOT NULL CONSTRAINT DF_vf_motivos_avisa DEFAULT 0,
    exige_aprobacion   BIT NOT NULL CONSTRAINT DF_vf_motivos_aprob DEFAULT 0,
    exige_documento    BIT NOT NULL CONSTRAINT DF_vf_motivos_doc DEFAULT 0,
    exige_vehiculo     BIT NOT NULL CONSTRAINT DF_vf_motivos_veh DEFAULT 0,
    exige_pertenencias BIT NOT NULL CONSTRAINT DF_vf_motivos_per DEFAULT 0,
    exige_temperatura  BIT NOT NULL CONSTRAINT DF_vf_motivos_temp DEFAULT 0,
    color              VARCHAR(9) NULL,
    activo             BIT NOT NULL CONSTRAINT DF_vf_motivos_activo DEFAULT 1,
    creado             DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_motivos_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_motivos_tenant ON dbo.vf_motivos (tenant_id, activo);
END
GO

IF OBJECT_ID('dbo.vf_categorias', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_categorias (
    id                 INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_categorias PRIMARY KEY,
    tenant_id          INT NOT NULL CONSTRAINT FK_vf_categorias_tenant REFERENCES dbo.vf_tenants(id),
    nombre             NVARCHAR(120) NOT NULL,
    exige_documento    BIT NOT NULL CONSTRAINT DF_vf_categorias_doc DEFAULT 1,
    activo             BIT NOT NULL CONSTRAINT DF_vf_categorias_activo DEFAULT 1,
    creado             DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_categorias_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_categorias_tenant ON dbo.vf_categorias (tenant_id, activo);
END
GO

IF OBJECT_ID('dbo.vf_sedes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_sedes (
    id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_sedes PRIMARY KEY,
    tenant_id   INT NOT NULL CONSTRAINT FK_vf_sedes_tenant REFERENCES dbo.vf_tenants(id),
    nombre      NVARCHAR(160) NOT NULL,
    direccion   NVARCHAR(300) NULL,
    hora_desde  VARCHAR(5) NULL,   -- '08:00'
    hora_hasta  VARCHAR(5) NULL,   -- '18:00'
    activo      BIT NOT NULL CONSTRAINT DF_vf_sedes_activo DEFAULT 1,
    creado      DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_sedes_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_sedes_tenant ON dbo.vf_sedes (tenant_id, activo);
END
GO

IF OBJECT_ID('dbo.vf_plantillas_gafete', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_plantillas_gafete (
    id             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_plantillas_gafete PRIMARY KEY,
    tenant_id      INT NOT NULL CONSTRAINT FK_vf_plantillas_tenant REFERENCES dbo.vf_tenants(id),
    nombre         NVARCHAR(120) NOT NULL,
    tamano         VARCHAR(30)  NOT NULL CONSTRAINT DF_vf_plantillas_tamano DEFAULT 'carta-4', -- carta-4 | carta-8 | termica
    ancho_mm       DECIMAL(6,2) NULL,
    alto_mm        DECIMAL(6,2) NULL,
    orientacion    VARCHAR(12)  NOT NULL CONSTRAINT DF_vf_plantillas_orient DEFAULT 'vertical',
    mostrar_qr     BIT NOT NULL CONSTRAINT DF_vf_plantillas_qr DEFAULT 1,
    mostrar_barras BIT NOT NULL CONSTRAINT DF_vf_plantillas_barras DEFAULT 0,
    mostrar_foto   BIT NOT NULL CONSTRAINT DF_vf_plantillas_foto DEFAULT 0,
    color_fondo    VARCHAR(9) NULL,
    color_texto    VARCHAR(9) NULL,
    pie            NVARCHAR(300) NULL,
    es_predeterminada BIT NOT NULL CONSTRAINT DF_vf_plantillas_pred DEFAULT 0,
    activo         BIT NOT NULL CONSTRAINT DF_vf_plantillas_activo DEFAULT 1,
    creado         DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_plantillas_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_plantillas_tenant ON dbo.vf_plantillas (tenant_id, activo);
END
GO

IF OBJECT_ID('dbo.vf_ajustes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_ajustes (
    tenant_id  INT NOT NULL CONSTRAINT FK_vf_ajustes_tenant REFERENCES dbo.vf_tenants(id),
    clave      VARCHAR(80) NOT NULL,
    valor      NVARCHAR(400) NULL,
    tipo       VARCHAR(20) NOT NULL CONSTRAINT DF_vf_ajustes_tipo DEFAULT 'texto', -- texto | numero | booleano
    grupo      VARCHAR(40) NOT NULL CONSTRAINT DF_vf_ajustes_grupo DEFAULT 'general',
    descripcion NVARCHAR(300) NULL,
    CONSTRAINT PK_vf_ajustes PRIMARY KEY (tenant_id, clave)
  );
END
GO

/* ---------------------------------------------------------------------------
   6. Visitantes y visitas
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_visitantes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_visitantes (
    id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_visitantes PRIMARY KEY,
    tenant_id       INT NOT NULL CONSTRAINT FK_vf_visitantes_tenant REFERENCES dbo.vf_tenants(id),
    cedula          VARCHAR(20)   NOT NULL CONSTRAINT DF_vf_visitantes_ced DEFAULT '', -- '' cuando no hay cedula (visita anunciada solo con nombre)
    cedula_formato  VARCHAR(20)   NULL,   -- como se escribio: 001-00000001-7
    nombres         NVARCHAR(160) NULL,
    apellidos       NVARCHAR(160) NULL,
    nombre_completo NVARCHAR(200) NULL,
    fecha_nacimiento DATE         NULL,
    sexo            VARCHAR(12)   NULL,   -- M | F (se acepta la descripcion completa por si el padron la trae)
    nacionalidad    NVARCHAR(80)  NULL,
    estado_civil    NVARCHAR(60)  NULL,
    ocupacion       NVARCHAR(120) NULL,
    municipio       NVARCHAR(120) NULL,
    provincia       NVARCHAR(120) NULL,
    -- Datos de contacto que aporta la institucion, no el padron
    telefono        VARCHAR(40)   NULL,
    correo          NVARCHAR(200) NULL,
    empresa         NVARCHAR(200) NULL,
    notas           NVARCHAR(600) NULL,
    en_padron       BIT NOT NULL CONSTRAINT DF_vf_visitantes_padron DEFAULT 0,
    validado        DATETIMEOFFSET(0)  NULL,   -- ultima vez que se comprobo contra el padron
    visitas_total   INT NOT NULL CONSTRAINT DF_vf_visitantes_total DEFAULT 0,
    creado          DATETIMEOFFSET(0)  NOT NULL CONSTRAINT DF_vf_visitantes_creado DEFAULT SYSDATETIMEOFFSET(),
    actualizado     DATETIMEOFFSET(0)  NULL
  );
  CREATE UNIQUE INDEX UX_vf_visitantes_cedula ON dbo.vf_visitantes (tenant_id, cedula) WHERE cedula <> '';
  CREATE INDEX IX_vf_visitantes_nombre ON dbo.vf_visitantes (tenant_id, apellidos, nombres);
END
GO

IF OBJECT_ID('dbo.vf_visitas', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_visitas (
    id                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_visitas PRIMARY KEY,
    tenant_id         INT NOT NULL CONSTRAINT FK_vf_visitas_tenant REFERENCES dbo.vf_tenants(id),
    visitante_id      INT NULL CONSTRAINT FK_vf_visitas_visitante REFERENCES dbo.vf_visitantes(id),
    codigo            VARCHAR(20) NOT NULL,     -- codigo de la visita, se imprime en el gafete
    -- Datos congelados al momento de entrar: la bitacora no debe cambiar
    -- porque despues alguien edite el padron o el catalogo.
    cedula            VARCHAR(20) NULL,
    nombre_completo   NVARCHAR(200) NULL,
    fecha_nacimiento  DATE NULL,
    sexo              VARCHAR(12) NULL,
    empresa           NVARCHAR(200) NULL,
    telefono          VARCHAR(40) NULL,
    correo            NVARCHAR(200) NULL,
    -- A donde va y por que
    departamento_id   INT NULL CONSTRAINT FK_vf_visitas_departamento REFERENCES dbo.vf_departamentos(id),
    motivo_id         INT NULL CONSTRAINT FK_vf_visitas_motivo REFERENCES dbo.vf_motivos(id),
    categoria_id      INT NULL CONSTRAINT FK_vf_visitas_categoria REFERENCES dbo.vf_categorias(id),
    sede_id           INT NULL CONSTRAINT FK_vf_visitas_sede REFERENCES dbo.vf_sedes(id),
    departamento_txt  NVARCHAR(160) NULL,
    motivo_txt        NVARCHAR(160) NULL,
    visitado          NVARCHAR(160) NULL,       -- persona a la que visita
    acompanantes      INT NOT NULL CONSTRAINT DF_vf_visitas_acomp DEFAULT 0,
    vehiculo          NVARCHAR(60) NULL,
    placa             VARCHAR(20) NULL,
    pertenencias      NVARCHAR(400) NULL,
    temperatura       DECIMAL(4,1) NULL,
    observaciones     NVARCHAR(600) NULL,
    -- Estado del flujo
    estado            VARCHAR(20) NOT NULL CONSTRAINT DF_vf_visitas_estado DEFAULT 'dentro', -- anunciada | dentro | salida | cancelada | denegada
    requiere_aprobacion BIT NOT NULL CONSTRAINT DF_vf_visitas_aprob DEFAULT 0,
    aprobada_por      NVARCHAR(160) NULL,
    aprobada          DATETIMEOFFSET(0) NULL,
    entrada           DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_visitas_entrada DEFAULT SYSDATETIMEOFFSET(),
    salida            DATETIMEOFFSET(0) NULL,
    preregistro_id    INT NULL,
    operador_id       INT NULL CONSTRAINT FK_vf_visitas_operador REFERENCES dbo.vf_usuarios(id),
    operador_nombre   NVARCHAR(160) NULL,
    salida_operador   NVARCHAR(160) NULL,
    creado            DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_visitas_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE UNIQUE INDEX UX_vf_visitas_codigo ON dbo.vf_visitas (tenant_id, codigo);
  CREATE INDEX IX_vf_visitas_tenant_entrada ON dbo.vf_visitas (tenant_id, entrada DESC);
  CREATE INDEX IX_vf_visitas_estado ON dbo.vf_visitas (tenant_id, estado, entrada DESC);
  CREATE INDEX IX_vf_visitas_cedula ON dbo.vf_visitas (tenant_id, cedula, entrada DESC);
  CREATE INDEX IX_vf_visitas_visitante ON dbo.vf_visitas (visitante_id, entrada DESC);
END
GO

/* ---------------------------------------------------------------------------
   7. Pre-registro (la visita se anuncia antes de que la persona llegue)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_preregistros', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_preregistros (
    id               INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_preregistros PRIMARY KEY,
    tenant_id        INT NOT NULL CONSTRAINT FK_vf_preregistros_tenant REFERENCES dbo.vf_tenants(id),
    codigo           VARCHAR(20) NOT NULL,     -- legible al dictarlo por telefono
    cedula           VARCHAR(20) NULL,
    nombre_completo  NVARCHAR(200) NOT NULL,
    empresa          NVARCHAR(200) NULL,
    telefono         VARCHAR(40) NULL,
    correo           NVARCHAR(200) NULL,
    departamento_id  INT NULL CONSTRAINT FK_vf_preregistros_dep REFERENCES dbo.vf_departamentos(id),
    motivo_id        INT NULL CONSTRAINT FK_vf_preregistros_motivo REFERENCES dbo.vf_motivos(id),
    visitado         NVARCHAR(160) NULL,
    fecha_prevista   DATETIMEOFFSET(0) NULL,
    acompanantes     INT NOT NULL CONSTRAINT DF_vf_preregistros_acomp DEFAULT 0,
    vehiculo         NVARCHAR(60) NULL,
    notas            NVARCHAR(600) NULL,
    estado           VARCHAR(20) NOT NULL CONSTRAINT DF_vf_preregistros_estado DEFAULT 'pendiente', -- pendiente | usado | vencido | cancelado
    visita_id        BIGINT NULL,
    creado_por       NVARCHAR(160) NULL,
    creado           DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_preregistros_creado DEFAULT SYSDATETIMEOFFSET(),
    vence            DATETIMEOFFSET(0) NULL,
    usado            DATETIMEOFFSET(0) NULL
  );
  CREATE UNIQUE INDEX UX_vf_preregistros_codigo ON dbo.vf_preregistros (tenant_id, codigo);
  CREATE INDEX IX_vf_preregistros_estado ON dbo.vf_preregistros (tenant_id, estado, fecha_prevista);
  CREATE INDEX IX_vf_preregistros_cedula ON dbo.vf_preregistros (tenant_id, cedula);
END
GO

/* ---------------------------------------------------------------------------
   8. Gafetes emitidos
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_gafetes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_gafetes (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_gafetes PRIMARY KEY,
    tenant_id     INT NOT NULL CONSTRAINT FK_vf_gafetes_tenant REFERENCES dbo.vf_tenants(id),
    visita_id     BIGINT NOT NULL CONSTRAINT FK_vf_gafetes_visita REFERENCES dbo.vf_visitas(id),
    plantilla_id  INT NULL CONSTRAINT FK_vf_gafetes_plantilla REFERENCES dbo.vf_plantillas_gafete(id),
    codigo        VARCHAR(20) NOT NULL,
    emitido       DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_gafetes_emitido DEFAULT SYSDATETIMEOFFSET(),
    impreso       DATETIMEOFFSET(0) NULL,
    veces_impreso INT NOT NULL CONSTRAINT DF_vf_gafetes_veces DEFAULT 0,
    devuelto      DATETIMEOFFSET(0) NULL,
    operador      NVARCHAR(160) NULL
  );
  CREATE INDEX IX_vf_gafetes_visita ON dbo.vf_gafetes (visita_id);
  CREATE INDEX IX_vf_gafetes_tenant ON dbo.vf_gafetes (tenant_id, emitido DESC);
END
GO

/* ---------------------------------------------------------------------------
   9. Lista de vigilancia (bloqueados y observados)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_vigilancia', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_vigilancia (
    id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_vigilancia PRIMARY KEY,
    tenant_id     INT NOT NULL CONSTRAINT FK_vf_vigilancia_tenant REFERENCES dbo.vf_tenants(id),
    cedula        VARCHAR(20) NOT NULL,
    nombre        NVARCHAR(200) NULL,
    tipo          VARCHAR(20) NOT NULL CONSTRAINT DF_vf_vigilancia_tipo DEFAULT 'observado', -- bloqueado | observado
    motivo        NVARCHAR(400) NOT NULL,
    severidad     VARCHAR(20) NOT NULL CONSTRAINT DF_vf_vigilancia_sev DEFAULT 'media', -- baja | media | alta
    autorizado_por NVARCHAR(160) NULL,
    vigente_desde DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_vigilancia_desde DEFAULT SYSDATETIMEOFFSET(),
    vigente_hasta DATETIMEOFFSET(0) NULL,
    activo        BIT NOT NULL CONSTRAINT DF_vf_vigilancia_activo DEFAULT 1,
    creado        DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_vigilancia_creado DEFAULT SYSDATETIMEOFFSET(),
    levantado     DATETIMEOFFSET(0) NULL,
    levantado_por NVARCHAR(160) NULL,
    levantado_motivo NVARCHAR(400) NULL
  );
  CREATE INDEX IX_vf_vigilancia_cedula ON dbo.vf_vigilancia (tenant_id, cedula, activo);
END
GO

IF OBJECT_ID('dbo.vf_vigilancia_avisos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_vigilancia_avisos (
    id           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_vigilancia_avisos PRIMARY KEY,
    tenant_id    INT NOT NULL CONSTRAINT FK_vf_vigilancia_avisos_tenant REFERENCES dbo.vf_tenants(id),
    vigilancia_id INT NULL,
    cedula       VARCHAR(20) NOT NULL,
    visita_id    BIGINT NULL,
    decision     VARCHAR(20) NOT NULL,   -- avisado | permitido | denegado
    motivo       NVARCHAR(400) NULL,
    operador     NVARCHAR(160) NULL,
    creado       DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_vigilancia_avisos_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_vigilancia_avisos ON dbo.vf_vigilancia_avisos (tenant_id, creado DESC);
END
GO

/* ---------------------------------------------------------------------------
   10. Auditoria
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_auditoria', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_auditoria (
    id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_auditoria PRIMARY KEY,
    tenant_id   INT NULL,
    usuario_id  INT NULL,
    usuario     NVARCHAR(160) NULL,
    accion      VARCHAR(60) NOT NULL,
    entidad     VARCHAR(60) NULL,
    entidad_id  VARCHAR(60) NULL,
    detalle     NVARCHAR(800) NULL,
    ip          VARCHAR(60) NULL,
    agente      NVARCHAR(300) NULL,
    creado      DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_auditoria_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_auditoria_tenant ON dbo.vf_auditoria (tenant_id, creado DESC);
  CREATE INDEX IX_vf_auditoria_accion ON dbo.vf_auditoria (accion, creado DESC);
END
GO

/* ---------------------------------------------------------------------------
   11. Bitacora de sincronizacion con el servidor de licencias
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.vf_licencias_revisiones', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_licencias_revisiones (
    id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_lic_rev PRIMARY KEY,
    tenant_id   INT NULL,
    origen      VARCHAR(20) NOT NULL,  -- servidor | archivo | local
    resultado   VARCHAR(20) NOT NULL,  -- ok | vencida | invalida | sin_conexion | sin_cambios
    estado      VARCHAR(20) NULL,
    mensaje     NVARCHAR(600) NULL,
    ip          VARCHAR(60) NULL,
    creado      DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_lic_rev_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_lic_rev ON dbo.vf_licencias_revisiones (creado DESC);
END
GO

-- ---------------------------------------------------------------------------
-- 12. Directorio de personas (el personal interno que recibe visitas)
--
-- Para que el recepcionista elija a quien visita de una lista, en vez de
-- escribir el nombre cada vez. Va ligado a un departamento, que es quien tiene
-- las reglas de acceso (si exige aprobacion, documento, etc.).
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.vf_personas', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_personas (
    id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_personas PRIMARY KEY,
    tenant_id       INT NOT NULL CONSTRAINT FK_vf_personas_tenant REFERENCES dbo.vf_tenants(id),
    departamento_id INT NULL CONSTRAINT FK_vf_personas_depto REFERENCES dbo.vf_departamentos(id),
    nombre          NVARCHAR(160) NOT NULL,
    cargo           NVARCHAR(120) NULL,
    correo          NVARCHAR(200) NULL,   -- a donde se avisa cuando llega una visita
    telefono        VARCHAR(40)   NULL,
    -- Quien recibe visitas casi siempre es la misma gente, pero no toda la
    -- plantilla. Este interruptor deja tener a todos y marcar solo a los que
    -- atienden visitas, sin borrar al resto.
    recibe_visitas  BIT NOT NULL CONSTRAINT DF_vf_personas_recibe DEFAULT 1,
    activo          BIT NOT NULL CONSTRAINT DF_vf_personas_activo DEFAULT 1,
    creado          DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_personas_creado DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_vf_personas_tenant ON dbo.vf_personas (tenant_id, activo, nombre);
END
GO

-- ---------------------------------------------------------------------------
-- 13. Avisos al anfitrion
--
-- Cuando llega una visita hay que avisar a quien la recibe. Esta tabla guarda
-- cada aviso y su estado, para que se vea en pantalla aunque el correo falle o
-- no haya correo configurado.
--
-- El aviso NO se pierde si no hay servidor de correo: queda como "sin enviar" y
-- se ve igual en la pantalla de quien recibe. Es a proposito: una junta de
-- vecinos puede no tener correo configurado, y quedarse sin avisar seria peor.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.vf_avisos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.vf_avisos (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vf_avisos PRIMARY KEY,
    tenant_id     INT NOT NULL CONSTRAINT FK_vf_avisos_tenant REFERENCES dbo.vf_tenants(id),
    -- BIGINT porque vf_visitas.id es BIGINT: la clave ajena exige el mismo tipo.
    visita_id     BIGINT NULL CONSTRAINT FK_vf_avisos_visita REFERENCES dbo.vf_visitas(id),
    persona_id    INT NULL CONSTRAINT FK_vf_avisos_persona REFERENCES dbo.vf_personas(id),
    departamento_id INT NULL CONSTRAINT FK_vf_avisos_depto REFERENCES dbo.vf_departamentos(id),
    -- A quien va dirigido. Se guardan el nombre y el correo COPIADOS, no solo
    -- la referencia: si manana se borra la persona del directorio, el aviso
    -- tiene que seguir diciendo a quien se aviso.
    destinatario      NVARCHAR(160) NOT NULL,
    destinatario_correo NVARCHAR(200) NULL,
    asunto        NVARCHAR(200) NOT NULL,
    cuerpo        NVARCHAR(MAX) NULL,
    -- enviado | sin_correo | error | leido
    estado        VARCHAR(20) NOT NULL CONSTRAINT DF_vf_avisos_estado DEFAULT 'sin_correo',
    error         NVARCHAR(400) NULL,
    enviado       DATETIMEOFFSET(0) NULL,
    leido         DATETIMEOFFSET(0) NULL,
    creado        DATETIMEOFFSET(0) NOT NULL CONSTRAINT DF_vf_avisos_creado DEFAULT SYSDATETIMEOFFSET()
  );
  -- El indice no incluye "estado": esa columna tiene otra intercalacion y SQL
  -- Server no deja mezclarla con tenant_id en la misma clave. Ademas la consulta
  -- filtra por "leido IS NULL" y ordena por fecha, asi que con tenant_id y
  -- creado ya se resuelve sin recorrer la tabla.
  CREATE INDEX IX_vf_avisos_tenant ON dbo.vf_avisos (tenant_id, creado DESC);
  CREATE INDEX IX_vf_avisos_visita ON dbo.vf_avisos (visita_id);
END
GO

PRINT 'Esquema VisitaFlow verificado.';
GO

/* ---------------------------------------------------------------------------
   14. Ajustes de columnas para bases que ya existian
   ---------------------------------------------------------------------------
   El esquema se aplica en cada arranque, asi que aqui se anaden columnas y se
   ensanchan las que en una version anterior quedaron cortas. Es seguro
   ejecutarlo siempre: solo actua si falta la columna o si el ancho es menor.
   --------------------------------------------------------------------------- */
IF EXISTS (
  SELECT 1 FROM sys.columns c
   WHERE c.object_id = OBJECT_ID('dbo.vf_visitantes')
     AND c.name = 'sexo' AND c.max_length < 12
)
BEGIN
  ALTER TABLE dbo.vf_visitantes ALTER COLUMN sexo VARCHAR(12) NULL;
  PRINT 'Columna vf_visitantes.sexo ampliada a VARCHAR(12).';
END
GO

IF EXISTS (
  SELECT 1 FROM sys.columns c
   WHERE c.object_id = OBJECT_ID('dbo.vf_visitas')
     AND c.name = 'sexo' AND c.max_length < 12
)
BEGIN
  ALTER TABLE dbo.vf_visitas ALTER COLUMN sexo VARCHAR(12) NULL;
  PRINT 'Columna vf_visitas.sexo ampliada a VARCHAR(12).';
END
GO

/* La visita guarda a QUE PERSONA del directorio se visita, no solo el nombre
   escrito. Con eso se puede avisar a quien corresponde y sacar reportes por
   anfitrion. El nombre se sigue guardando aparte (visitado), porque el
   recepcionista puede escribir a alguien que no esta en el directorio. */
IF NOT EXISTS (
  SELECT 1 FROM sys.columns c
   WHERE c.object_id = OBJECT_ID('dbo.vf_visitas') AND c.name = 'persona_id'
)
BEGIN
  ALTER TABLE dbo.vf_visitas ADD persona_id INT NULL;
  PRINT 'Columna vf_visitas.persona_id agregada.';
END
GO

IF EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = OBJECT_ID('dbo.vf_visitas') AND c.name = 'persona_id')
   AND NOT EXISTS (
     SELECT 1 FROM sys.foreign_keys fk
      WHERE fk.parent_object_id = OBJECT_ID('dbo.vf_visitas') AND fk.name = 'FK_vf_visitas_persona'
   )
BEGIN
  ALTER TABLE dbo.vf_visitas
    ADD CONSTRAINT FK_vf_visitas_persona FOREIGN KEY (persona_id) REFERENCES dbo.vf_personas(id);
  PRINT 'Clave ajena vf_visitas.persona_id creada.';
END
GO

IF EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = OBJECT_ID('dbo.vf_visitas') AND c.name = 'persona_id')
   AND NOT EXISTS (
     SELECT 1 FROM sys.indexes i
      WHERE i.object_id = OBJECT_ID('dbo.vf_visitas') AND i.name = 'IX_vf_visitas_persona'
   )
BEGIN
  CREATE INDEX IX_vf_visitas_persona ON dbo.vf_visitas (tenant_id, persona_id);
  PRINT 'Indice IX_vf_visitas_persona creado.';
END
GO

PRINT 'Ajustes aplicados.';
GO
