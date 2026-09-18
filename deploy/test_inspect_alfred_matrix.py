"""Public device-inspection fixtures; no real account or network access."""
import base64
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location("alfred_inspector", Path(__file__).with_name("inspect-alfred-matrix.py"))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)

OWN, BOT, SENDER = "@owner:example.test", "@bot:other.test", "ALFRED"
KEY = base64.b64encode(bytes(range(32))).decode().rstrip("=")
OTHER_KEY = base64.b64encode(bytes(reversed(range(32)))).decode().rstrip("=")


def environment():
    return {"ALFRED_MATRIX_HOMESERVER": "https://matrix.example.test",
            "ALFRED_MATRIX_USER_ID": OWN, "ALFRED_MATRIX_HERMES_USER_ID": BOT,
            "ALFRED_MATRIX_DEVICE_ID": SENDER, "ALFRED_MATRIX_ACCESS_TOKEN": "private-fixture-token",
            "ALFRED_MATRIX_TRUSTED_DEVICES": json.dumps([{"userId": BOT, "deviceId": "BOT", "ed25519": KEY}])}


def device(user, name):
    return {"user_id": user, "device_id": name, "keys": {"ed25519:" + name: KEY},
            "unsigned": {"device_display_name": "Other display name"}}


class Fixtures:
    def __init__(self):
        self.requests = []
        self.responses = [
            {"user_id": OWN, "device_id": SENDER, "private": "must-not-print"},
            {"devices": [{"device_id": SENDER, "display_name": "Alfred"},
                         {"device_id": "PHONE", "display_name": "Beeper phone", "last_seen_ip": "must-not-print"},
                         {"device_id": "DESKTOP", "display_name": "Beeper desktop"}]},
            {"device_keys": {OWN: {key: device(OWN, key) for key in [SENDER, "PHONE", "DESKTOP"]},
                             BOT: {"BOT": device(BOT, "BOT")}}},
        ]

    def open(self, request, timeout):
        self.requests.append(request)
        assert timeout == 15
        return io.BytesIO(json.dumps(self.responses[len(self.requests) - 1]).encode())


class InspectorTests(unittest.TestCase):
    def test_missing_homeserver_explains_console_environment_without_network(self):
        for value in (None, "", " \t\r\n"):
            env, transport = environment(), Fixtures()
            if value is None:
                del env["ALFRED_MATRIX_HOMESERVER"]
            else:
                env["ALFRED_MATRIX_HOMESERVER"] = value
            with self.assertRaisesRegex(inspector.InspectionError, "^alfred_homeserver_missing$"):
                inspector.inspect(env, transport)
            self.assertEqual(transport.requests, [])
        err = io.StringIO()
        with patch.dict(inspector.os.environ, {}, clear=True), redirect_stderr(err):
            self.assertEqual(inspector.main([]), 1)
        self.assertIn("Alfred container's console", err.getvalue())
        self.assertIn("ALFRED_MATRIX_HOMESERVER", err.getvalue())

    def test_homeserver_whitespace_matches_application_normalization(self):
        env, transport = environment(), Fixtures()
        env["ALFRED_MATRIX_HOMESERVER"] = " \thttps://matrix.example.test///\r\n"
        inspector.inspect(env, transport)
        self.assertEqual(transport.requests[0].full_url,
                         "https://matrix.example.test/_matrix/client/v3/account/whoami")

    def test_invalid_homeserver_diagnostic_does_not_echo_value(self):
        for value in ('"https://matrix.example.test"', 'https://user:private-fixture-token@matrix.example.test'):
            env, err = environment(), io.StringIO()
            env["ALFRED_MATRIX_HOMESERVER"] = value
            with patch.dict(inspector.os.environ, env, clear=True), redirect_stderr(err):
                self.assertEqual(inspector.main([]), 1)
            self.assertIn("https_homeserver_required", err.getvalue())
            self.assertNotIn(value, err.getvalue())
            self.assertNotIn("private-fixture-token", err.getvalue())

    def test_current_hermes_only_pins_explain_unreadable_own_clients(self):
        transport = Fixtures()
        report = inspector.inspect(environment(), transport)
        statuses = {(d["userId"], d["deviceId"]): d["status"] for d in report["devices"]}
        self.assertEqual(statuses, {(OWN, SENDER): "current-sender", (OWN, "DESKTOP"): "unpinned",
                                    (OWN, "PHONE"): "unpinned", (BOT, "BOT"): "pinned"})
        self.assertTrue(any("No other own device" in warning for warning in report["warnings"]))
        self.assertEqual(len(report["unverifiedCandidatePins"]), 3)
        self.assertNotIn("private-fixture-token", json.dumps(report))
        self.assertNotIn("must-not-print", json.dumps(report))
        self.assertEqual([r.get_method() for r in transport.requests], ["GET", "GET", "POST"])
        self.assertTrue(transport.requests[0].full_url.endswith("/account/whoami"))
        self.assertTrue(transport.requests[1].full_url.endswith("/devices"))
        self.assertTrue(transport.requests[2].full_url.endswith("/keys/query"))
        self.assertEqual(json.loads(transport.requests[2].data), {"device_keys": {OWN: [], BOT: []}})
        for request in transport.requests:
            self.assertEqual(request.get_header("Authorization"), "Bearer private-fixture-token")

    def test_verified_own_device_pin_and_missing_or_changed_pins(self):
        env = environment()
        pins = json.loads(env["ALFRED_MATRIX_TRUSTED_DEVICES"])
        pins.extend([{"userId": OWN, "deviceId": "PHONE", "ed25519": KEY},
                     {"userId": OWN, "deviceId": "DESKTOP", "ed25519": OTHER_KEY},
                     {"userId": OWN, "deviceId": "OLD", "ed25519": KEY}])
        env["ALFRED_MATRIX_TRUSTED_DEVICES"] = json.dumps(pins)
        report = inspector.inspect(env, Fixtures())
        statuses = {d["deviceId"]: d["status"] for d in report["devices"]}
        self.assertEqual(statuses["PHONE"], "pinned")
        self.assertEqual(statuses["DESKTOP"], "pin-mismatch")
        self.assertEqual(report["missingPins"], [{"userId": OWN, "deviceId": "OLD"}])
        self.assertFalse(any("No other own device" in warning for warning in report["warnings"]))

    def test_identity_mismatch_stops_before_other_queries(self):
        transport = Fixtures()
        transport.responses[0]["device_id"] = "SOME_OTHER_SESSION"
        with self.assertRaisesRegex(inspector.InspectionError, "^matrix_identity_mismatch$"):
            inspector.inspect(environment(), transport)
        self.assertEqual(len(transport.requests), 1)

    def test_no_credentials_sent_to_invalid_url_or_redirect(self):
        for url in ["http://example.test", "https://user:password@example.test", "https://example.test/?token=secret"]:
            env, transport = environment(), Fixtures()
            env["ALFRED_MATRIX_HOMESERVER"] = url
            with self.assertRaises(inspector.InspectionError):
                inspector.inspect(env, transport)
            self.assertEqual(transport.requests, [])
        class Redirect:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 302, "private-fixture-token", {}, None)
        with self.assertRaisesRegex(inspector.InspectionError, "^matrix_redirect_refused$"):
            inspector.inspect(environment(), Redirect())
        self.assertIsNone(inspector.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.test"))

    def test_invalid_server_keys_and_partial_query_fail_closed(self):
        for field, value in [("user_id", "@wrong:test"), ("device_id", "WRONG"), ("keys", {"ed25519:PHONE": "bad"})]:
            transport = Fixtures()
            transport.responses[2]["device_keys"][OWN]["PHONE"][field] = value
            with self.assertRaises(inspector.InspectionError):
                inspector.inspect(environment(), transport)
        transport = Fixtures()
        transport.responses[2]["failures"] = {"other.test": {"message": "private-fixture-token"}}
        with self.assertRaisesRegex(inspector.InspectionError, "^matrix_device_query_failed$"):
            inspector.inspect(environment(), transport)

    def test_response_bounds_and_error_sanitation(self):
        class Large:
            def open(self, request, timeout):
                return io.BytesIO(b" " * (inspector.MAX_RESPONSE_BYTES + 1))
        with self.assertRaisesRegex(inspector.InspectionError, "^matrix_response_too_large$"):
            inspector.inspect(environment(), Large())
        class Failure:
            def open(self, request, timeout):
                raise URLError("private-fixture-token")
        with self.assertRaisesRegex(inspector.InspectionError, "^matrix_network_error$"):
            inspector.inspect(environment(), Failure())
        transport = Fixtures()
        transport.responses[1]["devices"] *= inspector.MAX_DEVICES
        with self.assertRaisesRegex(inspector.InspectionError, "^invalid_devices_response$"):
            inspector.inspect(environment(), transport)

    def test_readable_candidates_are_commented_and_names_are_sanitized(self):
        transport = Fixtures()
        transport.responses[1]["devices"][1]["display_name"] = "Phone\n\x1b[31m"
        report = inspector.inspect(environment(), transport)
        out = io.StringIO()
        with patch.object(inspector, "inspect", return_value=report), redirect_stdout(out):
            self.assertEqual(inspector.main([]), 0)
        output = out.getvalue()
        self.assertNotIn("\x1b", output)
        candidate_lines = output[output.index("# Discovered"):].splitlines()
        self.assertTrue(all(line.startswith("# ") for line in candidate_lines))
        self.assertNotIn("ALFRED_MATRIX_TRUSTED_DEVICES=", output)
        self.assertNotIn("private-fixture-token", output)

    def test_main_never_prints_untrusted_exceptions(self):
        err = io.StringIO()
        with patch.object(inspector, "inspect", side_effect=RuntimeError("private-fixture-token")), redirect_stderr(err):
            self.assertEqual(inspector.main([]), 1)
        self.assertEqual(err.getvalue(), "Inspection failed: unexpected_inspection_error\n")

    def test_no_published_key_is_reported_without_inventing_fingerprint(self):
        transport = Fixtures()
        del transport.responses[2]["device_keys"][OWN]["PHONE"]
        report = inspector.inspect(environment(), transport)
        phone = next(d for d in report["devices"] if d["deviceId"] == "PHONE")
        self.assertEqual(phone["status"], "no-published-key")
        self.assertIsNone(phone["ed25519"])
        self.assertFalse(any(d["deviceId"] == "PHONE" for d in report["unverifiedCandidatePins"]))


if __name__ == "__main__":
    unittest.main()
