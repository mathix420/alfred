#!/usr/bin/env python3
"""Print only public Hermes Matrix settings, with optional bot whoami lookup.

Run from the repository against an existing Hermes container:
  docker compose exec -T hermes python - < deploy/inspect-hermes-matrix.py
  docker compose exec -T hermes python - --resolve-user < deploy/inspect-hermes-matrix.py

No writes, login, room joins, messages, or key uploads. --resolve-user uses the bot
token in memory for HTTPS whoami; --devices also queries published public keys.
--alfred-env discovers the sender's homeserver without sending credentials.
Importing makes no requests.
Official Hermes Dockerfile sets HERMES_HOME=/opt/data:
https://github.com/NousResearch/hermes-agent/blob/main/Dockerfile
"""
from __future__ import annotations

import argparse
import base64
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
    if environment.get("HERMES_HOME"):
        # An explicit profile must never fall through to another profile's token.
        return [Path(environment["HERMES_HOME"]).expanduser() / ".env"]
    return list(dict.fromkeys((Path("/opt/data/.env"), Path("/opt/data/.hermes/.env"), home / ".hermes/.env")))


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
    values = {key: environment[key] for key in keys if key in environment}
    diagnostics = []
    # Use a single highest-priority settings file, not credentials from multiple
    # profiles. Hermes loads its home .env with override=True, including empties.
    for path in paths:
        try:
            with path.open("rb") as source:
                raw = source.read(MAX_ENV_BYTES + 1)
            if len(raw) > MAX_ENV_BYTES:
                diagnostics.append("Hermes settings file exceeds the inspection limit.")
                values.pop(TOKEN_KEY, None)
            else:
                values.update(parse_selected_env(raw.decode("utf-8-sig"), keys))
            break
        except FileNotFoundError:
            continue
        except (OSError, UnicodeError):
            diagnostics.append("Cannot read the selected Hermes settings file.")
            values.pop(TOKEN_KEY, None)
            break
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


def resolve_bot_identity(homeserver: str, token: str, opener=None) -> dict:
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
        return {"user_id": user, "device_id": public_text(body.get("device_id"), 255) or None}
    except HTTPError as error:
        code = "redirect_refused" if 300 <= error.code < 400 else "whoami_http_error"
        error.close()
        raise LookupError(code) from None
    except (URLError, OSError, TimeoutError):
        raise LookupError("whoami_network_error") from None
    except (ValueError, UnicodeError):
        raise LookupError("invalid_whoami_response") from None


def resolve_bot_user(homeserver: str, token: str, opener=None) -> str:
    return resolve_bot_identity(homeserver, token, opener)["user_id"]


def query_devices(homeserver: str, token: str, users: list[str], opener=None):
    """Read published public keys only; discovery never establishes trust."""
    if not public_url(homeserver) or not public_text(token, 16384) or not token:
        raise LookupError("device_lookup_credentials_unavailable")
    if not users or any(not matrix_id(user, "@") for user in users):
        raise LookupError("device_lookup_identity_unavailable")
    request = Request(homeserver + "/_matrix/client/v3/keys/query", method="POST",
                      data=json.dumps({"device_keys": {user: [] for user in users}}).encode(),
                      headers={"Authorization": "Bearer " + token,
                               "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=20) as response:
            raw = response.read(MAX_ENV_BYTES + 1)
        if len(raw) > MAX_ENV_BYTES:
            raise ValueError()
        body = json.loads(raw)
        if not isinstance(body, dict) or body.get("failures") or not isinstance(body.get("device_keys"), dict):
            raise ValueError()
        pins = []
        for user in users:
            devices = body["device_keys"].get(user, {})
            if not isinstance(devices, dict):
                raise ValueError()
            for device, entry in sorted(devices.items()):
                if not public_text(device, 255) or not isinstance(entry, dict):
                    raise ValueError()
                if entry.get("user_id") != user or entry.get("device_id") != device:
                    raise ValueError()
                keys = entry.get("keys")
                fingerprint = keys.get("ed25519:" + device) if isinstance(keys, dict) else None
                if not isinstance(fingerprint, str) or not re.fullmatch(r"[A-Za-z0-9+/]{43}", fingerprint):
                    raise ValueError()
                decoded = base64.b64decode(fingerprint + "=", validate=True)
                if len(decoded) != 32 or base64.b64encode(decoded).decode().rstrip("=") != fingerprint:
                    raise ValueError()
                pins.append({"userId": user, "deviceId": device, "ed25519": fingerprint})
        return pins
    except HTTPError as error:
        error.close()
        raise LookupError("device_lookup_http_error") from None
    except (URLError, OSError, TimeoutError):
        raise LookupError("device_lookup_network_error") from None
    except (ValueError, UnicodeError):
        raise LookupError("invalid_device_keys_response") from None


def discover_homeserver(user: str, opener=None):
    """Use the sender's public discovery document, without the bot token."""
    if not matrix_id(user, "@"):
        raise LookupError("sender_identity_unavailable")
    server = user.split(":", 1)[1]
    origin = "https://" + server
    if public_url(origin) != origin or urlsplit(origin).path:
        raise LookupError("invalid_sender_server_name")
    request = Request(origin + "/.well-known/matrix/client", headers={"Accept": "application/json"})
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=15) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        body = json.loads(raw)
        settings = body.get("m.homeserver") if isinstance(body, dict) else None
        result = public_url(settings.get("base_url")) if isinstance(settings, dict) else None
        if not result:
            raise ValueError()
        return result
    except HTTPError as error:
        error.close()
        raise LookupError("sender_homeserver_discovery_unavailable") from None
    except (URLError, OSError, TimeoutError, ValueError, UnicodeError):
        raise LookupError("sender_homeserver_discovery_unavailable") from None


def select_sender(result, supplied=None):
    if supplied:
        if not matrix_id(supplied, "@") or supplied == result["MATRIX_USER_ID"]:
            raise LookupError("sender_must_be_your_own_matrix_user")
        return supplied
    users = [user for user in result["MATRIX_ALLOWED_USERS"] or [] if user != result["MATRIX_USER_ID"]]
    return users[0] if len(users) == 1 else None


def alfred_env(result, sender=None, room=None, homeserver=None, pins=None):
    """Missing credentials are comments, so importing cannot blank existing ones."""
    lines = ["# Alfred Matrix setup: public metadata only; no Hermes credentials.",
             "ALFRED_MATRIX_ENABLED=false"]

    def setting(key, value, comment=False):
        # Neither shell sourcing nor Bun interpolation may turn metadata into code.
        if value and public_text(value, MAX_ENV_BYTES) and not any(c in value for c in "'$"):
            lines.append(("# " if comment else "") + key + "='" + value + "'")
        else:
            lines.append("# " + key + " needs to be filled in manually.")

    setting("ALFRED_MATRIX_HERMES_USER_ID", result["MATRIX_USER_ID"])
    if result.get("device_identity_source") == "bot_token_whoami":
        lines.append("# Hermes token device (not Alfred's sender device): " + json.dumps(result["MATRIX_DEVICE_ID"], ensure_ascii=True))
    lines.append("# Confirm this is YOUR account (inferred from a single allowed user unless --user was supplied).")
    setting("ALFRED_MATRIX_USER_ID", sender)
    if not sender:
        lines.append("# Allowed sender candidates: " + json.dumps(result["MATRIX_ALLOWED_USERS"] or [], ensure_ascii=True))
    setting("ALFRED_MATRIX_HOMESERVER", homeserver)
    if not homeserver:
        lines.append("# Hermes homeserver, which may differ from yours: " + json.dumps(result["MATRIX_HOMESERVER"], ensure_ascii=True))
    if not room:
        home_rooms = list(dict.fromkeys(filter(None, [result["MATRIX_HOME_ROOM"], result["MATRIX_HOME_CHANNEL"]])))
        allowed_rooms = result["MATRIX_ALLOWED_ROOMS"] or []
        room = home_rooms[0] if len(home_rooms) == 1 else allowed_rooms[0] if not home_rooms and len(allowed_rooms) == 1 else None
    setting("ALFRED_MATRIX_ROOM_ID", room)
    if not room:
        lines.append("# Allowed room candidates: " + json.dumps(result["MATRIX_ALLOWED_ROOMS"] or [], ensure_ascii=True))
    lines.extend([
        "# ALFRED_MATRIX_ACCESS_TOKEN: obtain from a dedicated session on YOUR account.",
        "# ALFRED_MATRIX_DEVICE_ID: the device ID belonging to that same session.",
        "# ALFRED_MATRIX_PICKLE_KEY: retain the existing value; generate once if absent.",
        "# Keep ALFRED_DEVICE_TOKEN unchanged: it already belongs to your ESP32.",
        "# Published device fingerprints below are UNVERIFIED candidates.",
        "# Compare with trusted clients, then select only verified devices; do not uncomment the whole list blindly.",
    ])
    if pins:
        setting("ALFRED_MATRIX_TRUSTED_DEVICES", json.dumps(pins, separators=(",", ":"), ensure_ascii=True), comment=True)
    else:
        lines.append("# ALFRED_MATRIX_TRUSTED_DEVICES: obtain and verify Hermes and recipient device fingerprints.")
    lines.append("# Enable Matrix only after completing the session and verified-device settings.")
    return "\n".join(lines)


def inspect(values: dict[str, str], resolve=False, resolver=resolve_bot_identity):
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
            identity = resolver(result["MATRIX_HOMESERVER"], values.get(TOKEN_KEY, ""))
            user = identity.get("user_id") if isinstance(identity, dict) else identity
            if not matrix_id(user, "@"):
                raise LookupError("invalid_whoami_response")
            result["configured_user_id_matches_token"] = result["MATRIX_USER_ID"] == user if result["MATRIX_USER_ID"] else None
            result["MATRIX_USER_ID"] = user
            result["identity_source"] = "bot_token_whoami"
            if isinstance(identity, dict) and public_text(identity.get("device_id"), 255):
                result["MATRIX_DEVICE_ID"] = identity["device_id"]
                result["device_identity_source"] = "bot_token_whoami"
        except LookupError as error:
            result["identity_lookup_error"] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolve-user", action="store_true", help="make one HTTPS whoami request with the bot token (never printed)")
    parser.add_argument("--alfred-env", action="store_true", help="print an Alfred env template, discovering the sender homeserver over HTTPS")
    parser.add_argument("--devices", action="store_true", help="query published public device keys; implies --resolve-user and never trusts them")
    parser.add_argument("--user", help="your own sender Matrix ID if Hermes allows multiple users")
    parser.add_argument("--room", help="existing chat room ID to use in the env template")
    args = parser.parse_args()
    if args.room and not matrix_id(args.room, "!"):
        parser.error("--room must be a Matrix room ID (!id:server).")
    resolve = args.resolve_user or args.devices
    values, diagnostics = load_settings(os.environ, candidate_files(os.environ, Path.home()), resolve)
    result = inspect(values, resolve)
    sender, homeserver, pins = None, None, []
    if args.alfred_env or args.devices:
        try:
            sender = select_sender(result, args.user)
        except LookupError as error:
            parser.error(str(error))
    if args.alfred_env and sender:
        try:
            homeserver = discover_homeserver(sender)
        except LookupError as error:
            diagnostics.append(str(error))
    if args.devices and not result.get("identity_lookup_error"):
        try:
            users = list(dict.fromkeys(filter(None, [result["MATRIX_USER_ID"], sender])))
            pins = query_devices(result["MATRIX_HOMESERVER"], values.get(TOKEN_KEY, ""), users)
            result["unverified_devices"] = pins
        except LookupError as error:
            diagnostics.append(str(error))
    if diagnostics:
        result["diagnostics"] = diagnostics
    if args.alfred_env:
        print(alfred_env(result, sender, args.room, homeserver, pins))
        for diagnostic in diagnostics + ([result["identity_lookup_error"]] if result.get("identity_lookup_error") else []):
            print("# Diagnostic: " + diagnostic)
    else:
        print(json.dumps(result, indent=2, ensure_ascii=True))
    return 1 if result.get("identity_lookup_error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
