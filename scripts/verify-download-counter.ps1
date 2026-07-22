param(
    [string]$NodeExecutable = "node"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$testPath = Join-Path $repoRoot "tests/download-counter.test.mjs"

& $NodeExecutable --test $testPath
if ($LASTEXITCODE -ne 0) {
    throw "download_counter_tests_failed"
}

"DOWNLOAD_COUNTER=PASS"
