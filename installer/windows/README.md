# Futuro instalador Windows

Contrato de trabajo, sin MSI/EXE ni cambios de servicios, SQL o firewall en esta fase.

- Confirmar Windows y arquitecturas, SQL existente vs instancia dedicada, firma de código y actualizaciones antes de elegir WiX u otro empaquetador.
- Binarios firmados, cuenta de servicio mínima y configuración bajo ProgramData con ACL. Secretos protegidos por Windows; solo clave pública en cliente.
- Identificador de instalación propio para licencia; puertos configurables con detección de colisiones y loopback por defecto.
- Ningún adjunto del MDF original ni modificación de servicios existentes. Base de aplicación independiente, respaldo y reversión de migraciones.
- Pruebas en VM limpia: instalación idempotente, inicio/parada, actualización, rollback y desinstalación. Conservar datos al desinstalar por defecto.
- Diagnósticos sin datos personales, accesibilidad y mantenimiento documentado. No prometer instalador operativo hasta verificar estos requisitos.
