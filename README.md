# bundle
vip bundle

## Admin page

- Open `/admin` on the backend server to see customer phone numbers, codes, and allocation status.
- Set `ADMIN_PASSWORD` in the backend environment before deploying.
- If `ADMIN_PASSWORD` is not set, the backend uses `change-me-admin` as a fallback password.

## Persistent storage (database)

- The backend now supports PostgreSQL for persistent customer/admin logs.
- Set `DATABASE_URL` in backend environment variables to enable PostgreSQL storage.
- Without `DATABASE_URL`, the backend falls back to local JSON file storage.
- Optional: set `MAX_SUBMISSIONS_LOGS` (default `50000`) to control retained history size.
- In production, the backend now requires PostgreSQL by default (`REQUIRE_DATABASE_IN_PRODUCTION=true`).
- You can verify live storage mode from backend root response (`/`), which returns `storage: "postgres"` or `"json-file"`.
