-- ЭКИПАЖ — схема БД (набросок)
-- Область: MVP + Фаза 2/3, без ФТ-8 (видео и ИИ-анализ), одна компания.
-- PostgreSQL 16+. Ссылки в комментариях — на REQUIREMENTS.md.
--
-- Сквозные соглашения:
--   * id — UUIDv7, генерируется КЛИЕНТОМ для всех записей, создаваемых в поле (НФТ-1.4).
--     Повторная отправка безопасна: INSERT ... ON CONFLICT (id) DO NOTHING.
--   * company_id есть везде, хотя компания пока одна (задел под ФТ-18.3).
--   * device_time / server_received_at — на всех полевых записях (НФТ-1.12).
--   * Удаление логическое: deleted_at (НФТ-2.5).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. КОМПАНИЯ, ПОЛЬЗОВАТЕЛИ, ДОСТУП
-- ============================================================

-- ФТ-1.1, ФТ-1.8
CREATE TABLE companies (
    id              uuid PRIMARY KEY,
    name            text NOT NULL,
    inn             text,
    ogrn            text,
    legal_address   text,
    contact_person  text,
    timezone        text NOT NULL DEFAULT 'Europe/Moscow',
    settings        jsonb NOT NULL DEFAULT '{}',   -- единицы, пороги, срок годности прохождения (ФТ-4.13),
                                                   -- срок хранения видео (НФТ-4.4), «за сколько дней предупреждать»
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ФТ-2.1, ФТ-1.6 (почта необязательна), ФТ-1.9 (деактивация с сохранением истории)
CREATE TABLE users (
    id              uuid PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES companies(id),
    full_name       text NOT NULL,
    login           text NOT NULL,
    email           text,
    phone           text,
    position        text,
    password_hash   text NOT NULL,                 -- argon2id
    totp_secret     text,                          -- НФТ-3.4, включается пользователем
    approval_status text NOT NULL DEFAULT 'active' -- ФТ-1.4: набор по многоразовой ссылке
                    CHECK (approval_status IN ('pending','active')),
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, login)
);

-- ФТ-2.1: у пользователя может быть несколько ролей
CREATE TABLE user_roles (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('owner','admin','pilot','tech','observer')),
    granted_by  uuid REFERENCES users(id),
    granted_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

-- Пользовательские настройки: синхронизируются между устройствами
CREATE TABLE user_settings (
    user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme         text NOT NULL DEFAULT 'light'    -- НФТ-5.3: дефолт светлый, не системный
                  CHECK (theme IN ('light','dark','system')),
    font_scale    text NOT NULL DEFAULT 'normal' CHECK (font_scale IN ('normal','large')),
    locale        text NOT NULL DEFAULT 'ru',
    start_screen  text,
    notifications jsonb NOT NULL DEFAULT '{}',
    updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Настройки уровня устройства (Wi-Fi-only, лимит хранилища, период подготовки к выезду)
-- на сервере НЕ хранятся — только в Dexie.

CREATE TABLE sessions (
    id             uuid PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash     bytea NOT NULL UNIQUE,
    user_agent     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL
);

-- ФТ-1.2 … ФТ-1.5
CREATE TABLE invitations (
    id           uuid PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    token_hash   bytea NOT NULL UNIQUE,            -- НФТ-3.3: в базе только хеш
    role         text NOT NULL,
    max_uses     int,                              -- NULL = без ограничения
    used_count   int NOT NULL DEFAULT 0,
    expires_at   timestamptz NOT NULL,             -- по умолчанию +7 дней
    revoked_at   timestamptz,
    created_by   uuid NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitation_uses (
    invitation_id uuid NOT NULL REFERENCES invitations(id),
    user_id       uuid NOT NULL REFERENCES users(id),
    used_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (invitation_id, user_id)
);

-- ФТ-1.10, НФТ-2.3
CREATE TABLE audit_log (
    id           bigserial PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    actor_id     uuid REFERENCES users(id),
    entity_type  text NOT NULL,
    entity_id    uuid NOT NULL,
    action       text NOT NULL CHECK (action IN ('create','update','delete')),
    before       jsonb,
    after        jsonb,
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (company_id, entity_type, entity_id, at DESC);

-- ============================================================
-- 2. ФАЙЛЫ, ДОКУМЕНТЫ, ВЛОЖЕНИЯ
-- ============================================================

-- НФТ-4.3: сами байты в объектном хранилище (для одной компании — том на диске)
CREATE TABLE files (
    id            uuid PRIMARY KEY,
    company_id    uuid NOT NULL REFERENCES companies(id),
    storage_key   text NOT NULL,
    mime_type     text NOT NULL,
    size_bytes    bigint NOT NULL,
    sha256        bytea,
    original_name text,
    uploaded_by   uuid REFERENCES users(id),
    uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- ФТ-17: документы с офлайн-доступом. Владелец ровно один — проверяется CHECK,
-- вместо полиморфной связи: так работают внешние ключи.
CREATE TABLE documents (
    id             uuid PRIMARY KEY,
    company_id     uuid NOT NULL REFERENCES companies(id),
    file_id        uuid NOT NULL REFERENCES files(id),
    title          text NOT NULL,                   -- ФТ-17.3
    doc_type       text NOT NULL,                   -- список + свободный ввод (ФТ-2.3)
    valid_from     date,
    valid_until    date,                            -- ФТ-2.4, ФТ-14.5
    always_offline boolean NOT NULL DEFAULT false,  -- ФТ-17.7
    owner_user_id  uuid REFERENCES users(id),
    owner_aircraft_id uuid,
    owner_plan_id  uuid,
    owner_company  boolean NOT NULL DEFAULT false,
    created_by     uuid REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    deleted_at     timestamptz,
    CHECK (num_nonnulls(owner_user_id, owner_aircraft_id, owner_plan_id)
           + (owner_company)::int = 1)
);

-- Фотографии к пунктам прохождения, дефектам, происшествиям
CREATE TABLE attachments (
    id           uuid PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    file_id      uuid NOT NULL REFERENCES files(id),
    caption      text,
    answer_id    uuid,
    defect_id    uuid,
    flight_id    uuid,
    aircraft_id  uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(answer_id, defect_id, flight_id, aircraft_id) = 1)
);

-- ============================================================
-- 3. ПАРК БВС
-- ============================================================

-- Нужна для ФТ-4.2: шаблон чеклиста на уровне модели
CREATE TABLE aircraft_models (
    id           uuid PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    manufacturer text NOT NULL,
    model        text NOT NULL,
    UNIQUE (company_id, manufacturer, model)
);

-- ФТ-3.1 … ФТ-3.4, ФТ-3.7, ФТ-14.1
CREATE TABLE aircraft (
    id                 uuid PRIMARY KEY,
    company_id         uuid NOT NULL REFERENCES companies(id),
    model_id           uuid REFERENCES aircraft_models(id),
    kind               text,                        -- мультиротор / самолёт / …
    serial_number      text,
    manufactured_year  int,
    mtow_grams         int,
    reg_number         text,                        -- ФТ-3.2, необязателен → П-01
    reg_date           date,
    status             text NOT NULL DEFAULT 'serviceable'
                       CHECK (status IN ('serviceable','limited','repair','storage','written_off')),
    -- ФТ-3.7, эксплуатационные ограничения для П-11 (Фаза 2)
    limit_wind_ms      numeric(4,1),
    limit_temp_min_c   numeric(4,1),
    limit_temp_max_c   numeric(4,1),
    limit_alt_m        int,
    -- ФТ-3.4: денормализованные счётчики, пересчитываются из flights при закрытии полёта
    total_flight_sec   bigint NOT NULL DEFAULT 0,
    total_flights      int NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz
);

-- ФТ-3.6
CREATE TABLE aircraft_status_history (
    id           uuid PRIMARY KEY,
    aircraft_id  uuid NOT NULL REFERENCES aircraft(id),
    status_from  text,
    status_to    text NOT NULL,
    reason       text,
    changed_by   uuid NOT NULL REFERENCES users(id),
    changed_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. ЧЕКЛИСТЫ  (ФТ-4)
-- ============================================================
-- Ключевое решение: СЕКЦИИ И ПУНКТЫ ПРИНАДЛЕЖАТ ВЕРСИИ, а не чеклисту.
-- Иначе правка пункта задним числом меняет историю прохождений — прямой запрет ФТ-4.10.

CREATE TABLE checklists (
    id          uuid PRIMARY KEY,
    company_id  uuid NOT NULL REFERENCES companies(id),
    scope       text NOT NULL CHECK (scope IN ('model_template','aircraft')),
    model_id    uuid REFERENCES aircraft_models(id),   -- для scope='model_template' (ФТ-4.2)
    aircraft_id uuid REFERENCES aircraft(id),          -- для scope='aircraft'   (ФТ-4.1)
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'model_template') = (model_id IS NOT NULL)),
    CHECK ((scope = 'aircraft')       = (aircraft_id IS NOT NULL))
);
CREATE UNIQUE INDEX ON checklists (aircraft_id) WHERE scope = 'aircraft';

-- ФТ-4.10, ФТ-4.11; НФТ-2.4 — версии не удаляются никогда
CREATE TABLE checklist_versions (
    id            uuid PRIMARY KEY,
    checklist_id  uuid NOT NULL REFERENCES checklists(id),
    version_no    int NOT NULL,
    derived_from  uuid REFERENCES checklist_versions(id),  -- ФТ-4.3: наследование от шаблона модели
    is_current    boolean NOT NULL DEFAULT false,
    created_by    uuid NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (checklist_id, version_no)
);
CREATE UNIQUE INDEX ON checklist_versions (checklist_id) WHERE is_current;

-- ФТ-4.5
CREATE TABLE checklist_sections (
    id          uuid PRIMARY KEY,
    version_id  uuid NOT NULL REFERENCES checklist_versions(id),
    title       text NOT NULL,
    sort_order  int NOT NULL
);

-- ФТ-4.6 … ФТ-4.9
CREATE TABLE checklist_items (
    id            uuid PRIMARY KEY,
    version_id    uuid NOT NULL REFERENCES checklist_versions(id),
    section_id    uuid NOT NULL REFERENCES checklist_sections(id),
    sort_order    int NOT NULL,
    title         text NOT NULL,
    item_type     text NOT NULL CHECK (item_type IN
                  ('bool','number','choice','text','photo','signature')),
    level         text NOT NULL DEFAULT 'informational'   -- ФТ-4.7
                  CHECK (level IN ('critical','significant','informational')),
    is_expected   boolean NOT NULL DEFAULT true,          -- ФТ-4.8
    num_min       numeric,
    num_max       numeric,
    num_unit      text,
    options       jsonb,                                  -- для item_type='choice'
    hint_text     text,                                   -- ФТ-4.9
    hint_file_id  uuid REFERENCES files(id)
);
CREATE INDEX ON checklist_items (version_id, sort_order);

-- ============================================================
-- 5. ПЛОЩАДКИ И ПЛАНЫ  (ФТ-5, ФТ-7)
-- ============================================================

-- ФТ-5.5
CREATE TABLE sites (
    id           uuid PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    name         text NOT NULL,
    lat          double precision NOT NULL,
    lon          double precision NOT NULL,
    radius_m     int,
    boundary     jsonb,              -- GeoJSON; при переходе на PostGIS — geography(Polygon)
    approach     text,
    notes        text,
    contacts     text,
    deleted_at   timestamptz
);

-- ФТ-5.1, ФТ-5.2, ФТ-5.7
CREATE TABLE flight_plans (
    id                  uuid PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES companies(id),
    aircraft_id         uuid NOT NULL REFERENCES aircraft(id),
    pilot_id            uuid NOT NULL REFERENCES users(id),
    site_id             uuid REFERENCES sites(id),
    lat                 double precision,           -- ФТ-5.4: координаты вместо площадки
    lon                 double precision,
    planned_start       timestamptz NOT NULL,
    planned_duration_min int,
    max_alt_m           int,
    task                text,
    -- ФТ-5.2: версия чеклиста фиксируется в момент создания плана и больше не меняется
    checklist_version_id uuid NOT NULL REFERENCES checklist_versions(id),
    status              text NOT NULL DEFAULT 'draft' CHECK (status IN
                        ('draft','planned','prepared','in_progress','completed','cancelled')),
    permit_id           uuid,                        -- ФТ-5.6, Фаза 3
    sppi_plan_id        uuid,                        -- ФТ-5.6, Фаза 3
    created_by          uuid NOT NULL REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    device_time         timestamptz,
    server_received_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (site_id IS NOT NULL OR (lat IS NOT NULL AND lon IS NOT NULL))
);
-- П-13: пересечение по борту и по пилоту (ФТ-5.8) — проверяется запросом по этому индексу
CREATE INDEX ON flight_plans (aircraft_id, planned_start);
CREATE INDEX ON flight_plans (pilot_id, planned_start);

-- ФТ-7.11, ФТ-7.12
CREATE TABLE plan_templates (
    id          uuid PRIMARY KEY,
    company_id  uuid NOT NULL REFERENCES companies(id),
    owner_id    uuid NOT NULL REFERENCES users(id),
    is_shared   boolean NOT NULL DEFAULT false,
    name        text NOT NULL,
    payload     jsonb NOT NULL     -- площадка, задача, экипаж, набор АКБ
);

-- ФТ-7.5, ФТ-7.10: кэш погоды, тянется при подготовке к выезду
CREATE TABLE weather_snapshots (
    id            uuid PRIMARY KEY,
    company_id    uuid NOT NULL REFERENCES companies(id),
    plan_id       uuid REFERENCES flight_plans(id),
    lat           double precision NOT NULL,
    lon           double precision NOT NULL,
    valid_for     timestamptz NOT NULL,
    fetched_at    timestamptz NOT NULL,   -- отметка давности данных
    source        text,
    data          jsonb NOT NULL          -- температура, ветер, порывы, давление, видимость, осадки
);

-- ============================================================
-- 6. ПРОХОЖДЕНИЕ ЧЕКЛИСТА  (ФТ-6)
-- ============================================================
-- checklist_runs и checklist_run_answers после подписания неизменяемы (ФТ-6.9, НФТ-2.1).
-- Защищать триггером, а не только кодом приложения.

CREATE TABLE checklist_runs (
    id                 uuid PRIMARY KEY,
    company_id         uuid NOT NULL REFERENCES companies(id),
    plan_id            uuid NOT NULL REFERENCES flight_plans(id),
    checklist_version_id uuid NOT NULL REFERENCES checklist_versions(id),
    pilot_id           uuid NOT NULL REFERENCES users(id),
    started_at         timestamptz NOT NULL,
    signed_at          timestamptz,                 -- ФТ-6.8; NULL = в работе
    duration_sec       int,                         -- ФТ-6.13
    lat                double precision,            -- ФТ-7.2
    lon                double precision,
    detected_site_id   uuid REFERENCES sites(id),   -- ФТ-7.3
    signature_name     text,                        -- ФИО на момент подписания
    voided_at          timestamptz,                 -- ФТ-6.9: аннулировано новым прохождением
    voided_reason      text,
    superseded_by      uuid REFERENCES checklist_runs(id),
    device_time        timestamptz,
    server_received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON checklist_runs (plan_id);

CREATE TABLE checklist_run_answers (
    id            uuid PRIMARY KEY,
    run_id        uuid NOT NULL REFERENCES checklist_runs(id),
    item_id       uuid NOT NULL REFERENCES checklist_items(id),
    value         jsonb,                    -- NULL = пункт не заполнен → П-08
    is_negative   boolean NOT NULL DEFAULT false,   -- отрицательный результат → П-07
    out_of_range  boolean NOT NULL DEFAULT false,   -- ФТ-6.5
    comment       text,
    fill_source   text NOT NULL DEFAULT 'manual'    -- ФТ-7.9
                  CHECK (fill_source IN ('manual','auto')),
    was_edited    boolean NOT NULL DEFAULT false,
    answered_at   timestamptz,
    UNIQUE (run_id, item_id)
);

-- ============================================================
-- 7. ПРЕДУПРЕЖДЕНИЯ И ПРИНЯТИЕ ОТВЕТСТВЕННОСТИ  (ФТ-9)
-- ============================================================
-- Предупреждения вычисляются на клиенте и приезжают уже готовыми.
-- Сервер их не пересчитывает — он обязан сохранить формулировки в том виде,
-- в каком их видел пилот (ФТ-9.5, НФТ-2.2).

CREATE TABLE responsibility_acceptances (
    id                 uuid PRIMARY KEY,
    company_id         uuid NOT NULL REFERENCES companies(id),
    plan_id            uuid NOT NULL REFERENCES flight_plans(id),
    run_id             uuid REFERENCES checklist_runs(id),
    pilot_id           uuid NOT NULL REFERENCES users(id),
    pilot_name         text NOT NULL,               -- ФИО снимком
    accepted_at        timestamptz NOT NULL,
    lat                double precision,
    lon                double precision,
    checklist_version_id uuid NOT NULL REFERENCES checklist_versions(id),
    rules_version      text NOT NULL,               -- ФТ-9.5: версия правил
    device_time        timestamptz,
    server_received_at timestamptz NOT NULL DEFAULT now()
);

-- ФТ-9.7: каждое предупреждение принимается отдельной записью
CREATE TABLE acceptance_warnings (
    id             uuid PRIMARY KEY,
    acceptance_id  uuid NOT NULL REFERENCES responsibility_acceptances(id),
    code           text NOT NULL,                   -- П-01 … П-13
    level          text NOT NULL CHECK (level IN ('critical','significant','informational')),
    text_snapshot  text NOT NULL,                   -- НФТ-2.2: формулировка на момент принятия
    context        jsonb,                           -- что именно сработало
    comment        text,                            -- ФТ-9.6
    accepted_at    timestamptz NOT NULL
);
CREATE INDEX ON acceptance_warnings (code, level);

-- ФТ-9.12 (Фаза 2): компания настраивает уровень или отключает проверку
CREATE TABLE warning_rule_config (
    company_id  uuid NOT NULL REFERENCES companies(id),
    code        text NOT NULL,
    level       text NOT NULL CHECK (level IN ('critical','significant','informational')),
    enabled     boolean NOT NULL DEFAULT true,
    PRIMARY KEY (company_id, code)
);

-- ============================================================
-- 8. ЖУРНАЛ ПОЛЁТОВ  (ФТ-10)
-- ============================================================

CREATE TABLE flights (
    id                 uuid PRIMARY KEY,
    company_id         uuid NOT NULL REFERENCES companies(id),
    plan_id            uuid REFERENCES flight_plans(id),
    aircraft_id        uuid NOT NULL REFERENCES aircraft(id),
    pilot_id           uuid NOT NULL REFERENCES users(id),
    site_id            uuid REFERENCES sites(id),
    lat                double precision,
    lon                double precision,
    takeoff_at         timestamptz NOT NULL,
    landing_at         timestamptz,
    duration_sec       int GENERATED ALWAYS AS
                       (EXTRACT(EPOCH FROM (landing_at - takeoff_at))::int) STORED,  -- ФТ-10.3
    max_alt_m          int,
    flight_kind        text CHECK (flight_kind IN ('vlos','bvlos')),   -- ФТ-10.5
    task               text,
    has_incident       boolean NOT NULL DEFAULT false,                 -- ФТ-10.6
    incident_note      text,
    run_id             uuid REFERENCES checklist_runs(id),             -- ФТ-10.7
    acceptance_id      uuid REFERENCES responsibility_acceptances(id),
    warnings_snapshot  jsonb,                                          -- ФТ-10.8
    closed_at          timestamptz,                                    -- ФТ-10.9: триггер наработки
    created_by         uuid NOT NULL REFERENCES users(id),
    device_time        timestamptz,
    server_received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON flights (company_id, takeoff_at DESC);
CREATE INDEX ON flights (aircraft_id, takeoff_at DESC);
CREATE INDEX ON flights (pilot_id, takeoff_at DESC);
-- ФТ-15.2: тепловая карта по дням за год строится группировкой по индексу выше.
-- Индекс по (takeoff_at::date) создать нельзя: приведение timestamptz к date зависит
-- от TimeZone сессии и не IMMUTABLE. День полёта считается в часовом поясе компании
-- (ФТ-1.8) — приводить надо явно: (takeoff_at AT TIME ZONE c.timezone)::date.

-- ФТ-10.10: журнал только дополняется, исправление — отдельной записью
CREATE TABLE flight_corrections (
    id           uuid PRIMARY KEY,
    flight_id    uuid NOT NULL REFERENCES flights(id),
    reason       text NOT NULL,
    changes      jsonb NOT NULL,
    author_id    uuid NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 9. ДЕФЕКТЫ  (ФТ-13, MVP)
-- ============================================================

CREATE TABLE defects (
    id            uuid PRIMARY KEY,
    company_id    uuid NOT NULL REFERENCES companies(id),
    aircraft_id   uuid NOT NULL REFERENCES aircraft(id),
    component_id  uuid,                                     -- ФТ-13.3, Фаза 2
    level         text NOT NULL CHECK (level IN ('critical','significant','informational')),
    status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','fixed','closed')),
    description   text NOT NULL,
    -- ФТ-13.1: источник — пункт чеклиста, полёт или ручное создание
    source_answer_id uuid REFERENCES checklist_run_answers(id),
    source_flight_id uuid REFERENCES flights(id),
    found_by      uuid NOT NULL REFERENCES users(id),
    found_at      timestamptz NOT NULL,
    closed_by     uuid REFERENCES users(id),                -- ФТ-13.6: только техник/админ
    closed_at     timestamptz,
    device_time   timestamptz,
    server_received_at timestamptz NOT NULL DEFAULT now()
);
-- ФТ-13.7, П-03: открытые дефекты борта перед подготовкой
CREATE INDEX ON defects (aircraft_id, status) WHERE status <> 'closed';

-- ФТ-6.4: отказ от создания дефекта тоже фиксируется
CREATE TABLE defect_declines (
    answer_id  uuid PRIMARY KEY REFERENCES checklist_run_answers(id),
    declined_by uuid NOT NULL REFERENCES users(id),
    declined_at timestamptz NOT NULL
);

-- ============================================================
-- 10. АККУМУЛЯТОРЫ  (ФТ-11, Фаза 2)
-- ============================================================

CREATE TABLE batteries (
    id             uuid PRIMARY KEY,
    company_id     uuid NOT NULL REFERENCES companies(id),
    serial_number  text NOT NULL,
    chemistry      text,
    capacity_mah   int,
    cells          int,
    manufactured   date,
    in_service_at  date,
    cycle_count    int NOT NULL DEFAULT 0,          -- ФТ-11.2
    cycle_limit    int,                             -- ФТ-11.3
    status         text NOT NULL DEFAULT 'active'   -- ФТ-11.4 → П-10
                   CHECK (status IN ('active','storage','testing','retired')),
    last_used_at   timestamptz,                     -- ФТ-11.6: контроль хранения
    deleted_at     timestamptz
);

CREATE TABLE battery_measurements (        -- ФТ-11.5
    id            uuid PRIMARY KEY,
    battery_id    uuid NOT NULL REFERENCES batteries(id),
    measured_at   timestamptz NOT NULL,
    cell_voltages numeric(4,3)[],
    imbalance_mv  int,
    resistance_mohm numeric(6,2),
    capacity_mah  int,
    note          text,
    measured_by   uuid REFERENCES users(id)
);

CREATE TABLE flight_plan_batteries (       -- ФТ-7.4
    plan_id     uuid NOT NULL REFERENCES flight_plans(id),
    battery_id  uuid NOT NULL REFERENCES batteries(id),
    PRIMARY KEY (plan_id, battery_id)
);

CREATE TABLE flight_batteries (            -- ФТ-10.4, ФТ-11.8
    flight_id   uuid NOT NULL REFERENCES flights(id),
    battery_id  uuid NOT NULL REFERENCES batteries(id),
    PRIMARY KEY (flight_id, battery_id)
);

-- ============================================================
-- 11. КОМПОНЕНТЫ И ТО  (ФТ-12, Фаза 2)
-- ============================================================

CREATE TABLE components (
    id             uuid PRIMARY KEY,
    company_id     uuid NOT NULL REFERENCES companies(id),
    kind           text NOT NULL,          -- планер, мотор, пропеллер, регулятор, подвес, ПН
    serial_number  text,
    -- ФТ-12.2: наработка компонента живёт отдельно и не обнуляется при переустановке
    total_hours    numeric(10,2) NOT NULL DEFAULT 0,
    total_cycles   int NOT NULL DEFAULT 0,
    life_hours     numeric(10,2),          -- ФТ-12.3
    life_cycles    int,
    deleted_at     timestamptz
);

CREATE TABLE component_installations (     -- ФТ-12.7
    id            uuid PRIMARY KEY,
    component_id  uuid NOT NULL REFERENCES components(id),
    aircraft_id   uuid NOT NULL REFERENCES aircraft(id),
    installed_at  timestamptz NOT NULL,
    removed_at    timestamptz,
    performed_by  uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX ON component_installations (component_id) WHERE removed_at IS NULL;

CREATE TABLE maintenance_schedules (       -- ФТ-12.4 → П-04
    id            uuid PRIMARY KEY,
    company_id    uuid NOT NULL REFERENCES companies(id),
    aircraft_id   uuid REFERENCES aircraft(id),
    component_id  uuid REFERENCES components(id),
    title         text NOT NULL,
    interval_hours numeric(10,2),
    interval_days int,
    next_due_at   timestamptz,
    next_due_hours numeric(10,2),
    CHECK (num_nonnulls(aircraft_id, component_id) = 1)
);

CREATE TABLE maintenance_records (         -- ФТ-12.5
    id            uuid PRIMARY KEY,
    schedule_id   uuid REFERENCES maintenance_schedules(id),
    aircraft_id   uuid REFERENCES aircraft(id),
    component_id  uuid REFERENCES components(id),
    work_type     text NOT NULL,
    performed_at  timestamptz NOT NULL,
    performed_by  uuid NOT NULL REFERENCES users(id),
    parts_replaced text,
    verified_by   uuid REFERENCES users(id),
    note          text
);

-- ============================================================
-- 12. РЕГУЛЯТОРНАЯ ЧАСТЬ  (ФТ-14, Фаза 3)
-- ============================================================

CREATE TABLE airspace_permits (            -- ФТ-14.3 → П-09
    id           uuid PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    number       text NOT NULL,
    issued_by    text,
    area         jsonb,                    -- GeoJSON района
    alt_min_m    int,
    alt_max_m    int,
    valid_from   date,
    valid_until  date,
    file_id      uuid REFERENCES files(id)
);

CREATE TABLE sppi_plans (                  -- ФТ-14.4
    id           uuid PRIMARY KEY,
    company_id   uuid NOT NULL REFERENCES companies(id),
    plan_id      uuid REFERENCES flight_plans(id),
    number       text NOT NULL,
    submitted_at timestamptz,
    status       text,
    valid_until  timestamptz
);

CREATE TABLE restricted_zones (            -- ФТ-14.7
    id          uuid PRIMARY KEY,
    company_id  uuid NOT NULL REFERENCES companies(id),
    name        text NOT NULL,
    area        jsonb NOT NULL,
    alt_max_m   int,
    note        text,
    valid_until date
);

-- Отложенные внешние ключи, объявленные выше по тексту
ALTER TABLE documents   ADD FOREIGN KEY (owner_aircraft_id) REFERENCES aircraft(id);
ALTER TABLE documents   ADD FOREIGN KEY (owner_plan_id)     REFERENCES flight_plans(id);
ALTER TABLE attachments ADD FOREIGN KEY (answer_id)  REFERENCES checklist_run_answers(id);
ALTER TABLE attachments ADD FOREIGN KEY (defect_id)  REFERENCES defects(id);
ALTER TABLE attachments ADD FOREIGN KEY (flight_id)  REFERENCES flights(id);
ALTER TABLE attachments ADD FOREIGN KEY (aircraft_id) REFERENCES aircraft(id);
ALTER TABLE defects     ADD FOREIGN KEY (component_id) REFERENCES components(id);
ALTER TABLE flight_plans ADD FOREIGN KEY (permit_id)    REFERENCES airspace_permits(id);
ALTER TABLE flight_plans ADD FOREIGN KEY (sppi_plan_id) REFERENCES sppi_plans(id);
