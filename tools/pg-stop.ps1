# Остановка PostgreSQL.
#
# Сначала штатное завершение через pg_ctl: сервер гасит буферы и
# checkpoint, и следующий старт будет быстрым. pg_ctl stop не блокирует,
# в отличие от start, — ждать завершения не нужно.

$ErrorActionPreference = 'Stop'

$pgBin   = 'C:\rcdb\pgsql\bin'
$pgData  = 'C:\rcdb\pgdata'
$mode    = if ($args -Contains '-m') { 'fast' } else { 'smart' }

& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -m $mode -w stop
if ($LASTEXITCODE -ne 0) {
    throw "pg_ctl stop вернул $LASTEXITCODE"
}
Write-Host "PostgreSQL остановлен (режим: $mode)"