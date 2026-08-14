# Floci - AWS local en Windows

Emulador local de AWS (alternativa open-source a LocalStack) corriendo en Docker.
Imagen: `floci/floci:latest` (Quarkus nativo, ~167 ms startup).

Basado en: <https://blog-ocampoge.medium.com/floci-the-lightweight-local-aws-emulator-360d0030f504>

## Levantar / parar

```powershell
docker compose up -d          # arrancar
docker compose down           # parar (conserva datos)
docker compose down -v        # parar y borrar TODO el estado
docker logs floci --tail 50   # logs
```

Health check: <http://localhost:4566/_localstack/health>

## AWS CLI

PowerShell no hereda el PATH entre invocaciones. Carga AWS con:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")
$env:AWS_ACCESS_KEY_ID = "floci"
$env:AWS_SECRET_ACCESS_KEY = "floci"
$env:AWS_DEFAULT_REGION = "us-east-1"
$env:AWS_ENDPOINT_URL = "http://localhost:4566"
aws s3 ls
```

O usa el script `./set-env.ps1` que ya configura esas variables (solo carga AWS en PATH).

Para hacerlo permanente, crea un perfil:

```powershell
aws configure set aws_access_key_id floci --profile floci
aws configure set aws_secret_access_key floci --profile floci
aws configure set region us-east-1 --profile floci
Add-Content $env:USERPROFILE\.aws\config "`n[profile floci]`nendpoint_url = http://localhost:4566"
aws s3 ls --profile floci
```

## Servicios probados OK

| Servicio | Estado |
|----------|--------|
| S3       | OK (buckets, objetos, versionado) |
| SQS      | OK (colas, mensajes, batch, FIFO, DLQ) |
| SNS      | OK (topics, suscripciones) |
| DynamoDB | OK (tablas, put/get/scan) |
| IAM      | OK (roles, 58 managed policies seeded) |
| STS      | OK |
| KMS      | OK (create/list keys) |
| CloudWatch Logs | OK |
| Secrets Manager / SSM / Step Functions / API Gateway | OK (health) |

## Limitación importante: Lambda, RDS, ECS, EC2

Floci corre esos servicios como **sub-contenedores Docker reales** usando
`docker-java`, que solo soporta **Unix sockets**.

En **Windows + Docker Desktop**, Docker expone un **named pipe**
(`\\.\pipe\docker_engine`). Al montarlo a `/var/run/docker.sock`, el
contenedor ve un directorio vacío, no un socket válido. Resultado:

```
Failed to start Lambda container: java.net.BindException: Permission denied
```

### Soluciones

1. **WSL2** (recomendado) — corre Docker dentro de WSL2 donde el socket
   sí es Unix real:
   ```powershell
   wsl --install                  # si no tienes WSL2
   # luego mueve el docker-compose a ~/floci/ dentro de WSL2
   ```

2. **Linux nativo o macOS** — sin problemas.

3. **No usar servicios Docker-backed** — S3, SQS, SNS, DynamoDB, IAM, STS,
   KMS, CloudWatch, etc. funcionan perfectamente desde Windows.

## Terraform

Ejemplo en `./terraform-example/`:

```powershell
cd terraform-example
terraform init
terraform apply -auto-approve
```
