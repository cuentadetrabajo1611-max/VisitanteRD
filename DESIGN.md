# DESIGN.md — VisitaFlow

## Modo

**Operate.** Recepción usa esto decenas de veces al día, de pie, con alguien
esperando enfrente. La interfaz se juzga por lo rápido que deja registrar a una
persona y por lo claro que deja el estado de la operación, no por lo expresiva
que sea.

## Mundo visual

Institucional y limpio, siguiendo el lenguaje de las referencias de diseño que
aportó el brief (paneles con barra lateral oscura, fondo claro, tarjetas
discretas, tablas legibles):

- Barra lateral **oscura y fija** con los módulos agrupados por sección.
- Área de trabajo sobre **fondo claro**, con tarjetas de esquinas suaves y
  sombras apenas perceptibles.
- Color de marca de la institución aplicado como **variable CSS**, no incrustado
  en cada regla: por eso cambiar el color en Personalización repinta todo el
  sistema, incluido el gafete.
- Jerarquía por tipografía y espacio, no por líneas ni degradados.

## Reglas de la casa

1. **La cédula primero.** En Registro, el primer campo y el foco inicial son la
   cédula. Un solo botón consulta y autocompleta.
2. **Un estado, un color.** Verde = dentro, ámbar = pendiente de aprobación,
   rojo = bloqueado, gris = salió. Nunca dos significados para el mismo color.
3. **Los datos validados se distinguen** de los escritos a mano: lo que viene del
   padrón se marca, para que recepción sepa qué está verificado.
4. **El contraste no se negocia con la marca.** Los colores institucionales se
   aplican, pero el texto sobre ellos se calcula para mantener legibilidad.
5. **Sin animaciones en recepción.** Nada que retrase un clic.
6. **El gafete se ve antes de imprimir.** Vista previa real, al tamaño de salida.
7. **Los estados vacíos enseñan**: cada pantalla sin datos dice qué hacer, no
   deja un hueco en blanco.

## Superficies

| Superficie | Modo | Qué resuelve |
|---|---|---|
| Recepción (panel) | Operate | Cuántos hay dentro, quién entró, qué está pendiente |
| Registro | Operate | Meter a una persona en segundos |
| Visitantes dentro | Operate | Registrar la salida con un clic |
| Bitácora | Operate | Encontrar una visita y exportarla |
| Pre-registro | Operate | Anunciar la visita antes de que llegue |
| Vigilancia | Operate | Bloqueados y observados, con aviso inmediato |
| Gafete | Operate | Vista previa e impresión |
| Configuración / Personalización | Operate | Catálogos, logo, colores |
| Usuarios y permisos | Operate | Operadores y qué puede cada rol |
| Licencia | Operate | Estado, días restantes, activación |
| Consola de licencias | Operate | Alta de instituciones y emisión de licencias |

## Referencias aportadas

En `docs/diseno/` (fuera de este proyecto) están las referencias visuales del
brief. Se usan como evidencia del lenguaje visual, no como pantallas a copiar.
