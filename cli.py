"""Command-line utilities for SFOS Central Firewall Management (sfos-central-firewall-management)."""

from __future__ import annotations

import argparse
import sys

from credential_store import (
    DEFAULT_ADMIN_USERNAME,
    SECRETS_DB_PATH,
    clear_user_password_hash,
    get_secrets_db,
)


def _cmd_clear_admin_password(args: argparse.Namespace) -> int:
    uname = (args.username or DEFAULT_ADMIN_USERNAME).strip()
    if not uname:
        print("error: username must not be empty", file=sys.stderr)
        return 2
    if not SECRETS_DB_PATH.exists():
        print(f"error: secrets database not found: {SECRETS_DB_PATH}", file=sys.stderr)
        return 1
    with get_secrets_db() as conn:
        n = clear_user_password_hash(conn, uname)
    if n == 0:
        print(f"error: no user named {uname!r} in {SECRETS_DB_PATH}", file=sys.stderr)
        return 1
    print(f"Cleared password hash for {uname!r} ({n} row{'s' if n != 1 else ''}).")
    print(
        "Next UI load will prompt for initial administrator password when no user has a password yet "
        "(e.g. all hashes cleared)."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sophos-gui-clear-admin-password",
        description=(
            "Clear the stored password hash for a local UI user in the secrets database "
            f"({SECRETS_DB_PATH.name}). Sessions are not invalidated."
        ),
    )
    parser.add_argument(
        "--username",
        default=DEFAULT_ADMIN_USERNAME,
        help=f"Local username to reset (default: {DEFAULT_ADMIN_USERNAME})",
    )
    parser.set_defaults(_run=_cmd_clear_admin_password)
    args = parser.parse_args(argv)
    return int(args._run(args))


if __name__ == "__main__":
    raise SystemExit(main())
