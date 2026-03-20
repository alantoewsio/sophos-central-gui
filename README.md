# Sophos Central GUI

Web-based UI to view Sophos Central firewalls discovered via the Central API.

## Prerequisites

- Python 3.12+
- The `central` library (Sophos Central API client) must be installed. If it is not on PyPI, install it from your local path or private index, e.g. `uv pip install -e /path/to/central`.
- Sophos Central API credentials (client ID and secret).

## Credentials

Copy `credentials.env.example` to `credentials.env` (or `.env`) and set:

- `CENTRAL-CLIENT-ID` – your Central API client ID  
- `CENTRAL-CLIENT-SECRET` – your Central API client secret  

The app loads `credentials.env` first, then `.env`. If either variable is missing, the app will not start and will print a clear error.

## Run the web app

From the project root (uses `sophos_central.db` in the same directory):

```bash
uv run python main.py
```

Or: `uv run uvicorn main:app --host 127.0.0.1 --port 8765`

Then open http://127.0.0.1:8765 in a browser. The UI loads dashboard stats, firewalls, tenants, and licenses from the local SQLite database.

## CLI

Clear the stored password hash for the local UI user **`admin`** (default), so you can run through initial administrator password setup again when **no user** still has a password (e.g. after clearing every admin’s hash):

```bash
uv run sophos-gui-clear-admin-password
```

Use `--username NAME` for another account. Existing browser sessions are not invalidated.

## Stored Central credentials (settings)

The gear icon opens **Settings → Credentials**, where you can add Sophos Central API clients. Each entry is checked with Central (`CentralSession` / OAuth + whoami) before it is saved.

- **Database:** `sophos_secrets.db` (separate from `sophos_central.db`), with WAL enabled.
- **Secrets:** Client secrets are encrypted at rest with [Fernet](https://cryptography.io/en/latest/fernet/) (`cryptography`).
- **Key material:** By default a key file `sophos_credential_key` is created next to the DB (Unix mode `0600` when supported). For stricter control, set **`SOPHOS_CENTRAL_GUI_FERNET_KEY`** to a Fernet key (URL-safe base64, 32-byte key) and keep it out of the repo.
- **Git:** `sophos_secrets.db`, `sophos_secrets.db-*` (WAL/shm), and `sophos_credential_key` are listed in `.gitignore`—do not commit them.
- **Host hardening:** Restrict filesystem permissions on the project directory, use full-disk encryption, and run the app only on trusted networks. The UI uses local accounts; still treat the service as a local admin tool.

## Development

- Install dependencies: `uv sync`
- Run the CLI example: `uv run python example.py`
