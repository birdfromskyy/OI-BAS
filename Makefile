COMPOSE_DEV = docker compose --env-file .env -f compose.dev.yaml
COMPOSE_PROD = docker compose --env-file .env -f compose.prod.yaml

.PHONY: dev dev-down prod prod-down bootstrap test

dev:
	$(COMPOSE_DEV) up --build

dev-down:
	$(COMPOSE_DEV) down

prod:
	$(COMPOSE_PROD) up --build -d

prod-down:
	$(COMPOSE_PROD) down

bootstrap:
	$(COMPOSE_DEV) run --rm api bootstrap "$(NAME)"

test:
	cd backend && go test ./... && go vet ./...
	cd frontend && npm run lint && npm run check && npm test -- --run && npm run build
