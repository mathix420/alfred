"""Encrypted Matrix voice transport. Private JSON-lines IPC; never logs room bodies.

One process owns one persistent nio crypto store. Authentication tokens are passed
through the environment, never command-line arguments. Importing this module does
not initialize a Matrix client or make network requests.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import wave

MAX_PCM_BYTES = 960000
ROOM_AUDIO_TYPE = "m.audio"


class BridgeError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def emit(message: dict) -> None:
    print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def load_pins(raw: str, own_user: str, hermes_user: str) -> dict[tuple[str, str], str]:
    try:
        entries = json.loads(raw)
        if not isinstance(entries, list) or not 1 <= len(entries) <= 64:
            raise ValueError()
        pins: dict[tuple[str, str], str] = {}
        for item in entries:
            if not isinstance(item, dict):
                raise ValueError()
            user, device, fingerprint = item["userId"], item["deviceId"], item["ed25519"]
            if user not in (own_user, hermes_user) or not isinstance(device, str) or not device:
                raise ValueError()
            if not isinstance(fingerprint, str) or not re.fullmatch(r"[A-Za-z0-9+/]{43}=*", fingerprint):
                raise ValueError()
            if (user, device) in pins:
                raise ValueError()
            pins[(user, device)] = fingerprint.rstrip("=")
        if not any(user == hermes_user for user, _ in pins):
            raise ValueError()
        return pins
    except (ValueError, TypeError, KeyError):
        raise BridgeError("matrix_trust_configuration") from None


def wav_bytes(pcm: bytes) -> bytes:
    if not pcm or len(pcm) % 2 or len(pcm) > MAX_PCM_BYTES:
        raise BridgeError("audio_format")
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(pcm)
    return output.getvalue()


def voice_content(file_info: dict, uri: str, size: int, duration_ms: int, hermes: str) -> dict:
    if not isinstance(file_info, dict) or not uri.startswith("mxc://"):
        raise BridgeError("matrix_attachment_invalid")
    if file_info.get("v") != "v2" or not all(key in file_info for key in ("key", "iv", "hashes")):
        raise BridgeError("matrix_attachment_invalid")
    return {
        "msgtype": ROOM_AUDIO_TYPE,
        "body": "Voice message",
        "filename": "voice.wav",
        "info": {"mimetype": "audio/wav", "size": size, "duration": duration_ms},
        "file": {**file_info, "url": uri},
        "org.matrix.msc3245.voice": {},
        "org.matrix.msc1767.audio": {"duration": duration_ms},
        "m.mentions": {"user_ids": [hermes]},
    }


class Journal:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS deliveries (
            id TEXT PRIMARY KEY, audio_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
            content TEXT, event_id TEXT UNIQUE, reply TEXT
          );
          CREATE TABLE IF NOT EXISTS replies (
            event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL, sequence INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS seen_events (event_id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS inbox (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        """)

    def cursor(self):
        row = self.db.execute("SELECT value FROM metadata WHERE key='sync_cursor'").fetchone()
        return row["value"] if row else None

    def save_cursor(self, token: str):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('sync_cursor',?)", (token,))

    def remember(self, args: tuple):
        # A verified reply may arrive before room_send returns its event ID.
        if not args[4] or not args[5]:
            return
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO inbox(event_id,payload) VALUES(?,?)", (args[2], json.dumps(args)))
            self.db.execute("DELETE FROM inbox WHERE rowid NOT IN (SELECT rowid FROM inbox ORDER BY rowid DESC LIMIT 2000)")

    def buffered(self):
        return [json.loads(row["payload"]) for row in self.db.execute("SELECT payload FROM inbox ORDER BY rowid")]

    def oldest_pending(self):
        row = self.db.execute("SELECT min(created_at) AS created_at FROM deliveries WHERE reply IS NULL").fetchone()
        return row["created_at"]

    def job(self, job_id: str):
        return self.db.execute("SELECT * FROM deliveries WHERE id=?", (job_id,)).fetchone()

    def register(self, job_id: str, digest: str):
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO deliveries(id,audio_hash,created_at) VALUES(?,?,?)", (job_id, digest, int(time.time() * 1000)))
        row = self.job(job_id)
        if row["audio_hash"] != digest:
            raise BridgeError("request_conflict")
        return row

    def content(self, job_id: str, content: dict) -> None:
        with self.db:
            self.db.execute("UPDATE deliveries SET content=? WHERE id=?", (json.dumps(content), job_id))

    def sent(self, job_id: str, event_id: str) -> None:
        with self.db:
            self.db.execute("UPDATE deliveries SET event_id=? WHERE id=?", (event_id, job_id))

    def correlate(self, relation: dict) -> tuple[str, str | None] | None:
        if not isinstance(relation, dict):
            return None
        if relation.get("rel_type") == "m.replace":
            target = relation.get("event_id")
            row = self.db.execute("SELECT job_id FROM replies WHERE event_id=?", (target,)).fetchone()
            return (row["job_id"], target) if row else None
        references = []
        if relation.get("rel_type") == "m.thread":
            references.append(relation.get("event_id"))
        reply_to = relation.get("m.in_reply_to")
        if isinstance(reply_to, dict):
            references.append(reply_to.get("event_id"))
        matches = set()
        for reference in references:
            if not isinstance(reference, str):
                continue
            row = self.db.execute("SELECT id FROM deliveries WHERE event_id=?", (reference,)).fetchone()
            if row:
                matches.add(row["id"])
            row = self.db.execute("SELECT job_id FROM replies WHERE event_id=?", (reference,)).fetchone()
            if row:
                matches.add(row["job_id"])
        return (next(iter(matches)), None) if len(matches) == 1 else None

    def accept_reply(self, room_id: str, sender: str, event_id: str, content: dict,
                     decrypted: bool, verified: bool, expected_room: str, expected_sender: str):
        if room_id != expected_room or sender != expected_sender or not decrypted or not verified:
            return None
        if not isinstance(content, dict) or content.get("msgtype") not in ("m.text", "m.audio"):
            return None
        if self.db.execute("SELECT 1 FROM seen_events WHERE event_id=?", (event_id,)).fetchone():
            return None
        relation = content.get("m.relates_to", {})
        match = self.correlate(relation)
        if not match:
            return None
        job_id, edit_target = match
        payload = content.get("m.new_content", {}) if edit_target else content
        body = payload.get("body") if isinstance(payload, dict) else None
        if content.get("msgtype") == "m.audio":
            caption = body.strip() if isinstance(body, str) else ""
            body = "Hermes sent a voice reply. Open Beeper to listen." + ("\n\n" + caption if caption and len(caption) <= 2000 else "")
        if not isinstance(body, str) or not body.strip() or len(body) > 16000:
            return None
        if body.startswith("> ") and "\n\n" in body:
            body = body.split("\n\n", 1)[1]
        if not body.strip():
            return None
        with self.db:
            self.db.execute("INSERT INTO seen_events(event_id) VALUES(?)", (event_id,))
            if edit_target:
                self.db.execute("UPDATE replies SET body=? WHERE event_id=? AND job_id=?", (body, edit_target, job_id))
            else:
                self.db.execute("INSERT INTO replies(event_id,job_id,body,sequence) VALUES(?,?,?,?)", (event_id, job_id, body, time.time_ns()))
            parts = self.db.execute("SELECT body FROM replies WHERE job_id=? ORDER BY sequence", (job_id,)).fetchall()
            text = "\n\n".join(row["body"] for row in parts)[-32000:]
            self.db.execute("UPDATE deliveries SET reply=? WHERE id=?", (text, job_id))
            self.db.execute("DELETE FROM inbox WHERE event_id=?", (event_id,))
        return {"type": "reply", "jobId": job_id, "eventId": event_id, "text": text}


class Worker:
    def __init__(self):
        self.home = os.environ["ALFRED_MATRIX_HOMESERVER"].rstrip("/")
        self.user = os.environ["ALFRED_MATRIX_USER_ID"]
        self.device = os.environ["ALFRED_MATRIX_DEVICE_ID"]
        self.token = os.environ["ALFRED_MATRIX_ACCESS_TOKEN"]
        self.hermes = os.environ["ALFRED_MATRIX_HERMES_USER_ID"]
        self.room = os.environ["ALFRED_MATRIX_ROOM_ID"]
        self.pickling = os.environ["ALFRED_MATRIX_PICKLE_KEY"]
        if not self.home.startswith("https://") or self.user == self.hermes or not self.pickling:
            raise BridgeError("matrix_configuration")
        self.pins = load_pins(os.environ["ALFRED_MATRIX_TRUSTED_DEVICES"], self.user, self.hermes)
        self.store = Path(os.environ["ALFRED_MATRIX_STORE_DIR"]).resolve()
        self.voice_directory = Path(os.environ["ALFRED_POCKET_VOICE_DIR"]).resolve()
        self.store.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.store, 0o700)
        # A second process must not open this Olm/Megolm identity concurrently.
        import fcntl
        self.lock = open(self.store / "worker.lock", "a", encoding="utf8")
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BridgeError("matrix_store_locked") from None
        self.journal = Journal(self.store / "delivery.sqlite")
        self.client = None
        self.processing: set[str] = set()
        self.serial = asyncio.Lock()
        self.recent: list[tuple] = []
        self.tasks: set[asyncio.Task] = set()

    async def start(self):
        from nio import AsyncClient, AsyncClientConfig, Event, ErrorResponse, SyncResponse
        from nio.store import SqliteStore
        import aiohttp
        # Resolve account identity and the *existing* device identity before uploading keys.
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + self.token},
                                        timeout=aiohttp.ClientTimeout(total=30)) as http:
            async with http.get(self.home + "/_matrix/client/v3/account/whoami") as response:
                if response.status != 200:
                    raise BridgeError("matrix_authentication")
                identity = await response.json()
            if identity.get("user_id") != self.user or identity.get("device_id") != self.device:
                raise BridgeError("matrix_identity_mismatch")
            async with http.post(self.home + "/_matrix/client/v3/keys/query",
                                 json={"device_keys": {self.user: [self.device]}}) as response:
                if response.status != 200:
                    raise BridgeError("matrix_key_query")
                remote = await response.json()
        remote_key = remote.get("device_keys", {}).get(self.user, {}).get(self.device, {}).get("keys", {}).get("ed25519:" + self.device)
        class BoundedClient(AsyncClient):
            async def sync(inner, *args, **kwargs):
                # nio disables HTTP timeout for its first sync; bound every replay.
                try:
                    return await asyncio.wait_for(super().sync(*args, **kwargs), timeout=65)
                except asyncio.TimeoutError:
                    raise BridgeError("matrix_sync_timeout") from None

        config = AsyncClientConfig(encryption_enabled=True, store=SqliteStore, store_sync_tokens=False,
                                   pickle_key=self.pickling, max_timeouts=2, max_limit_exceeded=2, request_timeout=30)
        self.client = BoundedClient(self.home, self.user, device_id=self.device, store_path=str(self.store), config=config)
        self.client.restore_login(self.user, self.device, self.token)
        if not self.client.olm or not self.client.store:
            raise BridgeError("matrix_encryption_unavailable")
        local_key = self.client.olm.account.identity_keys["ed25519"]
        if remote_key and remote_key != local_key:
            raise BridgeError("matrix_crypto_store_mismatch")
        emit({"type": "identity", "deviceId": self.device, "ed25519": local_key})
        self.client.add_event_callback(self.on_event, Event)
        cursor = self.journal.cursor()
        # Bootstrap room state and verify pinned devices before processing any timeline.
        response = await asyncio.wait_for(self.client.sync(timeout=0, full_state=True,
            sync_filter={"room": {"rooms": [self.room], "timeline": {"limit": 0}}}), timeout=60)
        if not isinstance(response, SyncResponse):
            raise BridgeError("matrix_sync_failed")
        if self.room not in self.client.rooms or not self.client.rooms[self.room].encrypted:
            raise BridgeError("matrix_room_not_encrypted")
        await self.ensure_trust()
        if self.client.should_upload_keys:
            from nio import KeysUploadResponse
            if not isinstance(await self.client.keys_upload(), KeysUploadResponse):
                raise BridgeError("matrix_keys_upload_failed")
        # nio saves its cursor before callbacks; our cursor advances only after journaling.
        self.client.next_batch = cursor
        self.client.loaded_sync_token = None
        self.client.add_response_callback(self.on_sync, SyncResponse)
        async def reject_sync_error(_response):
            # sync_forever otherwise keeps HTTP error responses in a busy loop.
            raise BridgeError("matrix_sync_failed")
        self.client.add_response_callback(reject_sync_error, ErrorResponse)
        emit({"type": "ready"})
        sync = asyncio.create_task(self.client.sync_forever(timeout=30000, since=cursor,
            sync_filter={"room": {"rooms": [self.room], "timeline": {"limit": 100}}}))
        commands = asyncio.create_task(self.commands())
        try:
            done, _ = await asyncio.wait((sync, commands), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if sync in done:
                raise BridgeError("matrix_sync_stopped")
        finally:
            sync.cancel()
            commands.cancel()
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(sync, commands, *self.tasks, return_exceptions=True)
            await self.client.close()
            self.journal.db.close()

    async def on_sync(self, response):
        # Limited timelines can omit a reply while offline. Read backwards to the
        # oldest pending request before committing the cursor (bounded to 2,000 events).
        from nio import RoomMessagesResponse
        joined = response.rooms.join.get(self.room)
        oldest = self.journal.oldest_pending()
        if joined and joined.timeline.limited and oldest is not None:
            token = joined.timeline.prev_batch
            collected = []
            complete = False
            for _ in range(20):
                history = await asyncio.wait_for(self.client.room_messages(self.room, start=token, limit=100), timeout=60)
                if not isinstance(history, RoomMessagesResponse):
                    raise BridgeError("matrix_history_unavailable")
                collected.extend(history.chunk)
                if not history.chunk or any(getattr(event, "server_timestamp", 0) < oldest - 60000 for event in history.chunk):
                    complete = True
                    break
                if not history.end or history.end == token:
                    complete = True
                    break
                token = history.end
            if not complete:
                raise BridgeError("matrix_history_limit")
            for event in reversed(collected):
                await self.on_event(self.client.rooms[self.room], event)
        self.journal.save_cursor(response.next_batch)

    async def ensure_trust(self):
        from nio import JoinedMembersResponse, KeysQueryResponse
        if not self.client or self.room not in self.client.rooms or not self.client.rooms[self.room].encrypted:
            raise BridgeError("matrix_room_not_encrypted")
        members = await self.client.joined_members(self.room)
        if not isinstance(members, JoinedMembersResponse):
            raise BridgeError("matrix_room_members")
        if self.client.should_query_keys and not isinstance(await self.client.keys_query(), KeysQueryResponse):
            raise BridgeError("matrix_key_query")
        found = set()
        for user, devices in self.client.room_devices(self.room).items():
            for device_id, device in devices.items():
                if device.deleted or (user == self.user and device_id == self.device):
                    continue
                expected = self.pins.get((user, device_id))
                if expected:
                    if device.ed25519.rstrip("=") != expected:
                        raise BridgeError("matrix_device_key_changed")
                    self.client.unblacklist_device(device)
                    self.client.verify_device(device)
                    found.add((user, device_id))
                else:
                    # Never send encryption keys to an unpinned/new device.
                    self.client.blacklist_device(device)
        if not any(user == self.hermes for user, _ in found):
            raise BridgeError("matrix_hermes_device_unverified")

    async def commands(self):
        reader = asyncio.StreamReader(limit=8192)
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
        try:
            await self.read_commands(reader)
        finally:
            transport.close()

    async def read_commands(self, reader):
        while True:
            raw = await reader.readline()
            if not raw:
                return
            if len(raw) > 8192:
                continue
            try:
                command = json.loads(raw)
                job_id = command.get("id", "")
                if command.get("type") != "send_voice" or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,63}", job_id):
                    continue
                if job_id in self.processing:
                    continue
                self.processing.add(job_id)
                task = asyncio.create_task(self.send(command))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            except (ValueError, AttributeError, TypeError):
                continue

    async def send(self, command: dict):
        job_id = command["id"]
        try:
            async with self.serial:
                row = self.journal.job(job_id)
                if row and row["event_id"]:
                    emit({"type": "sent", "jobId": job_id, "eventId": row["event_id"]})
                    if row["reply"]:
                        emit({"type": "reply", "jobId": job_id, "eventId": row["event_id"], "text": row["reply"]})
                    return
                await self.ensure_trust()
                path = Path(command["path"]).resolve()
                if path.parent != self.voice_directory or path.suffix != ".pcm":
                    raise BridgeError("audio_path_invalid")
                pcm = path.read_bytes()
                audio = wav_bytes(pcm)
                row = self.journal.register(job_id, hashlib.sha256(pcm).hexdigest())
                if row["content"]:
                    content = json.loads(row["content"])
                else:
                    from nio import UploadResponse
                    uploaded, info = await asyncio.wait_for(self.client.upload(io.BytesIO(audio),
                        filename="voice.bin", content_type="application/octet-stream", encrypt=True, filesize=len(audio)), timeout=60)
                    if not isinstance(uploaded, UploadResponse):
                        raise BridgeError("matrix_upload_failed")
                    content = voice_content(info, uploaded.content_uri, len(audio), len(pcm) // 32, self.hermes)
                    self.journal.content(job_id, content)
                # room_send encrypts the event only after encrypted-room state is confirmed.
                if not self.client.rooms[self.room].encrypted:
                    raise BridgeError("matrix_room_not_encrypted")
                from nio import RoomSendResponse
                response = await asyncio.wait_for(self.client.room_send(self.room,
                    message_type="m.room.message", content=content, tx_id="alfred-" + job_id,
                    ignore_unverified_devices=False), timeout=60)
                if not isinstance(response, RoomSendResponse):
                    raise BridgeError("matrix_send_failed")
                self.journal.sent(job_id, response.event_id)
                emit({"type": "sent", "jobId": job_id, "eventId": response.event_id})
                for args in self.journal.buffered():
                    self.accept_event(*args)
        except BridgeError as error:
            retryable = error.code in {"matrix_upload_failed", "matrix_send_failed", "matrix_key_query", "matrix_room_members"}
            emit({"type": "retry" if retryable else "failed", "jobId": job_id, "code": error.code})
        except Exception:
            # A timeout may follow a successful homeserver send. Retrying the same
            # transaction ID recovers its event ID without posting another message.
            emit({"type": "retry", "jobId": job_id, "code": "matrix_delivery_retry"})
        finally:
            self.processing.discard(job_id)

    def accept_event(self, room_id, sender, event_id, content, decrypted, verified):
        reply = self.journal.accept_reply(room_id, sender, event_id, content, decrypted, verified,
                                          self.room, self.hermes)
        if reply:
            emit(reply)

    async def on_event(self, room, event):
        if room.room_id != self.room or getattr(event, "sender", None) != self.hermes:
            return
        args = (room.room_id, event.sender, event.event_id, event.source.get("content", {}),
                bool(getattr(event, "decrypted", False)), bool(getattr(event, "verified", False)))
        self.journal.remember(args)
        self.accept_event(*args)


async def main():
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    try:
        worker = Worker()
        await worker.start()
    except BridgeError as error:
        emit({"type": "offline", "code": error.code})
    except (ImportError, ModuleNotFoundError):
        emit({"type": "offline", "code": "matrix_dependencies_missing"})
    except Exception:
        emit({"type": "offline", "code": "matrix_startup_failed"})


if __name__ == "__main__":
    asyncio.run(main())
