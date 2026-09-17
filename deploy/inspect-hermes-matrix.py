#!/usr/bin/env python3
"""Print only public Hermes Matrix settings, with optional bot whoami lookup.

Run from the repository against an existing Hermes container:
  docker compose exec -T hermes python - < deploy/inspect-hermes-matrix.py
  docker compose exec -T hermes python - --resolve-user < deploy/inspect-hermes-matrix.py

No writes, login, room joins, messages, or key uploads. Only --resolve-user makes
one HTTPS request, using the bot token in memory. Importing makes no requests.
Official Hermes Dockerfile sets HERMES_HOME=/opt/data:
https://github.com/NousResearch/hermes-agent/blob/main/Dockerfile
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

PUBLIC_KEYS = frozenset({
    "MATRIX_HOMESERVER", "MATRIX_USER_ID", "MATRIX_ALLOWED_USERS",
    "MATRIX_ALLOWED_ROOMS", "MATRIX_ALLOW_ALL_USERS", "MATRIX_HOME_ROOM",
    "MATRIX_HOME_CHANNEL", "MATRIX_ENCRYPTION", "MATRIX_E2EE_MODE",
    "MATRIX_DEVICE_ID", "MATRIX_REQUIRE_MENTION",
})
TOKEN_KEY = "MATRIX_ACCESS_TOKEN"
MAX_ENV_BYTES = 1 << 20


def candidate_files(environment: dict[str, str], home: Path) -> list[Path]:
    candidates = []
    if environment.get("HERMES_HOME"):
        candidates.append(Path(environment["HERMES_HOME"]).expanduser() / ".env")
    candidates.extend((Path("/opt/data/.env"), Path("/opt/data/.hermes/.env"), home / ".hermes/.env"))
    return list(dict.fromkeys(candidates))


def parse_selected_env(text: str, keys: frozenset[str]) -> dict[str, str]:
    result = {}
    for line in text.splitlines():
        matched = re.match(r"^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", line)
        if not matched or matched[1] not in keys:
            continue
        # Parse a literal value only. Never source a file or expand variables/code.
        lexer = shlex.shlex(matched[2], posix=True)
        lexer.whitespace_split = True
        lexer.commenters = "#"
        try:
            parts = list(lexer)
        except ValueError:
            continue
        if len(parts) <= 1:
            result[matched[1]] = parts[0] if parts else ""
    return result


def load_settings(environment: dict[str, str], paths: list[Path], include_token=False):
    keys = PUBLIC_KEYS | ({TOKEN_KEY} if include_token else set())
    values = {}
    diagnostics = []
    # Use a single highest-priority settings file, not credentials from multiple
    # profiles. Explicit process environment wins, including explicitly empty values.
    for path in paths:
        try:
            with path.open("rb") as source:
                raw = source.read(MAX_ENV_BYTES + 1)
            if len(raw) > MAX_ENV_BYTES:
                diagnostics.append("Hermes settings file exceeds the inspection limit.")
            else:
                values = parse_selected_env(raw.decode("utf-8"), keys)
            break
        except FileNotFoundError:
            continue
        except (OSError, UnicodeError):
            diagnostics.append("Cannot read the selected Hermes settings file.")
            break
    values.update({key: environment[key] for key in keys if key in environment})
    return values, diagnostics


def public_text(value, max_length=1024):
    return value if isinstance(value, str) and len(value) <= max_length and not any(ord(c) < 32 or ord(c) == 127 for c in value) else None


def matrix_id(value, prefix: str):
    value = public_text(value)
    return value if value and re.fullmatch(re.escape(prefix) + r"[^:\s]+:[^\s]+", value) else None


def public_url(value):
    value = public_text(value, 2048)
    if not value:
        return None
    try:
        url = urlsplit(value)
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.query or url.fragment):
            return None
        _ = url.port
        return value.rstrip("/")
    except ValueError:
        return None


def id_list(value, prefix: str):
    if not value:
        return []
    if not isinstance(value, str):
        return None
    entries = [item.strip() for item in value.split(",") if item.strip()]
    if len(entries) > 512 or any(matrix_id(item, prefix) is None for item in entries):
        return None
    return list(dict.fromkeys(entries))


def boolean(value, fallback: bool):
    if value is None or value == "":
        return fallback
    if not isinstance(value, str):
        return None
    lowered = value.lower().strip()
    if lowered in ("true", "1", "yes", "on"):
        return True
    if lowered in ("false", "0", "no", "off"):
        return False
    return None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LookupError(Exception):
    """Sanitized error code; never includes a token or a response body."""


def resolve_bot_user(homeserver: str, token: str, opener=None) -> str:
    if not public_url(homeserver):
        raise LookupError("https_homeserver_required")
    if not public_text(token, 16384) or not token:
        raise LookupError("bot_access_token_unavailable")
    request = Request(homeserver + "/_matrix/client/v3/account/whoami", headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "User-Agent": "Alfred-Hermes-Inspector/1",
    })
    try:
        # Default HTTPS handler verifies certificates; no redirect can forward auth.
        with (opener or build_opener(NoRedirect())).open(request, timeout=20) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise LookupError("invalid_whoami_response")
        body = json.loads(raw)
        user = matrix_id(body.get("user_id"), "@") if isinstance(body, dict) else None
        if not user:
            raise LookupError("invalid_whoami_response")
        return user
    except HTTPError as error:
        code = "redirect_refused" if 300 <= error.code < 400 else "whoami_http_error"
        error.close()
        raise LookupError(code) from None
    except (URLError, OSError, TimeoutError):
        raise LookupError("whoami_network_error") from None
    except (ValueError, UnicodeError):
        raise LookupError("invalid_whoami_response") from None


def inspect(values: dict[str, str], resolve=False, resolver=resolve_bot_user):
    configured_mode = values.get("MATRIX_E2EE_MODE", "").strip().lower()
    mode = configured_mode if configured_mode in ("off", "optional", "required") else None
    if not configured_mode:
        enabled = boolean(values.get("MATRIX_ENCRYPTION"), False)
        mode = "required" if enabled is True else "off" if enabled is False else None
    result = {
        "MATRIX_HOMESERVER": public_url(values.get("MATRIX_HOMESERVER")),
        "MATRIX_USER_ID": matrix_id(values.get("MATRIX_USER_ID"), "@"),
        "MATRIX_ALLOWED_USERS": id_list(values.get("MATRIX_ALLOWED_USERS"), "@"),
        "MATRIX_ALLOWED_ROOMS": id_list(values.get("MATRIX_ALLOWED_ROOMS"), "!"),
        "MATRIX_HOME_ROOM": matrix_id(values.get("MATRIX_HOME_ROOM"), "!"),
        "MATRIX_HOME_CHANNEL": matrix_id(values.get("MATRIX_HOME_CHANNEL"), "!"),
        "MATRIX_ALLOW_ALL_USERS": boolean(values.get("MATRIX_ALLOW_ALL_USERS"), False),
        "MATRIX_REQUIRE_MENTION": boolean(values.get("MATRIX_REQUIRE_MENTION"), True),
        "MATRIX_DEVICE_ID": public_text(values.get("MATRIX_DEVICE_ID"), 255) or None,
        "MATRIX_ENCRYPTION": mode != "off" if mode is not None else None,
        "MATRIX_E2EE_MODE": mode,
        "identity_source": "configured" if matrix_id(values.get("MATRIX_USER_ID"), "@") else "unresolved",
    }
    if resolve:
        try:
            user = resolver(result["MATRIX_HOMESERVER"], values.get(TOKEN_KEY, ""))
            if not matrix_id(user, "@"):
                raise LookupError("invalid_whoami_response")
            result["configured_user_id_matches_token"] = result["MATRIX_USER_ID"] == user if result["MATRIX_USER_ID"] else None
            result["MATRIX_USER_ID"] = user
            result["identity_source"] = "bot_token_whoami"
        except LookupError as error:
            result["identity_lookup_error"] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolve-user", action="store_true", help="make one HTTPS whoami request with the bot token (never printed)")
    args = parser.parse_args()
    values, diagnostics = load_settings(os.environ, candidate_files(os.environ, Path.home()), args.resolve_user)
    result = inspect(values, args.resolve_user)
    if diagnostics:
        result["diagnostics"] = diagnostics
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 1 if result.get("identity_lookup_error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
