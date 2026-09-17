"""Provisioning contract tests; all Matrix responses are local fixtures."""
import argparse
import base64
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("provision", Path(__file__).with_name("provision.py"))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)

FINGERPRINT = base64.b64encode(bytes(range(32))).decode().rstrip("=")
OWN = "@pocket:example.org"
HERMES = "@hermes:example.org"
TOKEN = "secret-not-for-stdout"
PIN = {"userId": HERMES, "deviceId": "HERMES", "ed25519": FINGERPRINT}


class FakeAPI:
    def __init__(self, homeserver="https://matrix.example.org", flows=None, fail_keys=False):
        self.homeserver = homeserver
        self.flows = ["m.login.password"] if flows is None else flows
        self.fail_keys = fail_keys
        self.calls = []

    def request(self, method, path, body=None, token=None):
        self.calls.append((method, path, body, token))
        if path.endswith("/login") and method == "GET":
            return {"flows": [{"type": flow} for flow in self.flows]}
        if path.endswith("/login"):
            return {"user_id": OWN, "device_id": "FRESH", "access_token": TOKEN}
        if path.endswith("/whoami"):
            return {"user_id": OWN, "device_id": "FRESH"}
        if path.endswith("/keys/query"):
            if self.fail_keys:
                raise provision.SetupError("Simulated key query failure.")
            return {"device_keys": {OWN: {}, HERMES: {"HERMES": {
                "user_id": HERMES, "device_id": "HERMES",
                "keys": {"ed25519:HERMES": FINGERPRINT},
            }}}}
        raise AssertionError(path)


def args(output=None, command="inspect"):
    return argparse.Namespace(command=command, homeserver="https://matrix.example.org",
                              user=OWN, hermes_user=HERMES, room="!room:example.org",
                              output=output, no_generate_secrets=False)


class ProvisionTests(unittest.TestCase):
    def test_https_and_credentials_validation(self):
        for url in ("http://matrix.example.org", "https://token@matrix.example.org", "https://host/?token=secret", "https://host/#x", "https://host\n.evil"):
            with self.assertRaises(provision.SetupError):
                provision.homeserver_url(url)
        self.assertEqual(provision.homeserver_url("https://matrix.example.org/"), "https://matrix.example.org")
        self.assertIsNone(provision.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example"))

    def test_password_login_never_reuses_device(self):
        api = FakeAPI()
        result = provision.password_login(api, OWN, "hidden-password", ["m.login.password"])
        self.assertEqual(result["device_id"], "FRESH")
        request = api.calls[0][2]
        self.assertEqual(request["initial_device_display_name"], "Alfred Pocket")
        self.assertNotIn("device_id", request)
        self.assertFalse(request["refresh_token"])

    def test_unsupported_login_does_not_prompt_password_or_write(self):
        api = FakeAPI(flows=["m.login.sso"])
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "setup.env")
            with self.assertRaisesRegex(provision.SetupError, "SSO"):
                provision.run(args(target, "password-login"), lambda _: api,
                              hidden=lambda _: self.fail("Password must not be requested"), say=lambda _: None)
            self.assertFalse(Path(target).exists())
            self.assertEqual(len(api.calls), 1)

    def test_diagnostic_does_not_print_token_or_trust(self):
        output = []
        provision.run(args(), lambda _: FakeAPI(), hidden=lambda _: TOKEN, say=output.append,
                      ask=lambda _: self.fail("Diagnostic must not alter trust"), environment={})
        self.assertNotIn(TOKEN, "\n".join(output))
        self.assertIn(FINGERPRINT, "\n".join(output))
        self.assertIn("no devices were trusted", output[-1])

    def test_verified_pin_private_file_and_secrets(self):
        output = []
        answers = iter(["1", FINGERPRINT])
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "setup.env")
            provision.run(args(target, "password-login"), lambda _: FakeAPI(), hidden=lambda _: "password",
                          ask=lambda _: next(answers), say=output.append, environment={})
            content = Path(target).read_text()
            self.assertEqual(stat.S_IMODE(Path(target).stat().st_mode), 0o600)
            self.assertIn("ALFRED_MATRIX_ENABLED='true'", content)
            self.assertIn("ALFRED_MATRIX_ACCESS_TOKEN='" + TOKEN + "'", content)
            self.assertNotIn("ALFRED_DEVICE_TOKEN=''", content)
            self.assertNotIn("ALFRED_MATRIX_PICKLE_KEY=''", content)
            self.assertNotIn(TOKEN, "\n".join(output))
            with self.assertRaises(provision.SetupError):
                provision.PrivateFile(target)
            self.assertEqual(Path(target).read_text(), content)

    def test_new_session_saved_before_later_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "setup.env")
            with self.assertRaisesRegex(provision.SetupError, "query failure"):
                provision.run(args(target, "password-login"), lambda _: FakeAPI(fail_keys=True),
                              hidden=lambda _: "password", say=lambda _: None, environment={})
            content = Path(target).read_text()
            self.assertIn(TOKEN, content)
            self.assertIn("ALFRED_MATRIX_ENABLED='false'", content)

    def test_discovery_does_not_enable_without_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "setup.env")
            provision.run(args(target), lambda _: FakeAPI(), hidden=lambda _: TOKEN,
                          ask=lambda _: "", say=lambda _: None, environment={})
            self.assertIn("ALFRED_MATRIX_ENABLED='false'", Path(target).read_text())
            self.assertIn("ALFRED_MATRIX_TRUSTED_DEVICES='[]'", Path(target).read_text())

    def test_pin_mismatch_rejected(self):
        answers = iter(["1", base64.b64encode(bytes(32)).decode()])
        with self.assertRaisesRegex(provision.SetupError, "did not match"):
            provision.select_pins([PIN], ask=lambda _: next(answers), say=lambda _: None)
        answers = iter(["1", " ".join(FINGERPRINT[i:i + 4] for i in range(0, len(FINGERPRINT), 4))])
        self.assertEqual(provision.select_pins([PIN], ask=lambda _: next(answers), say=lambda _: None), [PIN])

    def test_private_file_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original"
            original.write_text("untouched")
            link = Path(directory) / "link"
            link.symlink_to(original)
            with self.assertRaises(provision.SetupError):
                provision.PrivateFile(str(link))
            self.assertEqual(original.read_text(), "untouched")

    def test_env_injection_and_preservation(self):
        for value in ("x\nALFRED_MATRIX_ENABLED=true", "x'", "$EXPANDED", "\0"):
            with self.assertRaises(provision.SetupError):
                provision.env_text({"ALFRED_DEVICE_TOKEN": value})
        env = {"ALFRED_DEVICE_TOKEN": "existing-device-secret", "ALFRED_MATRIX_PICKLE_KEY": "existing-pickle"}
        result = provision.base_config("https://example.org", {"user_id": OWN, "device_id": "D", "access_token": TOKEN}, HERMES, "", True, env)
        for key, value in env.items():
            self.assertEqual(result[key], value)


if __name__ == "__main__":
    unittest.main()
