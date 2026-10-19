# Référence d'API déduite — http://localhost:3456

Déduite du trafic observé pendant l'exploration (aucun accès au code ni à une documentation). Les ids sont remplacés par `:id` ; « optionnel » = champ absent d'au moins une réponse observée.

| Méthode | Route | Statuts | Appels |
|---|---|---|---|
| PATCH | `/api/v2/filters/:id` | 200 | 3 |
| GET | `/api/v2/info` | 200 | 88 |
| GET | `/api/v2/labels` | 200 | 88 |
| GET | `/api/v2/notifications` | 200 | 88 |
| GET | `/api/v2/projects` | 200 | 91 |
| GET | `/api/v2/projects/:id` | 200 | 18 |
| PATCH | `/api/v2/projects/:id` | 200 | 8 |
| POST | `/api/v2/projects/:id/tasks/bulk` | 201 | 2 |
| GET | `/api/v2/projects/:id/views/:id/buckets` | 200 | 2 |
| GET | `/api/v2/projects/:id/views/:id/buckets/tasks` | 200 | 1 |
| GET | `/api/v2/projects/:id/views/:id/tasks` | 200 | 21 |
| GET | `/api/v2/tasks` | 200 | 160 |
| DELETE | `/api/v2/tasks/:id` | 204 | 1 |
| GET | `/api/v2/tasks/:id` | 200 | 2 |
| PATCH | `/api/v2/tasks/:id` | 200 | 2 |
| GET | `/api/v2/tasks/:id/comments` | 200 | 2 |
| POST | `/api/v2/tasks/:id/labels` | 201 | 1 |
| GET | `/api/v2/teams` | 200 | 3 |
| GET | `/api/v2/user` | 200 | 88 |
| GET | `/api/v2/user/timezones` | 200 | 2 |
| POST | `/api/v2/user/token/refresh` | 200 | 172 |

### `PATCH /api/v2/filters/:id`

Statuts observés : 200 (×3)

**Corps envoyé** (format `json-patch`, converti en champs) :
- `is_favorite`: boolean

**Réponse** (`object`) :
- `id`: integer
- `filters`: object
  - `s`: string
  - `sort_by`: null
  - `order_by`: null
  - `filter`: string
  - `filter_include_nulls`: boolean
- `title`: string
- `description`: string
- `owner`: object
  - `id`: integer
  - `name`: string
  - `username`: string
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `is_favorite`: boolean
- `created`: string (date-time)
- `updated`: string (date-time)

---

### `GET /api/v2/info`

Statuts observés : 200 (×88)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `version`: string
- `frontend_url`: string (uri)
- `motd`: string
- `link_sharing_enabled`: boolean
- `max_file_size`: string
- `max_items_per_page`: integer
- `available_migrators`: array of string
- `task_attachments_enabled`: boolean
- `enabled_background_providers`: array of string
- `totp_enabled`: boolean
- `legal`: object
  - `imprint_url`: string
  - `privacy_policy_url`: string
- `caldav_enabled`: boolean
- `auth`: object
  - `local`: object
    - `enabled`: boolean
    - `registration_enabled`: boolean
  - `ldap`: object
    - `enabled`: boolean
  - `openid_connect`: object
    - `enabled`: boolean
    - `providers`: null
- `email_reminders_enabled`: boolean
- `user_deletion_enabled`: boolean
- `task_comments_enabled`: boolean
- `demo_mode_enabled`: boolean
- `webhooks_enabled`: boolean
- `public_teams_enabled`: boolean
- `allow_icon_changes`: boolean
- `enabled_pro_features`: array (toujours vide dans le trafic observé)
- `concurrent_writes`: boolean

---

### `GET /api/v2/labels`

Statuts observés : 200 (×88)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array of object
  - `id`: integer
  - `title`: string (enum: "bug", "feature", "urgent")
  - `description`: string
  - `hex_color`: string
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `GET /api/v2/notifications`

Statuts observés : 200 (×88)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array (toujours vide dans le trafic observé)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `GET /api/v2/projects`

Statuts observés : 200 (×91)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array of object
  - `id`: integer
  - `title`: string
  - `description`: string
  - `identifier`: string
  - `hex_color`: string
  - `parent_project_id`: integer
  - `owner`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
  - `is_archived`: boolean
  - `background_information`: null
  - `background_blur_hash`: string
  - `is_favorite`: boolean
  - `position`: integer
  - `views`: array | null of object
    - `id`: integer
    - `title`: string (enum: "Gantt", "Kanban", "List", "Table")
    - `project_id`: integer
    - `view_kind`: string (enum: "gantt", "kanban", "list", "table")
    - `filter`: object | null
    - `position`: integer
    - `bucket_configuration_mode`: string (enum: "manual", "none")
    - `bucket_configuration`: null
    - `default_bucket_id`: integer
    - `done_bucket_id`: integer
    - `updated`: string (date-time)
    - `created`: string (date-time)
  - `max_permission`: integer
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `GET /api/v2/projects/:id`

Statuts observés : 200 (×18)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `id`: integer
- `title`: string
- `description`: string
- `identifier`: string
- `hex_color`: string
- `parent_project_id`: integer
- `owner`: object
  - `id`: integer
  - `name`: string
  - `username`: string
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `is_archived`: boolean
- `background_information`: null
- `background_blur_hash`: string
- `is_favorite`: boolean
- `position`: integer
- `views`: array of object
  - `id`: integer
  - `title`: string (enum: "Gantt", "Kanban", "List", "Table")
  - `project_id`: integer
  - `view_kind`: string (enum: "gantt", "kanban", "list", "table")
  - `filter`: null | object
    - `s`: string
    - `sort_by`: null
    - `order_by`: null
    - `filter`: string
    - `filter_include_nulls`: boolean
  - `position`: integer
  - `bucket_configuration_mode`: string (enum: "manual", "none")
  - `bucket_configuration`: null
  - `default_bucket_id`: integer
  - `done_bucket_id`: integer
  - `updated`: string (date-time)
  - `created`: string (date-time)
- `max_permission`: integer
- `created`: string (date-time)
- `updated`: string (date-time)

---

### `PATCH /api/v2/projects/:id`

Statuts observés : 200 (×8)

**Corps envoyé** (format `json-patch`, converti en champs) :
- `is_favorite`: boolean

**Réponse** (`object`) :
- `id`: integer
- `title`: string
- `description`: string
- `identifier`: string
- `hex_color`: string
- `parent_project_id`: integer
- `owner`: object
  - `id`: integer
  - `name`: string
  - `username`: string
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `is_archived`: boolean
- `background_information`: null
- `background_blur_hash`: string
- `is_favorite`: boolean
- `position`: integer
- `views`: array of object
  - `id`: integer
  - `title`: string (enum: "Gantt", "Kanban", "List", "Table")
  - `project_id`: integer
  - `view_kind`: string (enum: "gantt", "kanban", "list", "table")
  - `filter`: object | null
    - `s`: string
    - `sort_by`: null
    - `order_by`: null
    - `filter`: string
    - `filter_include_nulls`: boolean
  - `position`: integer
  - `bucket_configuration_mode`: string (enum: "manual", "none")
  - `bucket_configuration`: null
  - `default_bucket_id`: integer
  - `done_bucket_id`: integer
  - `updated`: string (date-time)
  - `created`: string (date-time)
- `max_permission`: null
- `created`: string (date-time)
- `updated`: string (date-time)

---

### `POST /api/v2/projects/:id/tasks/bulk`

Statuts observés : 201 (×2)

**Corps envoyé** :
- `tasks`: array of object
  - `title`: string
  - `description`: string
  - `done`: boolean
  - `priority`: integer
  - `hex_color`: string
  - `percent_done`: integer
  - `repeat_after`: integer
  - `repeat_mode`: integer
  - `is_favorite`: boolean
  - `bucket_id`: integer
  - `project_id`: integer
  - `reminders`: array (toujours vide dans le trafic observé)
  - `cover_image_attachment_id`: integer

**Réponse** (`object`) :
- `tasks`: array of object
  - `id`: integer
  - `title`: string
  - `description`: string
  - `project_id`: integer
  - `done`: boolean
  - `done_at`: string (date-time)
  - `due_date`: string (date-time)
  - `reminders`: null
  - `repeat_after`: integer
  - `repeat_mode`: integer
  - `priority`: integer
  - `start_date`: string (date-time)
  - `end_date`: string (date-time)
  - `assignees`: array (toujours vide dans le trafic observé)
  - `labels`: null
  - `hex_color`: string
  - `percent_done`: integer
  - `identifier`: string
  - `index`: integer
  - `related_tasks`: null
  - `attachments`: null
  - `cover_image_attachment_id`: integer
  - `is_favorite`: boolean
  - `created`: string (date-time)
  - `updated`: string (date-time)
  - `bucket_id`: integer
  - `position`: integer
  - `reactions`: null
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)

---

### `GET /api/v2/projects/:id/views/:id/buckets`

Statuts observés : 200 (×2)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array of object
  - `id`: integer
  - `title`: string
  - `project_view_id`: integer
  - `limit`: integer
  - `count`: integer
  - `position`: integer
  - `created`: string (date-time)
  - `updated`: string (date-time)
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `GET /api/v2/projects/:id/views/:id/buckets/tasks`

Statuts observés : 200 (×1)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array of object
  - `id`: integer
  - `title`: string
  - `project_view_id`: integer
  - `tasks`: array of object (optionnel)
    - `id`: integer
    - `title`: string
    - `description`: string
    - `project_id`: integer
    - `done`: boolean
    - `done_at`: string (date-time)
    - `due_date`: string (date-time)
    - `reminders`: null
    - `repeat_after`: integer
    - `repeat_mode`: integer
    - `priority`: integer
    - `start_date`: string (date-time)
    - `end_date`: string (date-time)
    - `assignees`: null
    - `labels`: null | array of object
    - `hex_color`: string
    - `percent_done`: integer
    - `identifier`: string
    - `index`: integer
    - `related_tasks`: object
    - `attachments`: null
    - `cover_image_attachment_id`: integer
    - `is_favorite`: boolean
    - `created`: string (date-time)
    - `updated`: string (date-time)
    - `bucket_id`: integer
    - `comment_count`: integer
    - `position`: integer
    - `reactions`: null
    - `created_by`: object
  - `limit`: integer
  - `count`: integer
  - `position`: integer
  - `created`: string (date-time)
  - `updated`: string (date-time)
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
- `total`: integer

---

### `GET /api/v2/projects/:id/views/:id/tasks`

Statuts observés : 200 (×21)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array of object
  - `id`: integer
  - `title`: string
  - `description`: string
  - `project_id`: integer
  - `done`: boolean
  - `done_at`: string (date-time)
  - `due_date`: string (date-time)
  - `reminders`: null
  - `repeat_after`: integer
  - `repeat_mode`: integer
  - `priority`: integer
  - `start_date`: string (date-time)
  - `end_date`: string (date-time)
  - `assignees`: null
  - `labels`: null | array of object
    - `id`: integer
    - `title`: string (enum: "bug", "feature", "urgent")
    - `description`: string
    - `hex_color`: string
    - `created_by`: object
    - `created`: string (date-time)
    - `updated`: string (date-time)
  - `hex_color`: string
  - `percent_done`: integer
  - `identifier`: string
  - `index`: integer
  - `related_tasks`: object
  - `attachments`: null
  - `cover_image_attachment_id`: integer
  - `is_favorite`: boolean
  - `created`: string (date-time)
  - `updated`: string (date-time)
  - `bucket_id`: integer
  - `comment_count`: integer
  - `position`: integer
  - `reactions`: null
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `GET /api/v2/tasks`

Statuts observés : 200 (×160)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array of object
  - `id`: integer
  - `title`: string
  - `description`: string
  - `project_id`: integer
  - `done`: boolean
  - `done_at`: string (date-time)
  - `due_date`: string (date-time)
  - `reminders`: null
  - `repeat_after`: integer
  - `repeat_mode`: integer
  - `priority`: integer
  - `start_date`: string (date-time)
  - `end_date`: string (date-time)
  - `assignees`: null
  - `labels`: array | null of object
    - `id`: integer
    - `title`: string (enum: "bug", "feature", "urgent")
    - `description`: string
    - `hex_color`: string
    - `created_by`: object
    - `created`: string (date-time)
    - `updated`: string (date-time)
  - `hex_color`: string
  - `percent_done`: integer
  - `identifier`: string
  - `index`: integer
  - `related_tasks`: object
  - `attachments`: null
  - `cover_image_attachment_id`: integer
  - `is_favorite`: boolean
  - `created`: string (date-time)
  - `updated`: string (date-time)
  - `bucket_id`: integer
  - `comment_count`: integer (optionnel)
  - `position`: integer
  - `reactions`: null
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `DELETE /api/v2/tasks/:id`

Statuts observés : 204 (×1)

**Corps envoyé** :
_aucun_

**Réponse** :
_non JSON ou vide_

---

### `GET /api/v2/tasks/:id`

Statuts observés : 200 (×2)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `id`: integer
- `title`: string
- `description`: string
- `project_id`: integer
- `done`: boolean
- `done_at`: string (date-time)
- `due_date`: string (date-time)
- `reminders`: null
- `repeat_after`: integer
- `repeat_mode`: integer
- `priority`: integer
- `start_date`: string (date-time)
- `end_date`: string (date-time)
- `assignees`: null
- `labels`: array of object
  - `id`: integer
  - `title`: string
  - `description`: string
  - `hex_color`: string
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `hex_color`: string
- `percent_done`: integer
- `identifier`: string
- `index`: integer
- `related_tasks`: object
- `attachments`: null
- `cover_image_attachment_id`: integer
- `is_favorite`: boolean
- `subscription`: object
  - `id`: integer
  - `entity`: string
  - `entity_id`: integer
  - `created`: string (date-time)
- `created`: string (date-time)
- `updated`: string (date-time)
- `bucket_id`: integer
- `buckets`: array of object
  - `id`: integer
  - `title`: string
  - `project_view_id`: integer
  - `limit`: integer
  - `count`: integer
  - `position`: integer
  - `created`: string (date-time)
  - `updated`: string (date-time)
  - `created_by`: null
- `position`: integer
- `reactions`: null
- `created_by`: object
  - `id`: integer
  - `name`: string
  - `username`: string
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `max_permission`: integer

---

### `PATCH /api/v2/tasks/:id`

Statuts observés : 200 (×2)

**Corps envoyé** (format `json-patch`, converti en champs) :
- `title`: string
- `description`: string
- `done`: boolean
- `due_date`: string (date-time)
- `start_date`: string (date-time)
- `end_date`: string (date-time)
- `priority`: integer
- `hex_color`: string
- `percent_done`: integer
- `repeat_after`: integer
- `repeat_mode`: integer
- `is_favorite`: boolean
- `bucket_id`: integer
- `project_id`: integer
- `reminders`: array (toujours vide dans le trafic observé)
- `cover_image_attachment_id`: integer

**Réponse** (`object`) :
- `id`: integer
- `title`: string
- `description`: string
- `project_id`: integer
- `done`: boolean
- `done_at`: string (date-time)
- `due_date`: string (date-time)
- `reminders`: null
- `repeat_after`: integer
- `repeat_mode`: integer
- `priority`: integer
- `start_date`: string (date-time)
- `end_date`: string (date-time)
- `assignees`: array (toujours vide dans le trafic observé)
- `labels`: array of object
  - `id`: integer
  - `title`: string
  - `description`: string
  - `hex_color`: string
  - `created_by`: object
    - `id`: integer
    - `name`: string
    - `username`: string
    - `created`: string (date-time)
    - `updated`: string (date-time)
  - `created`: string (date-time)
  - `updated`: string (date-time)
- `hex_color`: string
- `percent_done`: integer
- `identifier`: string
- `index`: integer
- `related_tasks`: object
- `attachments`: null
- `cover_image_attachment_id`: integer
- `is_favorite`: boolean
- `subscription`: object
  - `id`: integer
  - `entity`: string
  - `entity_id`: integer
  - `created`: string (date-time)
- `created`: string (date-time)
- `updated`: string (date-time)
- `bucket_id`: integer
- `position`: integer
- `reactions`: null
- `created_by`: object
  - `id`: integer
  - `name`: string
  - `username`: string
  - `created`: string (date-time)
  - `updated`: string (date-time)

---

### `GET /api/v2/tasks/:id/comments`

Statuts observés : 200 (×2)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array (toujours vide dans le trafic observé)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `POST /api/v2/tasks/:id/labels`

Statuts observés : 201 (×1)

**Corps envoyé** :
- `label_id`: integer

**Réponse** (`object`) :
- `label_id`: integer
- `created`: string (date-time)

---

### `GET /api/v2/teams`

Statuts observés : 200 (×3)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `items`: array (toujours vide dans le trafic observé)
- `total`: integer
- `page`: integer
- `per_page`: integer
- `total_pages`: integer

---

### `GET /api/v2/user`

Statuts observés : 200 (×88)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `id`: integer
- `name`: string
- `username`: string
- `created`: string (date-time)
- `updated`: string (date-time)
- `settings`: object
  - `name`: string
  - `email_reminders_enabled`: boolean
  - `discoverable_by_name`: boolean
  - `discoverable_by_email`: boolean
  - `overdue_tasks_reminders_enabled`: boolean
  - `overdue_tasks_reminders_time`: string
  - `default_project_id`: integer
  - `week_start`: integer
  - `language`: string
  - `timezone`: string
  - `frontend_settings`: null
  - `extra_settings_links`: null
- `deletion_scheduled_at`: string (date-time)
- `is_local_user`: boolean
- `auth_provider`: string
- `is_admin`: boolean

---

### `GET /api/v2/user/timezones`

Statuts observés : 200 (×2)

**Corps envoyé** :
_aucun_

**Réponse** (`array`) :
_non JSON ou vide_

---

### `POST /api/v2/user/token/refresh`

Statuts observés : 200 (×172)

**Corps envoyé** :
_aucun_

**Réponse** (`object`) :
- `token`: string
