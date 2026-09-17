#!/usr/bin/env python3
"""Interactive Matrix setup; stdlib only, no network activity on import.

Credentials are accepted through getpass/environment and written only to a new
0600 file. This does not send messages, join rooms, or upload encryption keys.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE = 1 << 20
PROVIDER_GUIDANCE = (
    "Use your homeserver/provider's supported SSO or device authorization flow to "
    "create a dedicated Alfred session, then run inspect with its access token. "
    "This helper does not automate SSO, OAuth, or Beeper login. Do not reuse an "
    "existing Beeper device token with an empty Alfred crypto store."
)


class SetupError(Exception):
    """A diagnostic that never includes passwords, tokens, or response bodies."""


def text_value(value, label: str) -> str:
    if not isinstance(value, str) or not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise SetupError(f"Missing or invalid {label}.")
    return value


def homeserver_url(value: str) -> str:
    try:
        value = text_value(value, "homeserver").rstrip("/")
        url = urlsplit(value)
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.query or url.fragment):
            raise ValueError()
        _ = url.port
        return value
    except (ValueError, TypeError):
        raise SetupError("Homeserver must be an HTTPS URL without credentials, query, or fragment.") from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # urllib can otherwise forward an Authorization header to another host.
        return None


class MatrixAPI:
    def __init__(self, homeserver: str):
        self.homeserver = homeserver_url(homeserver)
        self.opener = build_opener(NoRedirect())

    def request(self, method: str, path: str, body=None, token: str | None = None) -> dict:
        headers = {"Accept": "application/json", "User-Agent": "Alfred-Pocket-Setup/1"}
        if token:
            headers["Authorization"] = "Bearer " + text_value(token, "access token")
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.homeserver + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise SetupError("Homeserver response is too large.")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except HTTPError as error:
            if 300 <= error.code < 400:
                raise SetupError("Homeserver redirected the request. Use its final HTTPS API URL; no credentials were forwarded.") from None
            raise SetupError(f"Matrix request failed (HTTP {error.code}); check the account and homeserver.") from None
        except (URLError, OSError, TimeoutError):
            raise SetupError("Cannot reach the Matrix HTTPS API; check connectivity and TLS configuration.") from None
        except (ValueError, UnicodeError):
            raise SetupError("Homeserver returned invalid JSON.") from None


def login_flows(api: MatrixAPI) -> list[str]:
    response = api.request("GET", "/_matrix/client/v3/login")
    flows = response.get("flows")
    if not isinstance(flows, list):
        raise SetupError("Homeserver did not return Matrix login flows. " + PROVIDER_GUIDANCE)
    return sorted({item["type"] for item in flows if isinstance(item, dict)
                   and isinstance(item.get("type"), str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", item["type"])})


def password_login(api: MatrixAPI, user: str, password: str, flows: list[str]) -> dict[str, str]:
    if "m.login.password" not in flows:
        raise SetupError("This homeserver does not advertise password login. " + PROVIDER_GUIDANCE)
    result = api.request("POST", "/_matrix/client/v3/login", {
        "type": "m.login.password",
        "identifier": {"type": "m.id.user", "user": text_value(user, "Matrix user ID")},
        "password": password,
        "initial_device_display_name": "Alfred Pocket",
        # No device_id: request a fresh device, never overwrite a Beeper session.
        "refresh_token": False,
    })
    return {key: text_value(result.get(key), key) for key in ("user_id", "device_id", "access_token")}


def identity(api: MatrixAPI, token: str) -> dict[str, str]:
    result = api.request("GET", "/_matrix/client/v3/account/whoami", token=token)
    return {key: text_value(result.get(key), key) for key in ("user_id", "device_id")}


def fingerprint(value) -> str:
    if not isinstance(value, str):
        raise SetupError("Invalid device fingerprint.")
    normalized = "".join(value.split()).rstrip("=")
    try:
        if not re.fullmatch(r"[A-Za-z0-9+/]{43}", normalized):
            raise ValueError()
        decoded = base64.b64decode(normalized + "=", validate=True)
        if len(decoded) != 32 or base64.b64encode(decoded).decode().rstrip("=") != normalized:
            raise ValueError()
        return normalized
    except ValueError:
        raise SetupError("Invalid device fingerprint.") from None


def devices(api: MatrixAPI, token: str, users: list[str]) -> list[dict[str, str]]:
    response = api.request("POST", "/_matrix/client/v3/keys/query", {"device_keys": {user: [] for user in users}}, token)
    if response.get("failures"):
        raise SetupError("Device discovery was incomplete; a homeserver failed the key query. Try again later.")
    keys = response.get("device_keys")
    if not isinstance(keys, dict):
        raise SetupError("Homeserver did not return device keys.")
    result = []
    for user in sorted(set(users)):
        user_devices = keys.get(user, {})
        if not isinstance(user_devices, dict):
            raise SetupError("Homeserver returned invalid device keys.")
        for device, entry in sorted(user_devices.items()):
            text_value(device, "device ID")
            if not isinstance(entry, dict) or entry.get("user_id") != user or entry.get("device_id") != device:
                raise SetupError("Homeserver returned inconsistent device identities.")
            device_keys = entry.get("keys")
            if not isinstance(device_keys, dict):
                raise SetupError("Homeserver returned invalid device keys.")
            result.append({"userId": user, "deviceId": device,
                           "ed25519": fingerprint(device_keys.get("ed25519:" + device))})
    return result


def select_pins(discovered: list[dict[str, str]], ask=input, say=print) -> list[dict[str, str]]:
    say("Discovery is not trust. Compare fingerprints on the trusted device or with its owner through a trusted channel.")
    say("Select only devices whose complete fingerprints you have independently verified.")
    selected = ask("Verified device numbers, separated by spaces (Enter to leave disabled): ").split()
    try:
        numbers = list(dict.fromkeys(int(value) for value in selected))
        if any(number < 1 or number > len(discovered) for number in numbers):
            raise ValueError()
    except ValueError:
        raise SetupError("Invalid device selection; no device was trusted.") from None
    pins = []
    for number in numbers:
        device = discovered[number - 1]
        confirmed = ask(f"Paste the independently checked fingerprint for device {number}: ")
        if fingerprint(confirmed) != device["ed25519"]:
            raise SetupError("Fingerprint did not match; no configuration was enabled.")
        pins.append(device.copy())
    return pins


def env_text(values: dict[str, str]) -> str:
    lines = ["# Private Alfred Pocket configuration. Never commit or share this file.",
             "# Discovery alone does not establish trust. Keep the crypto store and pickle key together."]
    for key, value in values.items():
        if not re.fullmatch(r"[A-Z_]+", key) or not isinstance(value, str) or any(c in value for c in "'$") or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise SetupError("A configuration value cannot be represented safely in this env file.")
        # Bun expands $ even inside single quotes; reject it rather than silently
        # changing a credential or writing a file interpreted differently by Compose.
        # Single quotes protect #, backslashes, and the trusted-device JSON.
        lines.append(f"{key}='{value}'")
    return "\n".join(lines) + "\n"


class PrivateFile:
    """Reserve a new private file before creating an account session."""
    def __init__(self, path: str):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except FileExistsError:
            raise SetupError("Output already exists. Choose a new path; existing credentials are never overwritten.") from None
        os.fchmod(fd, 0o600)
        self.file = os.fdopen(fd, "w", encoding="utf-8")

    def write(self, values: dict[str, str]) -> None:
        content = env_text(values)
        self.file.seek(0)
        self.file.write(content)
        self.file.truncate()
        self.file.flush()
        os.fsync(self.file.fileno())

    def close(self):
        self.file.close()


def base_config(homeserver: str, login: dict[str, str], hermes: str, room: str,
                generate: bool, environment: dict[str, str]) -> dict[str, str]:
    return {
        "ALFRED_MATRIX_ENABLED": "false",
        "ALFRED_MATRIX_HOMESERVER": homeserver,
        "ALFRED_MATRIX_USER_ID": login["user_id"],
        "ALFRED_MATRIX_ACCESS_TOKEN": login["access_token"],
        "ALFRED_MATRIX_DEVICE_ID": login["device_id"],
        "ALFRED_MATRIX_HERMES_USER_ID": hermes,
        "ALFRED_MATRIX_ROOM_ID": room,
        "ALFRED_MATRIX_PICKLE_KEY": environment.get("ALFRED_MATRIX_PICKLE_KEY") or (secrets.token_urlsafe(48) if generate else ""),
        "ALFRED_DEVICE_TOKEN": environment.get("ALFRED_DEVICE_TOKEN") or (secrets.token_urlsafe(32) if generate else ""),
        "ALFRED_MATRIX_TRUSTED_DEVICES": "[]",
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("command", choices=("flows", "inspect", "password-login"))
    result.add_argument("--homeserver", default=os.getenv("ALFRED_MATRIX_HOMESERVER", ""))
    result.add_argument("--user", default=os.getenv("ALFRED_MATRIX_USER_ID", ""), help="full Matrix user ID for password login")
    result.add_argument("--hermes-user", default=os.getenv("ALFRED_MATRIX_HERMES_USER_ID", ""))
    result.add_argument("--room", default=os.getenv("ALFRED_MATRIX_ROOM_ID", ""), help="existing encrypted room ID; this helper never joins rooms")
    result.add_argument("--output", help="new private env file; mandatory for password-login")
    result.add_argument("--no-generate-secrets", action="store_true", help="leave absent device/pickle secrets blank and Matrix disabled")
    return result


def run(args, api_factory=MatrixAPI, ask=input, hidden=getpass.getpass, say=print,
        environment=None) -> None:
    environment = os.environ if environment is None else environment
    api = api_factory(homeserver_url(args.homeserver))
    flows = login_flows(api)
    say("Advertised login flows: " + (", ".join(flows) or "none"))
    if "m.login.password" not in flows:
        say(PROVIDER_GUIDANCE)
    if args.command == "flows":
        return
    hermes = text_value(args.hermes_user, "Hermes Matrix user ID")
    if not hermes.startswith("@") or ":" not in hermes:
        raise SetupError("Use Hermes's full Matrix user ID (@name:server).")
    if args.room and (not args.room.startswith("!") or ":" not in args.room):
        raise SetupError("Use the existing room ID (!id:server), not a room alias or URL.")
    if args.command == "password-login" and not args.output:
        raise SetupError("Password login requires --output so the new session can be saved privately.")
    if args.command == "password-login" and "m.login.password" not in flows:
        raise SetupError("Password login is unavailable. " + PROVIDER_GUIDANCE)
    output = PrivateFile(args.output) if args.output else None
    try:
        if args.command == "password-login":
            user = args.user or ask("Your full Matrix user ID: ").strip()
            login = password_login(api, user, hidden("Matrix password (hidden): "), flows)
            # Save the new credentials before any further network request or prompt.
            values = base_config(api.homeserver, login, hermes, args.room, not args.no_generate_secrets, environment)
            output.write(values)
            say("New dedicated session saved privately; Matrix remains disabled until pins are verified.")
            actual = identity(api, login["access_token"])
            if any(actual[key] != login[key] for key in ("user_id", "device_id")):
                raise SetupError("Login and token identities do not match; configuration remains disabled.")
        else:
            token = environment.get("ALFRED_MATRIX_ACCESS_TOKEN") or hidden("Dedicated Matrix access token (hidden): ")
            actual = identity(api, token)
            login = {**actual, "access_token": token}
            values = base_config(api.homeserver, login, hermes, args.room, not args.no_generate_secrets, environment)
            if output:
                output.write(values)
        if login["user_id"] == hermes:
            raise SetupError("The pocket account must be distinct from the Hermes account.")
        say("Token identity: " + json.dumps({key: login[key] for key in ("user_id", "device_id")}))
        discovered = devices(api, login["access_token"], [login["user_id"], hermes])
        say("Published device fingerprints (unverified):")
        for index, device in enumerate(discovered, 1):
            say(f"{index}. " + json.dumps(device, ensure_ascii=True))
        own_published = any(d["userId"] == login["user_id"] and d["deviceId"] == login["device_id"] for d in discovered)
        if own_published:
            say("This session already has encryption keys. Use its matching existing Alfred crypto store; a fresh store cannot reuse another client's keys.")
        else:
            say("This session has no published encryption keys yet. Alfred creates them on first configured start; compare its identity in authenticated /api/status with Hermes's device view.")
        if output:
            pins = select_pins(discovered, ask, say)
            values["ALFRED_MATRIX_TRUSTED_DEVICES"] = json.dumps(pins, separators=(",", ":"))
            enabled = (any(d["userId"] == hermes for d in pins) and bool(args.room)
                       and bool(values["ALFRED_MATRIX_PICKLE_KEY"]) and bool(values["ALFRED_DEVICE_TOKEN"]))
            values["ALFRED_MATRIX_ENABLED"] = "true" if enabled else "false"
            output.write(values)
            say("Private configuration saved (0600). " + ("Matrix is enabled; verify Alfred's newly published identity from Hermes before use." if enabled else "Matrix is disabled until the room, secrets, and a verified Hermes pin are present."))
        else:
            say("Diagnostic only: no credentials were written and no devices were trusted.")
    finally:
        if output:
            output.close()


def main() -> int:
    try:
        os.umask(0o077)
        run(parser().parse_args())
        return 0
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("Setup cancelled. Any already-created session remains saved in the private output file with Matrix disabled.", file=sys.stderr)
        return 130
    except OSError:
        print("Cannot read or write the private setup file. Check its path and permissions.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
