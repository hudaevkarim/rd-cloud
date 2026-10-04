# Подключение тулчейна проекта. Использование:
#
#   . .\tools\env.ps1
#   node -v; npm -v
#
# Зачем это нужно. В системе node и git установлены, но НЕ прописаны в PATH,
# поэтому `node`/`npm`/`git` не находятся. Portable Node 22 лежит в tools/node
# и добавляется в PATH здесь. Git берётся из системной установки
# (C:\Program Files\Git\cmd) — portable-сборку для него не ставили.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

# --- Node (portable, в репозитории) ------------------------------------------
$nodeDir = Join-Path $RepoRoot 'tools\node'
if (Test-Path (Join-Path $nodeDir 'node.exe')) {
    if ($env:PATH -notlike "*$nodeDir*") {
        $env:PATH = "$nodeDir;$env:PATH"
    }
} else {
    Write-Warning "Не найден portable Node в $nodeDir — используется системный."
}

# --- Git (системная установка) ----------------------------------------------
$gitCmd = 'C:\Program Files\Git\cmd'
if (Test-Path $gitCmd) {
    if ($env:PATH -notlike "*$gitCmd*") {
        $env:PATH = "$gitCmd;$env:PATH"
    }
}

# --- PostgreSQL --------------------------------------------------------------
# Кластер: C:\rcdb\pgdata. Запуск: .\tools\pg-start.ps1

# --- .env --------------------------------------------------------------------
# Загружаем в процесс, чтобы `npm run dev` и Prisma видели переменные без
# явного dotenv. Prisma 7 сам .env больше не читает.
$envFile = Join-Path $RepoRoot '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile -Encoding UTF8) {
        $trim = $line.Trim()
        if ($trim -eq '' -or $trim.StartsWith('#')) { continue }
        $eq = $trim.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $trim.Substring(0, $eq).Trim()
        $value = $trim.Substring($eq + 1).Trim().Trim('"').Trim("'")
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

# --- Алиасы для этой сессии --------------------------------------------------
function npm { & (Join-Path $nodeDir 'npm.cmd') @args }
function npx { & (Join-Path $nodeDir 'npx.cmd') @args }

Write-Host "Окружение rd-cloud:"
Write-Host ("  node    " + (& (Join-Path $nodeDir 'node.exe') -v))
Write-Host ("  npm     " + (& (Join-Path $nodeDir 'npm.cmd') -v))
Write-Host ("  git     " + (& 'C:\Program Files\Git\cmd\git.exe' --version))
Write-Host "  .env    загружен"