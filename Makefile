DEV_ENV_FILE ?= .env
PROD_ENV_FILE ?= .env
COMPOSE_DEV = docker compose --env-file $(DEV_ENV_FILE) -f compose.dev.yaml
COMPOSE_PROD = docker compose --env-file $(PROD_ENV_FILE) -f compose.prod.yaml

.PHONY: dev dev-down prod prod-build prod-deploy prod-down prod-logs bootstrap bootstrap-prod test

dev:
	$(COMPOSE_DEV) up --build

dev-down:
	$(COMPOSE_DEV) down

prod:
	$(COMPOSE_PROD) up --build -d --remove-orphans

prod-build:
	$(COMPOSE_PROD) build --pull

# Используется на сервере после того, как CI/CD опубликовал образы.
prod-deploy:
	$(COMPOSE_PROD) pull
	$(COMPOSE_PROD) up -d --no-build --remove-orphans

prod-down:
	$(COMPOSE_PROD) down

prod-logs:
	$(COMPOSE_PROD) logs -f --tail=100

bootstrap:
	$(COMPOSE_DEV) run --rm api bootstrap "$(NAME)"

bootstrap-prod:
	$(COMPOSE_PROD) run --rm api bootstrap "$(NAME)"

test:
	cd backend && go test ./... && go vet ./...
	cd frontend && npm run lint && npm run check && npm test -- --run && npm run build
