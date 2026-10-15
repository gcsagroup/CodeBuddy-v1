@ECHO OFF
SETLOCAL EnableDelayedExpansion

SET "NODE_VERSION=22.14.0"
if not defined GOOSE_NODE_DIR (
    SET "GOOSE_NODE_DIR=%LOCALAPPDATA%\CodeBuddy\node"
    REM Reuse the matching installed legacy cache; never move or delete it.
    if not exist "%LOCALAPPDATA%\CodeBuddy\node\node-v%NODE_VERSION%.installed" (
        if exist "%LOCALAPPDATA%\CodeAgentPro\node\node-v%NODE_VERSION%.installed" (
            SET "GOOSE_NODE_DIR=%LOCALAPPDATA%\CodeAgentPro\node"
        )
    )
)

REM === Check for previously downloaded portable Node.js (matching version) ===
if exist "%GOOSE_NODE_DIR%\node-v%NODE_VERSION%.installed" (
    SET "PATH=%GOOSE_NODE_DIR%;!PATH!"
    "%GOOSE_NODE_DIR%\npx.cmd" %*
    exit /b !errorlevel!
)

REM === Download portable Node.js ===
echo [CodeBuddy] 未找到 Node.js，正在下载便携版 Node.js v%NODE_VERSION%... 1>&2

SET "NODE_ZIP=%TEMP%\codebuddy-node-%NODE_VERSION%.zip"
SET "NODE_EXTRACT=%TEMP%\codebuddy-node-extract"

powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip' -OutFile '%NODE_ZIP%' -UseBasicParsing; Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%NODE_EXTRACT%' -Force; exit 0 } catch { Write-Error $_.Exception.Message; exit 1 }"
if errorlevel 1 (
    echo [CodeBuddy] 错误：Node.js 下载失败。请从 https://nodejs.org/ 手动安装。 1>&2
    del "%NODE_ZIP%" >nul 2>&1
    exit /b 1
)

REM Clean previous version and install to CodeBuddy directory
rmdir /s /q "%GOOSE_NODE_DIR%" >nul 2>&1
mkdir "%GOOSE_NODE_DIR%" >nul 2>&1
xcopy /s /e /q /y "%NODE_EXTRACT%\node-v%NODE_VERSION%-win-x64\*" "%GOOSE_NODE_DIR%\" >nul 2>&1

REM Clean up
del "%NODE_ZIP%" >nul 2>&1
rmdir /s /q "%NODE_EXTRACT%" >nul 2>&1

if exist "%GOOSE_NODE_DIR%\npx.cmd" (
    echo.>"%GOOSE_NODE_DIR%\node-v%NODE_VERSION%.installed"
    SET "PATH=%GOOSE_NODE_DIR%;!PATH!"
    echo [CodeBuddy] Node.js v%NODE_VERSION% 已就绪。 1>&2
    "%GOOSE_NODE_DIR%\npx.cmd" %*
    exit /b !errorlevel!
)

echo [CodeBuddy] 错误：安装失败。请从 https://nodejs.org/ 手动安装 Node.js。 1>&2
exit /b 1
