@echo off
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py
echo Iniciando servidor en http://localhost:8000 ...
start "Servidor calabozo (cierra esta ventana para detenerlo)" cmd /k "%PY% serve.py"
timeout /t 2 /nobreak >nul
start "" http://localhost:8000/
