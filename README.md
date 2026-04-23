# DocForge

Unified PDF generation & document drive platform. Go + Next.js.

## Status

**Week 1 MVP complete.** Vertical slice: signup → upload AcroForm PDF → auto-detected fields → map in designer → generate filled PDF → save/load JSON presets in playground.

**Week 2 in progress.**

**W2 Day 5** — HTML mode:
- `internal/generate/html/html.go` — placeholder extraction (regex), Go `html/template` substitution with built-in `upper`/`lower`/`formatDate` funcs, regex fallback on template errors so authors aren't blocked
- Chromium render via **chromedp** with local `ExecAllocator` (no-sandbox, headless); fresh `BrowserContext` per render + 30s timeout
- Detector routes `.html`/`.htm`/`.hbs`/`.mustache` uploads to `mode=html`; seeds `config_json.placeholders[]`
- Endpoints: `GET /v1/templates/{id}/source`, `PUT /v1/templates/{id}/source` (overwrites MinIO, re-extracts placeholders, bumps version)
- HTML designer (3-pane): placeholders panel + sample data | editor (plain textarea) | live client-side preview iframe
- Generate respects `async: true` (queue → Chromium in worker)

**Requires Chrome/Chromium locally** — installed on macOS by default (`/Applications/Google Chrome.app`). For Linux: `apt install chromium-browser`. The worker is the one that actually invokes it, so install on the worker host.

**W2 Day 4** — Folders, sharing, versions:
- `folders` (hierarchical) + `files.folder_id`; file list filterable by `?folder=`
- Cycle-safe folder move via recursive parent walk
- `share_links` table; tokens are URL-safe base64; optional expiry
- Public unauthenticated `GET /v1/public/shares/{token}` returns a pre-signed download URL
- Template versions: `GET /v1/templates/{id}/versions` (newest first), `POST /v1/templates/{id}/versions/{ver}/restore` (creates new version from prior snapshot)
- Drive UI: breadcrumbs, new folder, rename/delete, move file to folder, share modal with link list + copy + revoke
- Public `/share/{token}` page renders in an iframe
- `/templates/[id]/versions` page: three-column diff view (version list → side-by-side config JSON) with "Restore" action

**W2 Day 3** — Async generation + batch CSV:
- `generation_jobs` table (status, total, done, output_file_id)
- Asynq + Redis wired; dedicated `cmd/worker` binary consumes `generate:one` and `generate:batch` tasks
- Shared generation `Runner` extracted — sync handler and worker call the same code path
- `POST /v1/templates/{id}/generate` accepts `async: true` → enqueues → returns `{jobId, status:"queued"}`
- `GET /v1/jobs/{id}` for polling
- `POST /v1/templates/{id}/batch` (multipart `csv`) → worker loops rows, renders each, ZIPs all outputs, registers a single File row
- Frontend: async toggle in generate dialog + live job-status polling; **Batch CSV** button in both designers with progress (`rendering 17/100…`)

Run the worker: `cd api && go run ./cmd/worker`

**W2 Day 2** — Static PDF designer UI:
- `react-pdf` + `pdfjs-dist` wired (CDN worker)
- Coordinate helper `lib/pdf-coords.ts` — browser↔PDF space (Y-flip + scale)
- `components/static-designer.tsx` — palette | canvas | properties split
- Widgets: drag from palette onto page, move, resize (bottom-right handle), click-to-select, Del to remove
- Properties panel: data key, x/y/w/h (pt), font size, color, alignment
- Save → `PUT /v1/templates/{id}/widgets`; Generate dialog with auto-skeleton
- Designer route branches on `mode`: AcroForm = mapping table, Static = canvas

Run `cd web && npm install` to pull `react-pdf@7.7.3` + `pdfjs-dist@3.11.174`.

**W2 Day 1** — Static PDF backend:
- `template_widgets` table (widgets stored in PDF space: origin bottom-left, units=points)
- `internal/generate/static/static.go` — fpdf overlay engine + pdfcpu `AddWatermarksFile` stamp
- Detector routes flat PDFs (no AcroForm) to `mode=static`
- Widget types: text, multiline, date, number, currency, checkbox (image/qr pending)
- Endpoints: `GET /v1/templates/{id}/widgets`, `PUT /v1/templates/{id}/widgets` (atomic replace)
- `GET /v1/templates/{id}` now includes `widgets[]`
- `POST /v1/templates/{id}/generate` handles `mode=static` end-to-end

**Day 5** — Playground + polish:
- `mock_data_sets` table (unique by `template_id, name`)
- Endpoints: `GET/POST /v1/templates/{id}/mock-data`, `DELETE …/mock-data/{setId}`
- Playground page `/templates/[id]/playground` — side-by-side JSON editor + PDF preview iframe
- "Fill with fake data" heuristic (name/email/address/date/amount keyed by field name)
- Save/load/delete named presets
- Global toast provider; Drive, Designer, Playground all emit success/error toasts

**Day 1** — scaffold, docker-compose (Postgres/Redis/MinIO), Go+Chi+JWT auth, Next.js login/signup.

**Day 2** — File upload flow:
- MinIO client wrapper with pre-signed PUT/GET URLs
- `files` migration (org-scoped, soft-delete via `trashed_at`)
- Endpoints: `POST /v1/files/upload-url`, `POST /v1/files/{id}/complete`, `GET /v1/files`, `GET /v1/files/{id}`, `GET /v1/files/{id}/download`, `DELETE /v1/files/{id}`
- Drive UI: file list, upload widget (direct browser→MinIO), progress bar, download, trash
- MinIO CORS allows `http://localhost:3000` for direct browser uploads

**Day 4** — AcroForm generation engine:
- `internal/generate/acroform/fill.go` — `pdfcpu.FillForm` wrapper with data-key routing
- Type-aware bucketing (textfield / checkbox / radio / combobox / listbox / datefield)
- Transforms: `uppercase`, `lowercase`, `currency`, `date`
- Validation: missing-required + unknown-key errors with structured response
- `POST /v1/templates/{id}/generate` — sync generate; writes output to MinIO, registers an `active` file row, returns pre-signed download URL
- Designer "Generate" dialog: auto-skeleton JSON from mappings, flatten toggle, download-on-success
- `storage.PutBytes` helper added for writing outputs

**Day 3** — AcroForm detection + template designer:
- `templates`, `template_fields`, `template_versions` tables
- `pdfcpu` form field extractor (`internal/generate/acroform`)
- File upload `Complete` runs detector → if PDF has AcroForm fields, auto-creates a `Template` and field rows
- Endpoints: `GET /v1/templates/{id}`, `PUT /v1/templates/{id}/config`, `GET /v1/templates/{id}/preview-url`
- Designer page `/templates/[id]/designer`: PDF preview iframe + mapping table (data key, default, required, transform)
- Config saves bump `version` and snapshot into `template_versions`
- Drive row shows "Open designer" link for template-backed files; upload auto-navigates to designer on detection

## Setup

```bash
# 1. Start infra
cd infra && docker compose up -d

# 2. Start API (auto-applies all migrations on boot)
cd ../api
cp .env.example .env
go mod tidy
go run ./cmd/api    # :8080

# 3. Start worker (separate terminal — required for async + batch)
cd api
go run ./cmd/worker

# 4. Start web
cd ../web
cp .env.local.example .env.local
npm install
npm run dev         # :3000
```

### One-shot bootstrap (after cloning)

```bash
./scripts/bootstrap.sh     # starts docker, runs go mod tidy + npm install
```

## Smoke Test

1. Open http://localhost:3000 → redirects to `/login`
2. Click "Sign up" → create account
3. Lands on `/drive` with empty state
4. Sign out → redirects to `/login`

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` | no |
| POST | `/v1/auth/register` | no |
| POST | `/v1/auth/login` | no |
| GET | `/v1/me` | bearer |
| POST | `/v1/files/upload-url` | bearer |
| POST | `/v1/files/{id}/complete` | bearer |
| GET | `/v1/files` | bearer |
| GET | `/v1/files/{id}` | bearer |
| GET | `/v1/files/{id}/download` | bearer |
| DELETE | `/v1/files/{id}` | bearer |
| GET | `/v1/templates/{id}` | bearer |
| PUT | `/v1/templates/{id}/config` | bearer |
| GET | `/v1/templates/{id}/preview-url` | bearer |
| POST | `/v1/templates/{id}/generate` | bearer |
| GET | `/v1/templates/{id}/mock-data` | bearer |
| POST | `/v1/templates/{id}/mock-data` | bearer |
| DELETE | `/v1/templates/{id}/mock-data/{setId}` | bearer |
| GET | `/v1/templates/{id}/widgets` | bearer |
| PUT | `/v1/templates/{id}/widgets` | bearer |
| POST | `/v1/templates/{id}/batch` | bearer (multipart) |
| GET | `/v1/jobs/{id}` | bearer |
| POST | `/v1/folders` | bearer |
| GET | `/v1/folders` | bearer |
| GET | `/v1/folders/{id}/breadcrumbs` | bearer |
| PATCH | `/v1/folders/{id}` | bearer |
| DELETE | `/v1/folders/{id}` | bearer |
| PATCH | `/v1/files/{id}` | bearer |
| POST | `/v1/files/{id}/share` | bearer |
| GET | `/v1/files/{id}/shares` | bearer |
| DELETE | `/v1/shares/{shareId}` | bearer |
| GET | `/v1/public/shares/{token}` | **public** |
| GET | `/v1/templates/{id}/versions` | bearer |
| POST | `/v1/templates/{id}/versions/{ver}/restore` | bearer |
| GET | `/v1/templates/{id}/source` | bearer |
| PUT | `/v1/templates/{id}/source` | bearer |

## Smoke Test (Day 2)

1. `docker compose up -d` in `infra/`
2. `go run ./cmd/api` in `api/`
3. `npm run dev` in `web/`
4. Sign in → Drive page → click Upload → pick a PDF
5. Progress bar fills → file appears in the table
6. Download → opens the file in a new tab
7. Trash → file disappears from the list

## End-to-end smoke test

```bash
./scripts/smoke.sh path/to/some-acroform.pdf
```

Registers a fresh user, uploads the PDF, verifies fields extract, and generates a filled PDF.

## Week 2 Backlog

- Static PDF designer (dnd-kit + gofpdf overlay)
- HTML mode + Chromium pool
- Async generation via Asynq
- Folders, sharing, versions diff view
- OpenAPI spec + SDK generation
- ClamAV scanning, Kratos SSO, thumbnails
