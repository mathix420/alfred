#!/usr/bin/env python3
"""Inspect public Matrix device keys using Alfred's configured session.

Reads three authenticated endpoints; never logs in, opens crypto stores, changes
trust, uploads keys, joins rooms, or sends messages. Importing performs no I/O.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_DEVICES = 512


class InspectionError(Exception):
    """Only fixed, public diagnostic codes may be surfaced."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def safe_text(value, limit=255):
    return isinstance(value, str) and 0 < len(value) <= limit and all(32 <= ord(c) < 127 for c in value)


def user_id(value):
    return safe_text(value, 1024) and re.fullmatch(r"@[^:\s]+:[^\s]+", value) is not None


def fingerprint(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9+/]{43}=?", value):
        raise InspectionError("invalid_public_device_key")
    raw = base64.b64decode(value.rstrip("=") + "=", validate=True)
    if len(raw) != 32 or base64.b64encode(raw).decode().rstrip("=") != value.rstrip("="):
        raise InspectionError("invalid_public_device_key")
    return value.rstrip("=")


def homeserver_url(value):
    if not safe_text(value, 2048):
        raise InspectionError("https_homeserver_required")
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "https" and parsed.hostname and parsed.username is None
                 and parsed.password is None and not parsed.query and not parsed.fragment)
        _ = parsed.port
    except ValueError:
        valid = False
    if not valid:
        raise InspectionError("https_homeserver_required")
    return value.rstrip("/")


def public_name(value):
    # Display names are untrusted and can contain terminal escape sequences.
    if not isinstance(value, str):
        return None
    return "".join(c for c in value[:200] if c.isprintable()) or None


def fetch_json(home, token, path, body=None, opener=None):
    request = Request(home + path, method="POST" if body is not None else "GET",
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={"Authorization": "Bearer " + token,
                               "Accept": "application/json", "Content-Type": "application/json"})
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=15) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise InspectionError("matrix_response_too_large")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise InspectionError("invalid_matrix_response")
        return result
    except HTTPError as error:
        status = error.code
        error.close()
        if 300 <= status < 400:
            raise InspectionError("matrix_redirect_refused") from None
        if status in (401, 403):
            raise InspectionError("matrix_authentication_failed") from None
        raise InspectionError("matrix_http_error") from None
    except (URLError, OSError, TimeoutError):
        raise InspectionError("matrix_network_error") from None
    except (ValueError, UnicodeError):
        raise InspectionError("invalid_matrix_response") from None


def configured_pins(raw, own, hermes):
    try:
        entries = json.loads(raw or "[]")
        if not isinstance(entries, list) or len(entries) > 64:
            raise ValueError()
        pins = {}
        for entry in entries:
            user, device = entry["userId"], entry["deviceId"]
            if user not in (own, hermes) or not safe_text(device) or (user, device) in pins:
                raise ValueError()
            pins[(user, device)] = fingerprint(entry["ed25519"])
        return pins
    except (ValueError, TypeError, KeyError, InspectionError):
        raise InspectionError("invalid_trusted_devices_configuration") from None


def inspect(environment, opener=None):
    home = homeserver_url(environment.get("ALFRED_MATRIX_HOMESERVER"))
    own = environment.get("ALFRED_MATRIX_USER_ID")
    hermes = environment.get("ALFRED_MATRIX_HERMES_USER_ID")
    sender = environment.get("ALFRED_MATRIX_DEVICE_ID")
    token = environment.get("ALFRED_MATRIX_ACCESS_TOKEN")
    if not user_id(own) or not user_id(hermes) or own == hermes or not safe_text(sender):
        raise InspectionError("matrix_identity_configuration_required")
    if not safe_text(token, 16384):
        raise InspectionError("matrix_access_token_required")
    pins = configured_pins(environment.get("ALFRED_MATRIX_TRUSTED_DEVICES"), own, hermes)
    identity = fetch_json(home, token, "/_matrix/client/v3/account/whoami", opener=opener)
    if identity.get("user_id") != own or identity.get("device_id") != sender:
        raise InspectionError("matrix_identity_mismatch")

    device_response = fetch_json(home, token, "/_matrix/client/v3/devices", opener=opener)
    listed = device_response.get("devices")
    if not isinstance(listed, list) or len(listed) > MAX_DEVICES:
        raise InspectionError("invalid_devices_response")
    names = {}
    for device in listed:
        if not isinstance(device, dict) or not safe_text(device.get("device_id")):
            raise InspectionError("invalid_devices_response")
        if device["device_id"] in names:
            raise InspectionError("invalid_devices_response")
        names[device["device_id"]] = public_name(device.get("display_name"))

    keys_response = fetch_json(home, token, "/_matrix/client/v3/keys/query",
                               {"device_keys": {own: [], hermes: []}}, opener)
    keys = keys_response.get("device_keys")
    if keys_response.get("failures") or not isinstance(keys, dict):
        raise InspectionError("matrix_device_query_failed")
    devices = []
    found = set()
    for user in (own, hermes):
        entries = keys.get(user, {})
        if not isinstance(entries, dict) or len(entries) > MAX_DEVICES:
            raise InspectionError("invalid_device_keys_response")
        ids = set(entries) | (set(names) if user == own else set())
        if len(ids) > MAX_DEVICES or any(not safe_text(device) for device in ids):
            raise InspectionError("invalid_device_keys_response")
        for device in sorted(ids):
            entry = entries.get(device)
            key = None
            name = names.get(device) if user == own else None
            if entry is not None:
                if (not isinstance(entry, dict) or entry.get("user_id") != user
                        or entry.get("device_id") != device or not isinstance(entry.get("keys"), dict)):
                    raise InspectionError("invalid_device_keys_response")
                key = fingerprint(entry["keys"].get("ed25519:" + device))
                unsigned = entry.get("unsigned")
                if name is None and isinstance(unsigned, dict):
                    name = public_name(unsigned.get("device_display_name"))
            expected = pins.get((user, device))
            if expected:
                found.add((user, device))
            status = "pinned" if expected == key and key else "unpinned"
            if not key:
                status = "no-published-key"
            if expected and expected != key:
                status = "pin-mismatch" if key else "pinned-key-missing"
            if (user, device) == (own, sender):
                status = "current-sender"
            devices.append({"userId": user, "deviceId": device, "displayName": name,
                            "ed25519": key, "status": status})

    missing = [{"userId": user, "deviceId": device} for user, device in sorted(set(pins) - found)]
    own_devices = [device for device in devices if device["userId"] == own and device["deviceId"] != sender]
    warnings = []
    if not any(device["status"] == "pinned" for device in own_devices):
        warnings.append("No other own device has a matching pin; Beeper clients will not receive new recording keys.")
    if any(device["status"] == "unpinned" for device in own_devices):
        warnings.append("Unpinned own devices are excluded. Verify each intended phone or desktop fingerprint before adding it.")
    if any(device["status"] == "pin-mismatch" for device in devices):
        warnings.append("A configured fingerprint differs from the server's key. Verify the device independently before changing its pin.")
    if missing or any(device["status"] == "pinned-key-missing" for device in devices):
        warnings.append("Some configured pins have no published device key.")
    candidates = [{field: device[field] for field in ("userId", "deviceId", "ed25519")}
                  for device in devices if device["ed25519"] and device["status"] != "current-sender"]
    return {"userId": own, "senderDeviceId": sender, "devices": devices,
            "missingPins": missing, "warnings": warnings, "unverifiedCandidatePins": candidates}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Print public diagnostic JSON instead of the readable report")
    arguments = parser.parse_args(argv)
    try:
        report = inspect(os.environ)
    except InspectionError as error:
        print("Inspection failed: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Inspection failed: unexpected_inspection_error", file=sys.stderr)
        return 1
    if arguments.json:
        print(json.dumps(report, ensure_ascii=True, indent=2))
        return 0
    print("Authenticated user: " + report["userId"])
    print("Alfred sender device: " + report["senderDeviceId"])
    for device in report["devices"]:
        print("\n" + device["userId"] + " / " + device["deviceId"] + " [" + device["status"] + "]")
        if device["displayName"]:
            print("  Name: " + device["displayName"])
        print("  Ed25519: " + (device["ed25519"] or "not published"))
    for device in report["missingPins"]:
        print("\nMissing pinned device: " + device["userId"] + " / " + device["deviceId"])
    for warning in report["warnings"]:
        print("\n" + warning)
    print("\n# Discovered candidates only: select and independently verify intended devices.")
    print("# This does not establish trust. Do not import this whole list automatically.")
    for line in json.dumps(report["unverifiedCandidatePins"], ensure_ascii=True, indent=2).splitlines():
        print("# " + line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
