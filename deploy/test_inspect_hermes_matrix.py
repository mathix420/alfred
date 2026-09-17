"""Hermes inspection fixtures only: never reads real credentials or connects."""
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

    def test_environment_wins_without_merging_other_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "primary", Path(directory) / "legacy"
            first.write_text("MATRIX_USER_ID=@bot:example.org\nMATRIX_ALLOWED_USERS=@a:example.org\n")
            second.write_text("MATRIX_HOMESERVER=https://wrong.example\nMATRIX_ACCESS_TOKEN=wrong\n")
            values, problems = inspector.load_settings({"MATRIX_USER_ID": "@newbot:example.org"}, [first, second], True)
            self.assertEqual(values["MATRIX_USER_ID"], "@newbot:example.org")
            self.assertNotIn("MATRIX_HOMESERVER", values)
            self.assertNotIn("MATRIX_ACCESS_TOKEN", values)
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


if __name__ == "__main__":
    unittest.main()
