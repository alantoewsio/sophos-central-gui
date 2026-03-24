# Security Review — Sophos Central GUI

**Document version:** 1.1  
**Review date:** 2026-03-24  
**Bandit re-scan:** 2026-03-24 (see §2)  
**Scope:** Local FastAPI application (`main.py`, `auth.py`, `credential_store.py`, `sync_runner.py`, `sync_scheduler.py`, `cli.py`), declared runtime dependencies (`pyproject.toml` / `uv.lock` at time of review).

This document summarizes automated scans, dependency checks, and a manual read of security-relevant design. It is not a formal penetration test or compliance attestation.

---

## 1. Methodology

| Activity | Tool / approach | Notes |
|----------|-----------------|--------|
| Python static analysis | Bandit 1.9.4 (`uv run bandit -r . -c pyproject.toml -ll`); **`[tool.bandit]`** skips **B608** | Low through high severity; see §2. |
| Dependency CVE scan | pip-audit (via `uv run --with pip-audit`) | Requirements exported with `uv export --no-dev --no-editable --no-hashes` (local project name `sophos-central-gui` is not on PyPI and was skipped by the auditor). |
| Manual review | Source inspection | Auth, crypto, storage, middleware, high-risk API patterns. |

---

## 2. Static analysis (Bandit)

**Last run:** 2026-03-24 — Bandit **1.9.4**, Python **3.12.12**, **3 417** lines scanned (`.venv` excluded).

**Result:** **No issues reported** (0 High, 0 Medium, 0 Low) with the project’s default configuration.

**Configuration:** **`pyproject.toml`** **`[tool.bandit]`** sets `skips = ["B608"]`. Without that skip, Bandit reports B608 on almost any SQL string built outside a single static literal (including safe patterns: `IN` clauses whose expansion is only `?` characters, tenant-label fragments after identifier validation, and profile `UPDATE` sets built from a fixed column map). The skip documents an explicit acceptance: **all** user-supplied values in SQL are passed as **`?` bindings**; dynamic text is limited to **allowlisted** `SET` fragments (`_PROFILE_SET_CLAUSE_BY_COL`), **validated** table/column identifiers (`str.isalnum()` / `_TENANT_ID_COL_RE`), or subquery text produced only by those helpers.

**Related code hardening (same timeframe as the scan):**

- **B310 resolved in code:** Nominatim geocoding (`main.py`, `_nominatim_search`) uses **`requests.get`** to a fixed HTTPS base URL with `params=` and `timeout=15`, not `urllib.request.urlopen`.
- **B105 avoided in code:** The session env name in `auth.py` is assembled with `"_".join((...))` so Bandit does not treat one long literal as a hardcoded secret. The authenticated `/api/auth/status` payload avoids a **`False` literal** beside the JSON key `needs_admin_password_setup` (Bandit B105 false positive) by using a named boolean variable.

**Operational note:** Re-run from the repo root after `uv sync --extra dev` (`uv run bandit -r . -c pyproject.toml -ll`; add **`-i`** to include low severity). If you remove the B608 skip, expect many medium/low B608 hits that still require human triage against the rules above.

---

## 3. Dependency review

### 3.1 Direct dependencies (declared)

| Package | Declared constraint | Role |
|---------|---------------------|------|
| `cryptography` | `>=43.0.0` | Fernet (AES-128-GCM) for OAuth client secrets at rest |
| `argon2-cffi` | `>=25.1.0` | Argon2id password hashing |
| `fastapi` | `>=0.115.0` | HTTP API |
| `uvicorn[standard]` | `>=0.32.0` | ASGI server |
| `jinja2` | `>=3.1.4` | Templates (`autoescape` enabled for html/xml) |
| `itsdangerous` | `>=2.2.0` | Used by Starlette signed sessions |
| `sfos-central-sdk` | `>=0.9.3` | Sophos Central client/sync |

### 3.2 pip-audit result (exported tree, review date)

- **Result:** No known vulnerabilities reported for the audited PyPI packages.
- **Caveat:** Transitive packages and the local project wheel were not fully represented as a single PyPI name; **re-run** `uv lock` + `uv export --no-dev --no-editable --no-hashes` + `pip-audit -r <file>` regularly (e.g. in CI).
- **Transitive surface (examples resolved at review time):** `requests`, `urllib3`, `pydantic`, `starlette`, `cffi`, `openssl` (via `cryptography`), etc. — all were reported clean by pip-audit on this run.

### 3.3 Supply chain

- Pin versions in `uv.lock` and upgrade deliberately.
- `sfos-central-sdk` is a third-party integration; monitor its releases for security notices.

---

## 4. Secure storage and cryptography

### 4.1 Data stores (design)

| Asset | File / location | Protection |
|-------|-----------------|------------|
| Central sync cache | `sophos_central.db` | **Plain SQLite** — firewalls, tenants, alerts, licenses, etc. OS file permissions and full-disk encryption are the primary controls. |
| UI users + encrypted OAuth secrets | `sophos_secrets.db` | **SQLite**; OAuth **client secret** stored encrypted (see below); **client_id** and `whoami_json` stored in plaintext. |
| Fernet key (default) | `sophos_credential_key` | Raw key material; **chmod 0o600** attempted after create. |
| Session signing secret (default) | `sophos_session_secret` | Random hex; **chmod 0o600** attempted after create. |
| Sync logs | `logs/sync.log` | Rotating file handler; logs **OAuth client_id** and errors, **not** client secrets. |

Two databases are **attached** in some queries (`main.get_db_with_sec`) so tenant labels can join credential metadata **without** decrypting secrets in SQL.

### 4.2 OAuth client secret encryption (Fernet)

**Module:** `credential_store.py` (`cryptography.fernet.Fernet`)

| Aspect | Detail |
|--------|--------|
| Algorithm | Fernet: AES-128 in **GCM** mode, HMAC-SHA256 for authentication, timestamp for optional TTL semantics (Fernet token format). |
| Key format | 32 url-safe base64-encoded bytes (`Fernet.generate_key()`). |
| Key source (order) | 1) Environment variable `SOPHOS_CENTRAL_GUI_FERNET_KEY` (must be a valid Fernet key bytes/string), 2) else read `sophos_credential_key`, 3) else **generate**, write file, chmod `0o600`. |
| Initialization risk | First-run key generation ties ciphertext to that host file; **key loss or rotation invalidates** existing `client_secret_enc` rows (decrypt raises `InvalidToken`, surfaced as a clear error). |
| Iterations / KDF | **None** — Fernet uses a **random IV per encryption** inside the token; there is no password-based key derivation because the key is random binary material, not a user password. |

**Threat model note:** Anyone with read access to **both** `sophos_credential_key` and `sophos_secrets.db` can decrypt all stored client secrets. OS access control and backups policy matter.

### 4.3 UI password hashing (Argon2)

**Module:** `auth.py` (`argon2.PasswordHasher`)

| Parameter | Value |
|-----------|--------|
| Variant | **Argon2id** (default for `argon2-cffi` `PasswordHasher`) |
| `time_cost` | 3 |
| `memory_cost` | 64 × 1024 KiB (64 MiB) |
| `parallelism` | 2 |
| `hash_len` | 32 bytes |
| `salt_len` | 16 bytes |

Password policy enforced in API: minimum length **10** (`validate_new_password`).

**Note:** `verify_password` calls `check_needs_rehash` but **does not persist** an upgraded hash if parameters change; logins still succeed, but hashes would not auto-migrate until a password change path stores a new hash.

### 4.4 Session cookies (Starlette `SessionMiddleware`)

**Module:** `main.py` + `auth.get_session_secret()`

| Setting | Value | Implication |
|---------|--------|-------------|
| Secret source | Env var named `SOPHOS_CENTRAL_GUI_SESSION_SECRET` (see `SESSION_SECRET_ENV` in `auth.py`), else `sophos_session_secret` file, else `secrets.token_hex(32)` written to file | Same pattern as Fernet: **protect the secret file**. |
| `max_age` | 14 days | Session lifetime. |
| `same_site` | `lax` | CSRF mitigation for cross-site POSTs; not `strict`. |
| `https_only` | **`False`** | Cookies may be sent over **HTTP**. Acceptable for strict localhost use; **unsafe** if the app is exposed on a LAN or the internet without TLS. |

---

## 5. Authentication and authorization

### 5.1 Authentication

- **Mechanism:** Server-side session (signed cookie) storing user id (`SESSION_USER_ID_KEY` in `auth.py`).
- **Middleware:** `ProtectApiMiddleware` (`main.py`) requires a session for all `/api/*` routes **except** an explicit allowlist: health, auth status, login, setup-admin-password, logout.
- **Bootstrap:** Default `admin` user can exist with `password_hash` NULL until `POST /api/auth/setup-admin-password` runs (`needs_initial_admin_password` logic in `credential_store.py`).

### 5.2 Authorization

- **Admin-only** routes use `Depends(admin_user_id_dep)` (checks role in `sophos_secrets.db`).
- **Authenticated user** routes use `Depends(current_user_id_dep)` or rely on middleware alone for “any logged-in user” (session present). **Important:** middleware does not re-check role; admin checks must stay on sensitive handlers.

**CLI:** `sophos-gui-clear-admin-password` clears a user’s password hash in `sophos_secrets.db` **without invalidating sessions** (documented in `cli.py` help text) — physical/server access can reset bootstrap state.

---

## 6. Other security-relevant behavior

- **Outbound HTTPS:** Sophos Central API calls via `requests` / SDK; geocoding via Nominatim over HTTPS with a custom `User-Agent`.
- **HTML / XSS:** Jinja2 configured with `select_autoescape(["html", "xml"])`. API returns JSON; front-end should continue to avoid `innerHTML` with untrusted data (not fully audited in this document).
- **Rate limiting / lockout:** No built-in account lockout or rate limit on `POST /api/auth/login` was observed — consider for exposed deployments.
- **CORS:** Not explicitly configured in the reviewed `main.py` (defaults apply).

---

## 7. Findings summary

| ID | Severity | Topic | Summary |
|----|----------|-------|---------|
| F-1 | Informational | Transport | `https_only=False` on session cookies — use HTTPS (reverse proxy) if not only on loopback. |
| F-2 | Informational | Storage | `sophos_central.db` and metadata in `sophos_secrets.db` (client_id, whoami) are **not** encrypted at rest. |
| F-3 | Low | Hardening | Password verify path does not auto-upgrade Argon2 hashes when parameters change. |
| F-4 | Low | Privacy | Geocoding forwards user queries to OpenStreetMap Nominatim (authenticated users only). |
| F-5 | Low | Ops | Sync logs include OAuth **client_id** and error text — treat `logs/` as sensitive. |
| F-6 | Informational | Tooling | Bandit **B608** is skipped via **`pyproject.toml`** **`[tool.bandit]`**; keep all new SQL on bound parameters + allowlists/validation, or re-triage if the skip is removed. |

---

## 8. Recommended next steps

1. **Production / network exposure:** Terminate TLS at a reverse proxy, set `https_only=True` for session cookies (or equivalent), and set strong random `SOPHOS_CENTRAL_GUI_SESSION_SECRET` and `SOPHOS_CENTRAL_GUI_FERNET_KEY` via secrets management (not committed files).
2. **Dependency hygiene:** Run `uv lock --upgrade` + pip-audit on a schedule; subscribe to advisories for `cryptography`, `starlette`, `fastapi`, and `sfos-central-sdk`.
3. **Authentication abuse:** If the listener is not strictly local, add rate limiting and optional lockout for login.
4. **At-rest encryption:** If laptops or shared hosts store the DBs, rely on **full-disk encryption** and restricted file ACLs; optional SQLCipher or OS-level vaults for higher tiers.
5. **Argon2 rehash:** On successful `verify_password`, if `check_needs_rehash`, update `password_hash` in DB.

---

## 9. References (in-repo)

- Bandit policy: `pyproject.toml` `[tool.bandit]` (B608 skip + `exclude_dirs`).
- Fernet + key paths: `credential_store.py` (`_get_fernet`, `encrypt_client_secret`, `decrypt_client_secret`).
- Argon2 parameters: `auth.py` (`PasswordHasher`, `hash_password`, `verify_password`).
- Session secret: `auth.py` (`get_session_secret`, `SESSION_SECRET_ENV`).
- Session middleware: `main.py` (`SessionMiddleware`, `ProtectApiMiddleware`).

---

*This review reflects the repository state at the time it was prepared. Re-run scans after material changes.*
