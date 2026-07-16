# mrdc-assets-api

Shared, read-only **asset register** API for the MRDC HTRA program. One source of
asset data for every app — Quality audits, DMT, Road Patrol, asset inspections,
other reporting — so asset id / name / category / lat / lng / route / km live in
exactly one place.

- **Live URL (recommended):** `https://assets.mrdc-htra.com/api/assets`
- **Source:** Airtable base `app0sXrUbOBr7a6vV` (the register the Road Patrol app uses)
- **Read-only.** GET only. No writes — assets are managed in Airtable.

## Endpoints

| Request | Returns |
|---|---|
| `GET /api/assets` | full register: `[{ id, name, category, lat, lng, route?, km? }]` |
| `GET /api/assets?id=BR-0012` | one asset (what DMT intake calls), or 404 |
| `GET /api/assets?debug=1` | table name + real column names + a sample record (schema check) |

`route` / `km` are included only when those columns exist (DMT's division routing needs them).

## Environment variables (Vercel project settings)

| Var | Required | Notes |
|---|---|---|
| `AIRTABLE_PAT` | yes | token with **read** access to base `app0sXrUbOBr7a6vV` |
| `ASSETS_PAT` | no | overrides `AIRTABLE_PAT` just for this service |
| `ASSETS_BASE` | no | defaults to `app0sXrUbOBr7a6vV` |
| `ASSETS_TABLE` | no | defaults to `Assets` — set if the table is named differently |
| `ASSET_F_ID` / `ASSET_F_NAME` / `ASSET_F_CATEGORY` / `ASSET_F_LAT` / `ASSET_F_LNG` / `ASSET_F_ROUTE` / `ASSET_F_KM` | no | column-name overrides; defaults are `Asset ID`, `Name`, `Category`, `Latitude`, `Longitude`, `Route`, `KM` |

## Access

Read-only and **CORS-limited** to `*.mrdc-htra.com` and `*.vercel.app` origins.
Server-to-server callers (no `Origin` header, e.g. DMT intake) are allowed. To tighten
later, add the platform's `htra_session` check.

## Deploy

1. New Vercel project from this repo (root directory = repo root; no build step).
2. Set `AIRTABLE_PAT` (must read `app0sXrUbOBr7a6vV`), and `ASSETS_TABLE` if not `Assets`.
3. Add the domain `assets.mrdc-htra.com` in project → Domains.
4. Redeploy, then verify: `GET https://assets.mrdc-htra.com/api/assets?debug=1`
   - returns table + column names → success; set any `ASSET_F_*` that don't match.
   - 403 with a hint → the PAT can't read the base yet; grant it access.
