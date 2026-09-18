#!/usr/bin/env bash
# Create a dedicated Beeper Matrix session without starting a Matrix client.
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: provision-beeper-session.sh NEW_PRIVATE_DIRECTORY

Downloads and verifies official bbctl v0.15.0, then prompts for your Beeper
email and login code. The directory must not exist; its parent must exist.
Supported systems: Linux and macOS, amd64 and arm64. Requires Bash, curl,
Python 3, and an interactive terminal.

Saves bbctl.json and matrix-session.env privately in that directory.
The env file contains only Alfred's Matrix homeserver, user, token, and device.
No token is printed. No encryption keys, messages, or other Alfred settings
are created or changed. Saved credentials are retained if any later step fails.
USAGE
}

if [[ $# == 1 && ( $1 == --help || $1 == -h ) ]]; then
  usage
  exit 0
fi
if [[ $# != 1 || -z ${1:-} || $1 == -* ]]; then
  usage >&2
  exit 2
fi
for dependency in curl python3; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$dependency" >&2
    exit 1
  fi
done

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=macos ;;
  *) printf 'Only Linux and macOS are supported.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) printf 'Only amd64 and arm64 are supported.\n' >&2; exit 1 ;;
esac

session_dir=$1
if [[ -e $session_dir || -L $session_dir ]]; then
  printf 'Refusing an existing directory. Choose a new private directory.\n' >&2
  exit 1
fi
if ! mkdir -m 700 -- "$session_dir"; then
  printf 'Cannot create the private directory; its parent must exist.\n' >&2
  exit 1
fi
session_dir=$(cd -- "$session_dir" && pwd -P)
asset="bbctl-$platform-$architecture"
release=https://github.com/beeper/bridge-manager/releases/download/v0.15.0

download() {
  curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 180 --output "$2" "$1"
}
printf 'Downloading official bbctl v0.15.0 and its checksum.\n'
download "$release/$asset" "$session_dir/$asset"
download "$release/sha256sums.txt" "$session_dir/sha256sums.txt"
python3 - "$session_dir" "$asset" <<'PY'
import hashlib
from pathlib import Path
import re
import sys

try:
    directory, asset = Path(sys.argv[1]), sys.argv[2]
    with (directory / "sha256sums.txt").open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError()
    matches = []
    for line in raw.decode("ascii").splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+)", line)
        if match and match[2] == asset:
            matches.append(match[1].lower())
    if len(matches) != 1:
        raise ValueError()
    digest = hashlib.sha256()
    with (directory / asset).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != matches[0]:
        raise ValueError()
except Exception:
    sys.exit("Official bbctl checksum verification failed; login was not started.")
PY
chmod 700 "$session_dir/$asset"

# A new config generates a new device. Never reuse Desktop's encrypted session.
# bbctl can return success even after a login error, so inspect the saved file.
if ! BEEPER_EMAIL= "$session_dir/$asset" --env prod \
  --config "$session_dir/bbctl.json" login --no-desktop; then
  printf 'bbctl reported an error; checking whether it saved a session.\n' >&2
fi

if ! python3 - "$session_dir" <<'PY'
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys

try:
    directory = Path(sys.argv[1])
    config_path = directory / "bbctl.json"
    if not stat.S_ISREG(config_path.lstat().st_mode):
        raise ValueError()
    with config_path.open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError()
    config = json.loads(raw)
    account = config["environments"]["prod"]
    device = config["device_id"]
    username = account["username"]
    token = account["access_token"]
    if account.get("desktop_data_dir"):
        raise ValueError()
    if not isinstance(device, str) or not re.fullmatch(r"bbctl_[A-Z0-9]{8}", device):
        raise ValueError()
    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9._=+/~-]{1,255}", username):
        raise ValueError()
    if (not isinstance(token, str) or not token.startswith(("syt_", "bat_"))
            or not 8 <= len(token) <= 16384
            or any(ord(character) <= 32 or ord(character) >= 127 or character in "'$" for character in token)):
        raise ValueError()
    values = {
        "ALFRED_MATRIX_HOMESERVER": "https://matrix.beeper.com",
        "ALFRED_MATRIX_USER_ID": "@" + username + ":beeper.com",
        "ALFRED_MATRIX_ACCESS_TOKEN": token,
        "ALFRED_MATRIX_DEVICE_ID": device,
    }
    output = directory / "matrix-session.env"
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
        for key, value in values.items():
            destination.write(key + "=" + shlex.quote(value) + "\n")
        destination.flush()
        os.fsync(destination.fileno())
    print("Saved Matrix session: " + str(output))
    print("User: " + values["ALFRED_MATRIX_USER_ID"])
    print("Device: " + device)
except Exception:
    sys.exit("Could not export a valid fresh session. Credentials, if saved, remain in bbctl.json.")
PY
then
  printf 'Retained private directory: %s\n' "$session_dir" >&2
  exit 1
fi
