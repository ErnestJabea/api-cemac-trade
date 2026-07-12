@echo off
set PORT=3000
set DB_HOST=127.0.0.1
set DB_PORT=3306
set DB_USER=root
set DB_PASS=root
set DB_NAME=cemac_trade_test
set DB_SYNC_ON_STARTUP=true
set DB_SYNC_ALTER=false
set DEBUG_DB_STARTUP=false
set FRONTEND_URL=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174
cd /d "%~dp0\.."
node app.js >> backend-local.out.log 2>> backend-local.err.log
