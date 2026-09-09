# OI-BAS

PWA для учёта полётов, персонала, парка БВС, чеклистов и аккумуляторов.
Приложение рассчитано на работу в полях: действия сначала надёжно сохраняются
на устройстве, а затем синхронизируются с PostgreSQL при появлении сети.

## Возможности

- персональные бессрочные ссылки вместо регистрации и паролей;
- роли: владелец, администратор, пилот, наблюдатель;
- учёт полётов, БВС, площадок, чеклистов, прохождений и аккумуляторов;
- мягкое удаление связанных сущностей и аудит действий;
- PWA и офлайн-очередь синхронизации;
- optimistic locking: ревизии защищают запись от случайной перезаписи.

## Структура

```text
backend/
  cmd/api/                         # точка запуска и CLI-команда bootstrap
  internal/config/                 # чтение и проверка окружения
  internal/database/postgres/      # подключение к PostgreSQL
  internal/httpapi/                # Gin API, ссылки, роли, sync
  db/legacy-schema.sql             # исходная схема, не применяется приложением
frontend/                          # SvelteKit PWA
docs/                              # требования и техническая документация
compose.dev.yaml                   # локальная разработка с Vite
compose.prod.yaml                  # production-сборка с Caddy
.env.example                       # безопасный шаблон переменных
```

## Требования

- Docker Desktop с Docker Compose v2;
- GNU Make (на macOS уже доступен);
- для запуска вне Docker: Go 1.26 и Node.js 25.

## Локальный запуск

Создайте локальную конфигурацию. Файл `.env` игнорируется Git и не должен
публиковаться.

```sh
cp .env.example .env
make dev
```

Откройте `http://localhost:8080`.

| Сервис | Адрес |
| --- | --- |
| PWA | `http://localhost:8080` |
| Go API | `http://localhost:8081` |
| PostgreSQL | `localhost:5435` |

Первый владелец создаётся только для пустой БД. Команда напечатает единственную
персональную ссылку — сохраните её в надёжном месте.

```sh
make bootstrap NAME="ФИО владельца"
```

Остановить локальный контур, не удаляя данные:

```sh
make dev-down
```

## Production

Перед запуском задайте в локальном `.env` уникальный `POSTGRES_PASSWORD` и
публичный адрес `APP_BASE_URL_PROD`.

```sh
make prod
```

Production раздаёт PWA и API на одном origin, по умолчанию
`http://localhost:8080`. PostgreSQL наружу не публикуется.

`compose.dev.yaml` и `compose.prod.yaml` используют один именованный local
volume `oi-bas_postgres_data`; это сохраняет существующие данные и access-link
при переходе между режимами. Запускайте только один режим одновременно.

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `POSTGRES_DB` | имя базы данных |
| `POSTGRES_USER` | пользователь PostgreSQL |
| `POSTGRES_PASSWORD` | пароль PostgreSQL; только в локальном `.env` |
| `POSTGRES_PORT` | локальный порт PostgreSQL для development |
| `API_PORT` | локальный порт Go API для development |
| `WEB_PORT_DEV` | локальный порт PWA в development |
| `APP_BASE_URL_DEV` | базовый URL ссылок в development |
| `WEB_PORT_PROD` | внешний HTTP-порт production |
| `APP_BASE_URL_PROD` | публичный URL production-ссылок |

## Доступ и синхронизация

В БД хранится только SHA-256 хеш access-link, никогда не исходный токен.
Перевыпуск ссылки заменяет старую, отзыв делает её недействительной.

Каждая синхронизируемая запись содержит `revision`: создание имеет ревизию `0`,
сервер сохраняет её как `1`, следующее изменение отправляется с `1` и получает
`2`. Очередь сохраняется в localStorage до начала сетевого запроса. При
настоящем конфликте серверную версию не перезаписывают автоматически.

## Проверки

```sh
make test
```

Команда запускает Go-тесты и `go vet`, а также Prettier, Svelte typecheck,
Vitest и production-сборку frontend.

Для интеграционного API-теста требуется запущенная локальная БД:

```sh
set -a && source .env && set +a
TEST_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=disable" \
  go test -count=1 ./backend/internal/httpapi -run TestAPIIntegration -v
```

## Коммиты

Используются Conventional Commits с русским описанием:

```text
feat: добавить создание чеклиста
fix: устранить повторную отправку синхронизации
docs: описать локальный запуск
chore: обновить docker-конфигурацию
```
