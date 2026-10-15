# PRODUCT.md — VisitaFlow

> Contexto de producto. Se escribió a partir del brief del usuario y de las
> decisiones que tomó explícitamente en esta sesión, sin inventar nada:
> producto nuevo **multi-tenant con licenciamiento**, en el estilo tecnológico
> del sistema que ya existe (Node/Express + SQL Server), con el padrón de
> cédulas subido al VPS **sin fotografías**.

## Qué es

Sistema de gestión de visitantes que cada institución instala y opera con su
propia identidad: consulta la cédula del visitante contra un padrón local,
registra la entrada en segundos, imprime un gafete y deja la bitácora de
quién entró, a quién visitó y cuándo salió.

## Para quién

- **Recepción / vigilancia** (uso principal, todo el día): registra entradas y
  salidas desde un equipo de recepción. No es técnico. Necesita teclear poco.
- **Supervisión**: reportes, lista de vigilancia, catálogos.
- **Administración de la institución**: usuarios, permisos, logo y colores.
- **El proveedor del software** (el usuario): emite licencias, da de alta
  instituciones y controla la vigencia desde su propio servidor.

## Verdad del producto

- **Un registro debe tomar segundos, no minutos.** La cédula va primero y todo
  lo demás se autocompleta desde el padrón.
- **El sistema no acepta identidades que no pueda verificar** cuando el padrón
  está configurado y la validación es obligatoria.
- **La bitácora no depende del padrón.** Lo que se validó al entrar queda
  congelado en la visita, para que el historial no cambie si el padrón cambia.
- **Multi-tenant de verdad:** los datos de una institución no se mezclan con
  los de otra, y la institución sale del token de sesión, nunca del navegador.
- **El licenciamiento es criptográfico, no una fecha en un archivo.** El cliente
  no puede extender su licencia editándola: la firma deja de coincidir.
- **Al vencer, no se secuestra la información.** Se restringe la operación, pero
  los registros históricos siguen consultables y exportables.
- **Nada depende de Internet** para registrar, consultar o imprimir.

## Alcance de la primera versión

Recepción y registro, gafetes con QR y código de barras, catálogos, usuarios y
permisos, personalización de marca por institución, reportes, pre-registro,
lista de vigilancia, servidor de licencias con consola de administración, y
despliegue en contenedores para el VPS.

## Fuera de alcance por ahora

Fotografías del padrón (se descartan a propósito para optimizar espacio),
aplicación de escritorio empaquetada, facturación automática, y sincronización
entre sedes.
