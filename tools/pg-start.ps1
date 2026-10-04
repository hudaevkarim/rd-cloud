# Запуск PostgreSQL.
#
# Кластер лежит в C:\rcdb\pgdata, а не в репозитории. Причина найдена
# экспериментально: PostgreSQL на Windows открывает файлы через ANSI-codepage
# системы, а в системе она cp1251. Путь с кириллицей ("C:\Users\роман\...")
# он прочитать не может и падает с
#   FATAL: invalid byte sequence for encoding "UTF8": 0xf0 0xee 0xec 0xe0
# (это "роман" в cp1251). Node, npm, tsc, esbuild и Prisma с кириллицей
# работают нормально — негодный только сам Postgres.

$ErrorActionPreference = 'Stop'

$pgBin    = 'C:\rcdb\pgsql\bin'
$pgData   = 'C:\rcdb\pgdata'
$logFile  = 'C:\rcdb\pg.log'
$port     = 5432

if (-not (Test-Path (Join-Path $pgBin 'postgres.exe'))) {
    throw "Не найден postgres.exe в $pgBin"
}

# Уже запущен?
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "PostgreSQL уже слушает порт $port (PID $($listening[0].OwningProcess))"
    exit 0
}

# postgres.exe нельзя запускать через pg_ctl из этого окружения: дочерний
# процесс наследует канал вывода и команда не возвращает управление.
# Start-Process с -WindowStyle Hidden отсоединяет его полностью.
Write-Host "Запускаю PostgreSQL (порт $port)..."
Start-Process -FilePath (Join-Path $pgBin 'postgres.exe') `
  -ArgumentList '-D', $pgData, '-p', $port, '-c', 'listen_addresses=127.0.0.1' `
  -WindowStyle Hidden

# Ждём готовности соединения, а не просто появления процесса.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Host "PostgreSQL готов: 127.0.0.1:$port"
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

if (Test-Path $logFile) { Write-Host (Get-Content $logFile -Tail 20) }
throw "PostgreSQL не поднялся за 30 с"