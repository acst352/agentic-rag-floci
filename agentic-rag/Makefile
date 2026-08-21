# =============================================================================
# Agentic RAG — Local $0 stack
# Orquestación de Docker + dev con hot-reload + tareas comunes
# =============================================================================

PROJECT      := agentic-rag
COMPOSE_DIR  := compose
COMPOSE_FILE := $(COMPOSE_DIR)/docker-compose.yml
ENV_FILE     := $(COMPOSE_DIR)/.env
ENV_EXAMPLE  := $(COMPOSE_DIR)/.env.example
MCP_DIR      := mcp-server
AGENT_DIR    := agent

# Variables de entorno para tooling que corre en el host (seed, dev local)
export DATABASE_URL ?= postgres://rag:rag@localhost:5432/rag
export OLLAMA_HOST  ?= http://localhost:11434

# -----------------------------------------------------------------------------
# Secrets (compose/.env). Se auto-genera si falta.
# -----------------------------------------------------------------------------
$(ENV_FILE):
	@if [ ! -f $(ENV_FILE) ]; then \
		HMAC_SECRET=$$(openssl rand -hex 32); \
		printf 'HMAC_SECRET=%s\n' "$$HMAC_SECRET"          > $(ENV_FILE); \
		printf 'HMAC_KEY_ID=local-dev\n'                   >> $(ENV_FILE); \
		printf 'HMAC_WINDOW_SECONDS=300\n'                 >> $(ENV_FILE); \
		printf 'HMAC_AUTH_ENABLED=true\n'                  >> $(ENV_FILE); \
		printf '# Generated %s. DO NOT COMMIT.\n' "$$(date -Iseconds 2>/dev/null || date)" >> $(ENV_FILE); \
		echo "[ok] $(ENV_FILE) creado con HMAC_SECRET aleatorio"; \
	else \
		echo "[ok] $(ENV_FILE) ya existe (no se sobreescribe)"; \
	fi

init-env: $(ENV_FILE) ## Crea compose/.env con HMAC_SECRET aleatorio si no existe

show-env: $(ENV_FILE) ## Muestra el HMAC_SECRET y KEY_ID actuales (útil para curl)
	@echo "HMAC_KEY_ID=$(shell grep '^HMAC_KEY_ID=' $(ENV_FILE) | cut -d= -f2-)"
	@echo "HMAC_SECRET=$(shell grep '^HMAC_SECRET=' $(ENV_FILE) | cut -d= -f2-)"

.DEFAULT_GOAL := help
.PHONY: help up down restart build ps logs \
        pull-models migrate seed \
        dev-infra dev-mcp dev-agent \
        install typecheck test \
        status reset clean \
        init-env show-env

# -----------------------------------------------------------------------------
# Ayuda
# -----------------------------------------------------------------------------
help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# -----------------------------------------------------------------------------
# Stack completo (Docker)
# -----------------------------------------------------------------------------
up: $(ENV_FILE) ## Levanta los 5 servicios en background
	cd $(COMPOSE_DIR) && docker compose up -d --build

down: ## Para y elimina los contenedores (conserva volúmenes)
	cd $(COMPOSE_DIR) && docker compose down

restart: $(ENV_FILE) ## Reinicia los contenedores
	cd $(COMPOSE_DIR) && docker compose restart

build: $(ENV_FILE) ## Reconstruye las imágenes sin caché
	cd $(COMPOSE_DIR) && docker compose build --no-cache

ps: ## Estado de los servicios
	cd $(COMPOSE_DIR) && docker compose ps

logs: ## Logs en follow (Ctrl+C para salir)
	cd $(COMPOSE_DIR) && docker compose logs -f --tail=100

logs-%: ## Logs de un servicio concreto (ej: make logs-agent-api)
	cd $(COMPOSE_DIR) && docker compose logs -f --tail=100 $*

# -----------------------------------------------------------------------------
# Bootstrap inicial (primera vez)
# -----------------------------------------------------------------------------
pull-models: ## Descarga los modelos de Ollama (nomic-embed-text, qwen2.5:3b)
	docker exec rag-ollama ollama pull nomic-embed-text
	docker exec rag-ollama ollama pull qwen2.5:3b

migrate: ## Aplica las migraciones Drizzle al postgres
	cd $(MCP_DIR) && npm run db:migrate

seed: ## Genera embeddings e inserta los 10 documentos seed
	cd $(MCP_DIR) && npm run seed

bootstrap: $(ENV_FILE) up pull-models migrate seed ## Primera instalación completa

# -----------------------------------------------------------------------------
# Modo dev (código en host, infra en Docker)
# -----------------------------------------------------------------------------
dev-infra: ## Solo infra: floci + postgres + ollama
	cd $(COMPOSE_DIR) && docker compose up -d floci postgres ollama

dev-mcp: ## MCP server con hot-reload (requiere dev-infra)
	cd $(MCP_DIR) && npm run dev

dev-agent: ## agent-api con hot-reload (requiere dev-infra + dev-mcp)
	cd $(AGENT_DIR) && npm run dev

# -----------------------------------------------------------------------------
# Calidad
# -----------------------------------------------------------------------------
install: ## yarn install en ambos paquetes
	cd $(MCP_DIR)  && yarn install
	cd $(AGENT_DIR) && yarn install

typecheck: ## tsc --noEmit en ambos paquetes
	cd $(MCP_DIR)  && npx tsc -p tsconfig.json --noEmit
	cd $(AGENT_DIR) && npm run typecheck

test: ## Vitest en ambos paquetes (cuando se añada)
	cd $(MCP_DIR)  && npm test
	cd $(AGENT_DIR) && npm test

# -----------------------------------------------------------------------------
# Diagnóstico y limpieza
# -----------------------------------------------------------------------------
status: ps ## ps + healthchecks rápidos
	@echo "--- healthchecks ---"
	@curl -s -o /dev/null -w "agent-api :3002  -> %{http_code}\n" http://localhost:3002/health || true
	@curl -s -o /dev/null -w "mcp-server:3001  -> %{http_code}\n" http://localhost:3001/health   || true
	@curl -s -o /dev/null -w "floci     :4566  -> %{http_code}\n" http://localhost:4566/health   || true
	@curl -s -o /dev/null -w "ollama    :11434 -> %{http_code}\n" http://localhost:11434/         || true

reset: ## ⚠ down -v  (BORRA VOLÚMENES: postgres, ollama, floci)
	cd $(COMPOSE_DIR) && docker compose down -v

clean: ## Limpia artefactos locales (dist/, node_modules/)
	rm -rf $(MCP_DIR)/dist  $(AGENT_DIR)/dist
	rm -rf $(MCP_DIR)/node_modules $(AGENT_DIR)/node_modules