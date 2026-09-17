"""Offline protocol, encryption and durability regressions; no network clients are started."""
import asyncio
import io
import json
import sqlite3
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
        self.content = {"msgtype": "m.audio", "body": "Voice message", "file": {
            "url": "mxc://example.test/encrypted-upload", "key": {"k": "fixture-attachment-key"},
            "iv": "fixture-iv", "hashes": {"sha256": "fixture-hash"}, "v": "v2",
        }}

    def tearDown(self):
        self.journal.db.close()
        self.directory.cleanup()

    def reopen(self):
        self.journal.db.close()
        self.journal = Journal(self.path)

    def test_pending_upload_content_survives_restart_before_send_ack(self):
        first = self.journal.register("transaction-a", "audio-hash-a")
        created = first["created_at"]
        self.journal.content("transaction-a", self.content)
        self.reopen()
        recovered = self.journal.register("transaction-a", "audio-hash-a")
        self.assertEqual(recovered["id"], "transaction-a")
        self.assertEqual(recovered["created_at"], created)
        self.assertIsNone(recovered["event_id"])
        self.assertEqual(json.loads(recovered["content"]), self.content)
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM deliveries").fetchone()[0], 1)

    def test_sent_receipt_and_transaction_are_durable_and_idempotent(self):
        self.journal.register("transaction-a", "audio-hash-a")
        self.journal.content("transaction-a", self.content)
        self.journal.sent("transaction-a", "$matrix-event-a")
        self.reopen()
        for _ in range(3):
            recovered = self.journal.register("transaction-a", "audio-hash-a")
            self.assertEqual(recovered["event_id"], "$matrix-event-a")
            self.assertEqual(json.loads(recovered["content"]), self.content)
        self.journal.register("transaction-b", "audio-hash-b")
        with self.assertRaises(sqlite3.IntegrityError):
            self.journal.sent("transaction-b", "$matrix-event-a")
        self.assertIsNone(self.journal.job("transaction-b")["event_id"])
        self.assertEqual(self.journal.job("transaction-a")["event_id"], "$matrix-event-a")

    def test_reused_transaction_rejects_different_audio_after_restart(self):
        self.journal.register("transaction-a", "audio-hash-a")
        self.journal.content("transaction-a", self.content)
        self.journal.sent("transaction-a", "$matrix-event-a")
        self.reopen()
        with self.assertRaises(BridgeError) as caught:
            self.journal.register("transaction-a", "different-audio-hash")
        self.assertEqual(caught.exception.code, "request_conflict")
        original = self.journal.job("transaction-a")
        self.assertEqual(original["audio_hash"], "audio-hash-a")
        self.assertEqual(original["event_id"], "$matrix-event-a")
        self.assertEqual(json.loads(original["content"]), self.content)

    def test_legacy_reply_state_is_removed_without_losing_sent_receipts(self):
        legacy_path = Path(self.directory.name) / "legacy.sqlite"
        legacy = sqlite3.connect(legacy_path)
        legacy.executescript("""
            CREATE TABLE deliveries (
                id TEXT PRIMARY KEY, audio_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
                content TEXT, event_id TEXT UNIQUE, reply TEXT
            );
            CREATE TABLE replies (event_id TEXT PRIMARY KEY, job_id TEXT, body TEXT, sequence INTEGER);
            CREATE TABLE inbox (event_id TEXT PRIMARY KEY, payload TEXT);
            CREATE TABLE seen_events (event_id TEXT PRIMARY KEY);
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO replies VALUES ('$incoming', 'transaction-a', 'old received message', 1);
            INSERT INTO inbox VALUES ('$buffered', 'old buffered message');
            INSERT INTO seen_events VALUES ('$incoming');
            INSERT INTO metadata VALUES ('sync_cursor', 'old-cursor');
        """)
        legacy.execute("INSERT INTO deliveries VALUES (?,?,?,?,?,?)", (
            "transaction-a", "audio-hash-a", 123456, json.dumps(self.content),
            "$matrix-event-a", "old received message",
        ))
        legacy.commit()
        legacy.close()
        migrated = Journal(legacy_path)
        try:
            row = migrated.job("transaction-a")
            self.assertEqual(row["audio_hash"], "audio-hash-a")
            self.assertEqual(row["created_at"], 123456)
            self.assertEqual(row["event_id"], "$matrix-event-a")
            self.assertEqual(json.loads(row["content"]), self.content)
            if "reply" in row.keys():
                self.assertIsNone(row["reply"])
            tables = {row[0] for row in migrated.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue(tables.isdisjoint({"replies", "inbox", "seen_events", "metadata"}))
            self.assertEqual(migrated.register("transaction-a", "audio-hash-a")["event_id"], "$matrix-event-a")
        finally:
            migrated.db.close()


if __name__ == "__main__":
    unittest.main()
