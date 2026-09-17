"""Offline protocol, encryption and durability regressions; no network clients are started."""
import asyncio
import io
import tempfile
import unittest
import wave
from pathlib import Path

from worker import BridgeError, Journal, load_pins, voice_content, wav_bytes


class VoiceTests(unittest.TestCase):
    def test_wav_exact_pcm_and_bounds(self):
        pcm = b"\x00\x01\x02\x03" * 80
        with wave.open(io.BytesIO(wav_bytes(pcm))) as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 16000))
            self.assertEqual(audio.readframes(1000), pcm)
        for bad in (b"", b"1", bytes(960002)):
            with self.assertRaises(BridgeError):
                wav_bytes(bad)

    def test_attachment_encryption_roundtrip(self):
        try:
            from nio.crypto.attachments import encrypt_attachment, decrypt_attachment
        except ImportError:
            self.skipTest("Install pinned matrix/requirements.txt to exercise real encryption")
        raw = wav_bytes(bytes(320))
        encrypted, info = encrypt_attachment(raw)
        self.assertNotEqual(encrypted, raw)
        content = voice_content(info, "mxc://example.test/media", len(raw), 10, "@hermes:example.test")
        self.assertNotIn("url", content)
        self.assertEqual(content["file"]["url"], "mxc://example.test/media")
        self.assertEqual(content["m.mentions"]["user_ids"], ["@hermes:example.test"])
        self.assertEqual(content["org.matrix.msc3245.voice"], {})
        self.assertEqual(decrypt_attachment(encrypted, info["key"]["k"], info["hashes"]["sha256"], info["iv"]), raw)
        with self.assertRaises(Exception):
            decrypt_attachment(encrypted[:-1] + bytes([encrypted[-1] ^ 1]), info["key"]["k"], info["hashes"]["sha256"], info["iv"])

    def test_fail_closed_attachment_and_pins(self):
        with self.assertRaises(BridgeError):
            voice_content({}, "https://example.test/plain", 1, 1, "@h:example.test")
        for invalid in ('[]', '{}', '[{"userId":"@h:example.test","deviceId":"D","ed25519":"bad"}]'):
            with self.assertRaises(BridgeError):
                load_pins(invalid, "@u:example.test", "@h:example.test")
        import json
        pin = {"userId": "@h:example.test", "deviceId": "D", "ed25519": "a" * 43}
        self.assertEqual(load_pins(json.dumps([pin]), "@u:example.test", "@h:example.test"), {("@h:example.test", "D"): "a" * 43})

    def test_real_nio_identity_persists_offline(self):
        try:
            from nio import AsyncClient, AsyncClientConfig
            from nio.store import SqliteStore
        except ImportError:
            self.skipTest("Install pinned matrix/requirements.txt to exercise crypto store")
        with tempfile.TemporaryDirectory() as directory:
            keys = []
            for _ in range(2):
                client = AsyncClient("https://example.test", "@u:example.test", device_id="DEDICATED", store_path=directory,
                    config=AsyncClientConfig(encryption_enabled=True, store=SqliteStore, pickle_key="offline-test-key", store_sync_tokens=False))
                client.restore_login("@u:example.test", "DEDICATED", "not-a-real-token")
                keys.append(client.olm.account.identity_keys["ed25519"])
                asyncio.run(client.close())
            self.assertEqual(keys[0], keys[1])


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "journal.sqlite"
        self.journal = Journal(self.path)
        self.journal.register("job-a", "hash-a")
        self.journal.sent("job-a", "$sent-a")
        self.journal.register("job-b", "hash-b")
        self.journal.sent("job-b", "$sent-b")

    def tearDown(self):
        self.journal.db.close()
        self.directory.cleanup()

    def accept(self, event="$reply-a", body="Answer", relation=None, **changes):
        args = dict(room_id="!room:example.test", sender="@h:example.test", event_id=event,
            content={"msgtype": "m.text", "body": body, "m.relates_to": relation or {"m.in_reply_to": {"event_id": "$sent-a"}}},
            decrypted=True, verified=True, expected_room="!room:example.test", expected_sender="@h:example.test")
        args.update(changes)
        return self.journal.accept_reply(**args)

    def test_sender_room_encryption_verification_and_relation_required(self):
        for change in ({"sender": "@other:example.test"}, {"room_id": "!other:example.test"}, {"decrypted": False}, {"verified": False}):
            self.assertIsNone(self.accept(**change))
        self.assertIsNone(self.accept(relation={"event_id": "$sent-a"}))
        self.assertIsNone(self.accept(relation={"rel_type": "m.thread", "event_id": "$sent-a", "m.in_reply_to": {"event_id": "$sent-b"}}))
        self.assertIsNone(self.journal.job("job-a")["reply"])

    def test_thread_followup_and_edit_are_durable_idempotent(self):
        first = self.accept(relation={"rel_type": "m.thread", "event_id": "$sent-a"})
        self.assertEqual(first["jobId"], "job-a")
        self.assertIsNone(self.accept())
        second = self.accept(event="$reply-b", body="Second part", relation={"m.in_reply_to": {"event_id": "$reply-a"}})
        self.assertEqual(second["text"], "Answer\n\nSecond part")
        edited = self.accept(event="$edit", content={"msgtype": "m.text", "body": "* Correction", "m.relates_to": {"rel_type": "m.replace", "event_id": "$reply-a"}, "m.new_content": {"msgtype": "m.text", "body": "Correction"}})
        self.assertEqual(edited["text"], "Correction\n\nSecond part")
        self.journal.save_cursor("cursor-after-durable-handling")
        self.journal.db.close()
        self.journal = Journal(self.path)
        self.assertEqual(self.journal.cursor(), "cursor-after-durable-handling")
        self.assertEqual(self.journal.job("job-a")["reply"], "Correction\n\nSecond part")
        with self.assertRaises(BridgeError):
            self.journal.register("job-a", "different-audio")

    def test_reply_before_send_ack_survives_restart(self):
        content = {"msgtype": "m.text", "body": "Recovered", "m.relates_to": {"m.in_reply_to": {"event_id": "$future"}}}
        args = ("!room:example.test", "@h:example.test", "$early", content, True, True)
        self.journal.remember(args)
        self.assertIsNone(self.journal.accept_reply(*args, "!room:example.test", "@h:example.test"))
        self.journal.db.close()
        self.journal = Journal(self.path)
        self.journal.register("job-c", "hash-c")
        self.journal.sent("job-c", "$future")
        buffered = self.journal.buffered()
        self.assertEqual(len(buffered), 1)
        reply = self.journal.accept_reply(*buffered[0], "!room:example.test", "@h:example.test")
        self.assertEqual(reply["jobId"], "job-c")
        self.assertEqual(self.journal.buffered(), [])

    def test_audio_reply_returns_explicit_notice(self):
        result = self.accept(content={"msgtype": "m.audio", "body": "reply.ogg", "m.relates_to": {"m.in_reply_to": {"event_id": "$sent-a"}}})
        self.assertIn("Open Beeper to listen", result["text"])


if __name__ == "__main__":
    unittest.main()
