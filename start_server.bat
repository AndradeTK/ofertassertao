@echo off
title Rodando Servidor Node.js - OfertasSertao
echo Iniciando o servidor...

:: Verifica se a pasta src existe para evitar erros
if exist "src\server.js" (
    npm run dev
) else (
    echo [ERRO] O arquivo src/server.js nao foi encontrado.
    echo Verifique se voce colocou o .bat na raiz do projeto.
)

pause