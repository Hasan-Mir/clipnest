$scriptPath = Join-Path $PSScriptRoot "bundle-context.ts"
& bun run $scriptPath @args
exit $LASTEXITCODE
