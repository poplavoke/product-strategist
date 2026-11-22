# Locate bundled Python when Windows' python.exe is only a Store alias.
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $dependencies = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $nodeCommand.Source))
    $bundledPython = Join-Path $dependencies 'python\python.exe'
    if (Test-Path -LiteralPath $bundledPython) {
        & $bundledPython @args
        exit $LASTEXITCODE
    }
}

$systemPython = Get-Command python -ErrorAction SilentlyContinue
if ($systemPython -and $systemPython.Source -notlike '*\Microsoft\WindowsApps\*') {
    & $systemPython.Source @args
    exit $LASTEXITCODE
}
throw 'Python не найден: нужен установленный Python или Codex Primary Runtime.'
