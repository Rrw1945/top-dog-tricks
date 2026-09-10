# Top Dog Tricks

Top Dog Tricks collects dog trick contest videos from owners and gives a private review team a persistent media queue. The intended public domain is `topdogtricks.com`.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `ADMIN_PASSWORD` — admin dashboard password (defaults to `topdog` for local development)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/top-dog-tricks/src/pages/home.tsx` — public contest entry experience, direct media uploads, and signature canvas
- `artifacts/top-dog-tricks/src/pages/admin.tsx` — password-gated review queue and detail workspace
- `artifacts/api-server/src/routes/submissions.ts` — submission CRUD, dashboard summary, and review updates
- `artifacts/api-server/src/routes/admin.ts` — signed admin cookie session
- `artifacts/api-server/src/routes/storage.ts` — App Storage presigned upload and media serving
- `lib/db/src/schema/submissions.ts` — PostgreSQL source of truth for entry metadata and review state
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `artifacts/top-dog-tricks/src/index.css` — shared visual theme and interaction styles

## Architecture decisions

- Video and signature bytes live in App Storage; PostgreSQL stores only object paths plus searchable entry metadata.
- Public owners do not need accounts to submit; review endpoints require a signed, httpOnly admin cookie.
- The browser requests presigned upload URLs and sends media directly to App Storage, avoiding large video bodies through Express.
- The signature is drawn in-browser and serialized to a PNG before the same persistent upload flow.
- New entries sync owner and dog details to the connected Airtable base and generate a signed PDF in the connected Google Drive `Legal Releases` folder.
- New submissions wait for human review. Editor approval triggers FFmpeg production using optional start/end trim marks, 1080×1920 H.264 normalization, source-audio cleanup, a burned-in hook based on dog/trick/description, and an OpenAI voiceover mixed into the final MP4.
- Only approved entries with completed final renders are public. The homepage exposes three newest-video slots; newer completed approvals replace older videos while the full showcase remains available.

## Product

Owners submit only their name, email, dog name, trick description, video, and drawn signature; the API derives a concise trick title. Admins can sign in, search/filter the queue, preview media, review signatures, set action trim points, write punchlines, and mark entries pending, approved, needs edit, or rejected.

## User preferences

No standing preferences recorded.

## Gotchas

- The API and web artifacts each own managed workflows; restart those workflows rather than creating duplicates.
- Keep generated client/Zod files in sync by running API codegen after OpenAPI changes.
- Slack notifications use the authorized Slack connector and default to `#all-top-dog-tricks`; owner contact details are intentionally excluded from this public channel.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
