@echo off
REM ============================================================================
REM  VisitaFlow - Arranque con doble clic
REM ----------------------------------------------------------------------------
REM  Comprueba que este todo en su sitio y levanta el sistema.
REM  Para detenerlo: cierre esta ventana o pulse Ctrl+C.
REM ============================================================================

title VisitaFlow
cd /d "%~dp0"

echo.
echo   ============================================================
echo    VisitaFlow - sistema de visitantes
echo   ============================================================
echo.

REM --- 1. Node instalado ------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] No se encontro Node.js.
  echo       Instalelo desde https://nodejs.org y vuelva a intentarlo.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
echo   [1/5] Node.js %NODE_VERSION%

REM --- 2. Dependencias --------------------------------------------------------
if not exist "node_modules" (
  echo   [2/5] Instalando dependencias ^(solo la primera vez^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [X] No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
) else (
  echo   [2/5] Dependencias instaladas
)

REM --- 3. Configuracion -------------------------------------------------------
if not exist ".env" (
  echo   [X] Falta el archivo .env
  echo       Copie .env.example a .env y rellene los datos de su SQL Server.
  echo.
  pause
  exit /b 1
)
echo   [3/5] Configuracion encontrada

REM --- 4. Llaves del licenciamiento -------------------------------------------
if not exist "licencias-keys\privada.pem" (
  echo   [4/5] Generando el par de llaves del licenciamiento...
  call node scripts\generar-llaves.js
) else (
  echo   [4/5] Llaves del licenciamiento presentes
)

REM --- 5. Licencia de la instalacion ------------------------------------------
if not exist "licencia.vflow" (
  echo   [5/5] No hay licencia. Se emite una de prueba de 365 dias...
  call node sql\02-licencia-prueba.js junta-los-prados 365
) else (
  echo   [5/5] Licencia encontrada
)

echo.
echo   ------------------------------------------------------------
echo    Preparando la base de datos...
echo   ------------------------------------------------------------
echo.
call node sql\01-crear.js
if errorlevel 1 (
  echo.
  echo   [X] No se pudo preparar la base de datos.
  echo       Revise DB_SERVER, DB_USER y DB_PASSWORD en el archivo .env
  echo.
  pause
  exit /b 1
)

echo.
echo   ------------------------------------------------------------
echo    Arrancando el sistema...
echo   ------------------------------------------------------------
echo.
echo   Cuando vea "VisitaFlow en marcha", abra en el navegador:
echo.
echo        http://localhost:3000
echo.
echo   La contrasena del administrador esta en CLAVE-ADMINISTRADOR.txt
echo.
echo   Para detener el sistema: Ctrl+C en esta ventana.
echo.

node server.js

echo.
echo   El sistema se detuvo.
pause
