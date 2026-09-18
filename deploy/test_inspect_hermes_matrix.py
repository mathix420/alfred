"""Hermes inspection fixtures only: never reads real credentials or connects."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("hermes_inspector", Path(__file__).with_name("inspect-hermes-matrix.py"))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


class InspectorTests(unittest.TestCase):
    def test_public_allowlist_never_loads_secrets_by_default(self):
        contents = """export MATRIX_USER_ID='@hermes:example.org' # bot
MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_ACCESS_TOKEN='not-for-output'
MATRIX_PASSWORD='also-private'
PRIVATE_KEY='also-private'
ALFRED_MATRIX_USER_ID='@owner:other.example'
"""
        loaded = inspector.parse_selected_env(contents, inspector.PUBLIC_KEYS)
        self.assertEqual(set(loaded), {"MATRIX_USER_ID", "MATRIX_HOMESERVER"})
        self.assertNotIn("not-for-output", json.dumps(inspector.inspect(loaded)))

    def test_home_file_wins_without_merging_other_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "primary", Path(directory) / "legacy"
            first.write_text("MATRIX_USER_ID=@bot:example.org\nMATRIX_ALLOWED_USERS=@a:example.org\n")
            second.write_text("MATRIX_HOMESERVER=https://wrong.example\nMATRIX_ACCESS_TOKEN=wrong\n")
            values, problems = inspector.load_settings({"MATRIX_USER_ID": "@stale:example.org"}, [first, second], True)
            self.assertEqual(values["MATRIX_USER_ID"], "@bot:example.org")
            self.assertNotIn("MATRIX_HOMESERVER", values)
            self.assertNotIn("MATRIX_ACCESS_TOKEN", values)
            self.assertEqual(problems, [])

    def test_profile_selection_and_empty_file_token_do_not_reuse_other_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            paths = inspector.candidate_files({"HERMES_HOME": directory}, Path("/different-home"))
            self.assertEqual(paths, [profile / ".env"])
            paths[0].write_text("\ufeffMATRIX_HOMESERVER=https://active.example.org\nMATRIX_ACCESS_TOKEN=\n")
            values, problems = inspector.load_settings({"MATRIX_HOMESERVER": "https://stale.example.org",
                                                       "MATRIX_ACCESS_TOKEN": "stale-secret"}, paths, True)
            self.assertEqual(values["MATRIX_HOMESERVER"], "https://active.example.org")
            self.assertEqual(values["MATRIX_ACCESS_TOKEN"], "")
            self.assertEqual(problems, [])

    def test_never_infers_bot_from_owner_settings(self):
        result = inspector.inspect({"ALFRED_MATRIX_USER_ID": "@owner:example.org", "ALFRED_MATRIX_HOMESERVER": "https://owner.example.org"})
        self.assertIsNone(result["MATRIX_USER_ID"])
        self.assertIsNone(result["MATRIX_HOMESERVER"])
        self.assertEqual(result["identity_source"], "unresolved")

    def test_encryption_mode_overrides_legacy_boolean(self):
        result = inspector.inspect({"MATRIX_ENCRYPTION": "true", "MATRIX_E2EE_MODE": "off"})
        self.assertFalse(result["MATRIX_ENCRYPTION"])
        self.assertEqual(inspector.inspect({"MATRIX_ENCRYPTION": "true"})["MATRIX_E2EE_MODE"], "required")
        self.assertTrue(inspector.inspect({"MATRIX_E2EE_MODE": "optional"})["MATRIX_ENCRYPTION"])

    def test_public_values_validated_before_output(self):
        result = inspector.inspect({"MATRIX_HOMESERVER": "https://user:password@host/?token=secret", "MATRIX_USER_ID": "private-token", "MATRIX_ALLOWED_USERS": "bad\nSECRET", "MATRIX_DEVICE_ID": "bad\nsecret"})
        output = json.dumps(result)
        self.assertNotIn("password", output)
        self.assertNotIn("private-token", output)
        self.assertNotIn("SECRET", output)
        self.assertIsNone(result["MATRIX_HOMESERVER"])

    def test_whoami_only_uses_bot_token_and_returns_public_user(self):
        calls = []
        def resolve(home, token):
            calls.append((home, token))
            return "@bot:example.org"
        result = inspector.inspect({"MATRIX_HOMESERVER": "https://matrix.example.org", "MATRIX_ACCESS_TOKEN": "bot-secret", "ALFRED_MATRIX_ACCESS_TOKEN": "owner-secret"}, True, resolve)
        self.assertEqual(calls, [("https://matrix.example.org", "bot-secret")])
        self.assertEqual(result["MATRIX_USER_ID"], "@bot:example.org")
        self.assertNotIn("secret", json.dumps(result))

    def test_https_redirect_and_response_errors_do_not_leak(self):
        with self.assertRaises(inspector.LookupError):
            inspector.resolve_bot_user("http://example.org", "secret")
        class Redirect:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 302, "secret-body", {}, None)
        with self.assertRaisesRegex(inspector.LookupError, "^redirect_refused$"):
            inspector.resolve_bot_user("https://example.org", "secret", Redirect())
        self.assertIsNone(inspector.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_whoami_fixture_request_and_sanitized_result(self):
        class Reply:
            def open(self, request, timeout):
                self.request = request
                return io.BytesIO(b'{"user_id":"@bot:example.org","extra":"private"}')
        transport = Reply()
        self.assertEqual(inspector.resolve_bot_user("https://example.org", "fixture-token", transport), "@bot:example.org")
        self.assertEqual(transport.request.get_header("Authorization"), "Bearer fixture-token")

    def test_env_template_never_reuses_bot_credentials_or_trusts_discovery(self):
        result = inspector.inspect({
            "MATRIX_USER_ID": "@bot:example.org", "MATRIX_DEVICE_ID": "BOT-DEVICE",
            "MATRIX_ACCESS_TOKEN": "do-not-export", "MATRIX_HOMESERVER": "https://bot.example.org",
            "MATRIX_ALLOWED_USERS": "@owner:other.example", "MATRIX_ALLOWED_ROOMS": "!room:example.org",
        })
        sender = inspector.select_sender(result)
        self.assertEqual(sender, "@owner:other.example")
        output = inspector.alfred_env(result, sender, homeserver="https://sender.example.org",
                                     pins=[{"userId": "@bot:example.org", "deviceId": "BOT-DEVICE", "ed25519": "public"}])
        active = inspector.parse_selected_env(output, frozenset({
            "ALFRED_MATRIX_ENABLED", "ALFRED_MATRIX_USER_ID", "ALFRED_MATRIX_HERMES_USER_ID",
            "ALFRED_MATRIX_DEVICE_ID", "ALFRED_MATRIX_ACCESS_TOKEN", "ALFRED_DEVICE_TOKEN",
            "ALFRED_MATRIX_TRUSTED_DEVICES", "ALFRED_MATRIX_HOMESERVER", "ALFRED_MATRIX_ROOM_ID",
        }))
        self.assertEqual(active, {
            "ALFRED_MATRIX_ENABLED": "false", "ALFRED_MATRIX_USER_ID": "@owner:other.example",
            "ALFRED_MATRIX_HERMES_USER_ID": "@bot:example.org",
            "ALFRED_MATRIX_HOMESERVER": "https://sender.example.org", "ALFRED_MATRIX_ROOM_ID": "!room:example.org",
        })
        self.assertNotIn("do-not-export", output)
        self.assertIn("# ALFRED_MATRIX_TRUSTED_DEVICES=", output)

    def test_token_device_takes_precedence_over_configured_device(self):
        result = inspector.inspect({"MATRIX_DEVICE_ID": "STALE"}, True,
                                   lambda *_: {"user_id": "@bot:example.org", "device_id": "CURRENT"})
        self.assertEqual(result["MATRIX_DEVICE_ID"], "CURRENT")
        self.assertEqual(result["device_identity_source"], "bot_token_whoami")
        output = inspector.alfred_env(result)
        self.assertIn('Hermes token device (not Alfred\'s sender device): "CURRENT"', output)
        self.assertNotIn("\nALFRED_MATRIX_DEVICE_ID=", output)

    def test_ambiguous_sender_room_and_invalid_sender_not_silently_chosen(self):
        result = inspector.inspect({"MATRIX_USER_ID": "@bot:example.org",
                                    "MATRIX_ALLOWED_USERS": "@one:example.org,@two:example.org",
                                    "MATRIX_ALLOWED_ROOMS": "!one:example.org,!two:example.org"})
        self.assertIsNone(inspector.select_sender(result))
        for supplied in ("@bot:example.org", "not-a-user"):
            with self.assertRaises(inspector.LookupError):
                inspector.select_sender(result, supplied)
        output = inspector.alfred_env(result)
        self.assertNotIn("\nALFRED_MATRIX_USER_ID=", output)
        self.assertNotIn("\nALFRED_MATRIX_ROOM_ID=", output)
        self.assertIn("ALFRED_MATRIX_ROOM_ID='!chosen:example.org'", inspector.alfred_env(result, room="!chosen:example.org"))

    def test_env_template_cannot_execute_or_expand_metadata(self):
        result = inspector.inspect({"MATRIX_USER_ID": "@bot:example.org"})
        output = inspector.alfred_env(result, sender="@x'$(command):example.org", room="!room:$SECRET")
        self.assertNotIn("$(command)", output)
        self.assertNotIn("$SECRET", output)
        self.assertNotIn("\nALFRED_MATRIX_USER_ID=", output)

    def test_sender_discovery_sends_no_bot_credentials_and_refuses_bad_server_names(self):
        class Reply:
            def open(self, request, timeout):
                self.request = request
                return io.BytesIO(b'{"m.homeserver":{"base_url":"https://sender.example.org/"}}')
        transport = Reply()
        self.assertEqual(inspector.discover_homeserver("@owner:example.org", transport), "https://sender.example.org")
        self.assertEqual(transport.request.full_url, "https://example.org/.well-known/matrix/client")
        self.assertIsNone(transport.request.get_header("Authorization"))
        for user in ("@owner:host/path", "@owner:user@host", "@owner:host?secret", "@owner:host#secret"):
            with self.assertRaises(inspector.LookupError):
                inspector.discover_homeserver(user, transport)
        class Redirect:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 302, "private", {}, None)
        with self.assertRaisesRegex(inspector.LookupError, "^sender_homeserver_discovery_unavailable$"):
            inspector.discover_homeserver("@owner:example.org", Redirect())

    def test_device_query_only_reads_keys_and_validates_returned_identity(self):
        fingerprint = base64.b64encode(bytes(range(32))).decode().rstrip("=")
        entry = {"user_id": "@bot:example.org", "device_id": "BOT",
                 "keys": {"ed25519:BOT": fingerprint}}
        class Reply:
            def open(self, request, timeout):
                self.request = request
                return io.BytesIO(json.dumps({"device_keys": {"@bot:example.org": {"BOT": entry}}}).encode())
        transport = Reply()
        pins = inspector.query_devices("https://example.org", "private-token", ["@bot:example.org"], transport)
        self.assertEqual(pins, [{"userId": "@bot:example.org", "deviceId": "BOT", "ed25519": fingerprint}])
        self.assertTrue(transport.request.full_url.endswith("/_matrix/client/v3/keys/query"))
        self.assertEqual(json.loads(transport.request.data), {"device_keys": {"@bot:example.org": []}})
        self.assertNotIn("private-token", json.dumps(pins))
        entry["user_id"] = "@other:example.org"
        with self.assertRaisesRegex(inspector.LookupError, "^invalid_device_keys_response$"):
            inspector.query_devices("https://example.org", "private-token", ["@bot:example.org"], transport)


if __name__ == "__main__":
    unittest.main()
