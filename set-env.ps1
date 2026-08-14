# Variables de entorno para apuntar a Floci (AWS local)
$env:AWS_ACCESS_KEY_ID = "floci"
$env:AWS_SECRET_ACCESS_KEY = "floci"
$env:AWS_DEFAULT_REGION = "us-east-1"
$env:AWS_ENDPOINT_URL = "http://localhost:4566"

# Mostrar configuración
Write-Host "AWS CLI configurado para Floci:" -ForegroundColor Cyan
Write-Host "  Endpoint: $env:AWS_ENDPOINT_URL" -ForegroundColor Gray
Write-Host "  Region:   $env:AWS_DEFAULT_REGION" -ForegroundColor Gray
Write-Host "  Access:   $env:AWS_ACCESS_KEY_ID" -ForegroundColor Gray
