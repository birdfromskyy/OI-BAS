# OI-BAS

PWA для учёта полётов, персонала, парка БВС, чеклистов и аккумуляторов.
Приложение сохраняет действия на устройстве и синхронизирует их с PostgreSQL
после появления сети.

## Возможности

- персональные бессрочные ссылки вместо паролей и регистрации;
- роли: владелец, администратор, пилот и наблюдатель;
- учёт полётов, БВС, локаций, чеклистов, прохождений и аккумуляторов;
- мягкое удаление, аудит и проверка связанных записей;
- PWA и офлайн-очередь синхронизации;
- optimistic locking: `revision` защищает записи от незаметной перезаписи.

## Архитектура

```text
Браузер / PWA
       │ HTTPS :443
       ▼
 Caddy (единственный публичный контейнер)
       │ private Docker network
       ▼
 Go + Gin API ───────── PostgreSQL
       private Docker network
```

В production наружу публикуются только 80 и 443 порты Caddy. API и PostgreSQL
не имеют host-портов и недоступны напрямую из интернета.

```text
backend/
  cmd/api/                         # точка запуска и команда bootstrap
  internal/config/                 # проверка окружения
  internal/database/postgres/      # пул PostgreSQL
  internal/httpapi/                # Gin API, роли, ссылки, sync
frontend/                          # SvelteKit PWA
compose.dev.yaml                   # Vite + API + PostgreSQL для разработки
compose.prod.yaml                  # изолированный production-контур
.env.example                       # безопасный шаблон development
.env.prod.example                  # безопасный шаблон production
.github/workflows/                 # CI, публикация и ручное deployment
```

## Локальная разработка

Нужны Docker Desktop с Compose v2 и GNU Make.

```sh
cp .env.example .env
make dev
```

После запуска доступны:

| Сервис | Адрес |
| --- | --- |
| PWA | `http://localhost:8080` |
| Go API | `http://localhost:8081` |
| PostgreSQL | `localhost:5435` |

Первый владелец создаётся только в пустой БД. Команда напечатает единственную
персональную ссылку — сохраните её в менеджере паролей.

```sh
make bootstrap NAME="ФИО владельца"
```

Остановить development-контур, не удаляя данные:

```sh
make dev-down
```

## Production

Production-конфигурация подготовлена, но до фактического развёртывания нужно:

1. Направить A-запись `oi-bas.space` на публичный IP сервера.
2. Открыть на сервере только TCP 22, 80 и 443.
3. На сервере скопировать шаблон в **неотслеживаемый** файл `.env` и заменить
   все значения `REPLACE_*`:

   ```sh
   cp .env.prod.example .env
   chmod 600 .env
   ```

4. Указать реальный `TLS_EMAIL`, длинный уникальный `POSTGRES_PASSWORD` и
   публичный `APP_BASE_URL_PROD=https://oi-bas.space`.

Caddy сам выпустит и продлит TLS-сертификат Let's Encrypt. Его `/data` и
`/config`, а также production PostgreSQL хранятся в отдельных named volumes:
`caddy_data`, `caddy_config`, `postgres_prod_data`. Production Compose имеет
собственное имя проекта `oi-bas-prod`; его volumes и контейнеры не пересекаются
с development-контуром `oi-bas`.

Проверить итоговую Compose-конфигурацию без запуска:

```sh
docker compose --env-file .env -f compose.prod.yaml config --quiet
```

Первый запуск из исходников:

```sh
make prod
make bootstrap-prod NAME="ФИО владельца"
```

На рабочем компьютере, где `.env` уже используется development-контуром,
можно держать отдельный игнорируемый файл `.env.prod` и запускать так:

```sh
PROD_ENV_FILE=.env.prod make prod
```

Обычный production-деплой после публикации CI-образов:

```sh
make prod-deploy
make prod-logs
```

Никогда не используйте `docker compose down -v` на production: команда удалит
volume PostgreSQL и сертификаты Caddy.

## CI/CD

`Проверки` запускается на каждом push и pull request в `main`:

- Go format, тесты, `go vet` и интеграционный тест с чистым PostgreSQL;
- Prettier, Svelte typecheck, Vitest и production-сборка PWA;
- сборка обоих production-образов, проверка Caddy и Compose.

Тег вида `v1.0.0` запускает `Публикация образов` и помещает API/PWA в GHCR:
`ghcr.io/birdfromskyy/oi-bas-api:v1.0.0` и
`ghcr.io/birdfromskyy/oi-bas-web:v1.0.0`.

`Развёртывание production` запускается только вручную и использует GitHub
Environment `production`. До первого деплоя в этом Environment нужно добавить
следующие secrets:

| Secret | Значение |
| --- | --- |
| `DEPLOY_HOST` | публичный IP или `oi-bas.space` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_PRIVATE_KEY` | отдельный закрытый ключ GitHub Actions для пользователя `deploy` |
| `DEPLOY_KNOWN_HOSTS` | закреплённая строка из проверенного `ssh-keyscan -H <IP>` |

Не передавайте в GitHub Actions личный ключ `~/.ssh/oi_bas_prod`: для CI/CD
создаётся отдельная пара ключей с возможностью отдельно отозвать её.
Образы GHCR публикуются как public packages, поэтому сервер получает их без
постоянного GitHub-токена с правом `read:packages`.

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | реквизиты PostgreSQL |
| `POSTGRES_PORT` | development-порт PostgreSQL |
| `API_PORT`, `WEB_PORT_DEV` | development-порты API и PWA |
| `APP_BASE_URL_DEV` | базовый URL ссылок development |
| `APP_DOMAIN` | домен production Caddy |
| `TLS_EMAIL` | e-mail для Let's Encrypt |
| `APP_BASE_URL_PROD` | публичный HTTPS URL для новых ссылок |
| `API_IMAGE`, `WEB_IMAGE` | образы API и PWA для deployment |
| `DATABASE_MAX_CONNS` | предел пула PostgreSQL API, по умолчанию 10 |

## Доступ и синхронизация

В БД хранится только SHA-256-хеш персональной ссылки, а не исходный токен.
Новые ссылки передают токен в URL fragment (`/#access=…`): fragment не попадает
в HTTP-запросы, логи Caddy и Referer. Ранее выданные query-ссылки остаются
совместимыми и очищаются из адресной строки сразу после открытия.

Создание начинается с revision `0`, сервер сохраняет запись как `1`; следующее
изменение отправляется с `1` и получает `2`. При настоящем конфликте серверная
запись не перезаписывается автоматически.

Production-контур также включает лимит на перебор невалидных access-link,
лимит размера JSON-запроса (2 MiB), request ID, HTTP timeouts, read-only API
filesystem, drop Linux capabilities и security headers Caddy.

## Проверки

```sh
make test
```

Команда запускает Go-тесты и `go vet`, а затем Prettier, Svelte typecheck,
Vitest и production-сборку PWA.

Для локального интеграционного API-теста сначала поднимите development БД:

```sh
set -a && source .env && set +a
(
  cd backend
  TEST_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=disable" \
    go test -count=1 ./internal/httpapi -run TestAPIIntegration -v
)
```

## Резервное копирование

`deploy/backup/oi-bas-backup` создаёт custom-format `pg_dump`, а systemd timer
`deploy/systemd/oi-bas-backup.timer` запускает его ежедневно в 03:17
Екатеринбурга со случайной задержкой до 15 минут. На VDS хранится 14 последних
дней резервных копий и файлов SHA-256 в `/var/backups/oi-bas` с правами только
для root.

Локальная копия защищает от логических ошибок, но не от потери самого VDS.
До появления реальных ценных данных нужно добавить внешнюю копию в Object
Storage и отдельно проверить восстановление на чистой БД.

## Коммиты

Используются Conventional Commits с русским описанием:

```text
feat: добавить создание чеклиста
fix: устранить повторную отправку синхронизации
docs: описать локальный запуск
chore: обновить docker-конфигурацию
```
