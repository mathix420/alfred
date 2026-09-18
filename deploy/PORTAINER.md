Add Alfred to your existing **Docker Standalone** stack in Portainer. Start with
TodoMate tasks; enable encrypted Matrix uploads when the account is ready.
Voice is one-way: record → upload → **Sent!** → Focus.

Run the Bash commands below from an Alfred checkout on your Docker host. They
require Python 3, OpenSSL and access to Docker. Keep the same terminal open so its
path variables and helper function remain available.

**1. Create private Alfred settings once**

For an existing Alfred deployment, first save its current `ALFRED_DEVICE_TOKEN`
and `ALFRED_MATRIX_PICKLE_KEY` in `~/.config/alfred-portainer/alfred.env`; retain
those values. The following block creates credentials only when that file does
not already exist.

```bash
set -euo pipefail
umask 077
ALFRED_REPO="$(pwd -P)"
test -f "$ALFRED_REPO/deploy/compose.stack.yaml"
ALFRED_PRIVATE="$HOME/.config/alfred-portainer"
mkdir -p "$ALFRED_PRIVATE"
chmod 700 "$ALFRED_PRIVATE"

if [[ -e "$ALFRED_PRIVATE/alfred.env" ]]; then
  printf '%s\n' 'Keeping existing Alfred credentials.'
else
  ALFRED_NEW_DEVICE_TOKEN="$(openssl rand -hex 32)"
  ALFRED_NEW_PICKLE_KEY="$(openssl rand -hex 48)"
  (
    set -o noclobber
    printf '%s\n' \
      "ALFRED_DEVICE_TOKEN=$ALFRED_NEW_DEVICE_TOKEN" \
      "ALFRED_MATRIX_PICKLE_KEY=$ALFRED_NEW_PICKLE_KEY" \
      'ALFRED_MATRIX_ENABLED=false' \
      'ALFRED_POCKET_BIND=0.0.0.0' \
      'ALFRED_POCKET_PORT=9191' \
      > "$ALFRED_PRIVATE/alfred.env"
  )
  unset ALFRED_NEW_DEVICE_TOKEN ALFRED_NEW_PICKLE_KEY
fi
chmod 600 "$ALFRED_PRIVATE/alfred.env"
printf 'Private settings: %s\n' "$ALFRED_PRIVATE/alfred.env"
```

The device token is shared with your own ESP32/browser. The pickle key protects
the persistent Matrix identity; retain it with the volume backup.

`ALFRED_POCKET_BIND=0.0.0.0` publishes port 9191 for the physical device. Restrict
that port with your network firewall to the intended LAN/VPN clients. Direct
device access uses `ws://YOUR_SERVER:9191/ws`. For access beyond that trusted
network, use your HTTPS reverse proxy with WebSocket upgrades and
`wss://alfred.example.org/ws`; set `ALFRED_POCKET_PUBLIC_ORIGIN` to the exact browser
origin, such as `https://alfred.example.org`. A host-local proxy can use
`ALFRED_POCKET_BIND=127.0.0.1`; a proxy container on the stack network can connect
to `http://alfred:9191` directly. Browser microphone capture requires HTTPS or
localhost.

**2. Add the service in Portainer and reuse TodoMate credentials**

Open **Stacks → your existing stack → Editor**. Keep the existing services,
volumes and environment-variable rows. Merge `services.alfred` and
`volumes.alfred_data` from [compose.stack.yaml](compose.stack.yaml) into the
corresponding existing YAML sections; do not add a second top-level `services:`
or `volumes:` key. The fragment expects the TodoMate service to be named
`todomate-mcp` and share Alfred's network. Use its actual service name in
`depends_on` and `ALFRED_TODOMATE_API_URL` if yours differs.

Under **Environment variables → Load variables from .env file**, import the
private `alfred.env`. If your browser runs on another machine, transfer the file
privately to that machine first. Add or update the Alfred entries while retaining
every existing stack variable; review for duplicate names before deploying.
Portainer exposes imported values to the `${VARIABLE}` references in the Compose
file. [Portainer's environment-file instructions](https://www.portainer.io/blog/using-env-files-in-stacks-with-portainer)
describe this import.

Keep the existing `TODOMATE_MCP_ACCESS_TOKEN` value in Portainer. Alfred and
`todomate-mcp` must receive that same token; there is no new TodoMate token to
generate. Firebase credentials stay with TodoMate. The Compose fragment connects
Alfred to `http://todomate-mcp:8000` internally.

For the existing Duplicacy service, add this entry to its existing `volumes:` list
and include `/backup/alfred_data` in its backup selection:

```yaml
- alfred_data:/backup/alfred_data:ro
```

Back up the private environment files separately. Keep the Matrix store, outgoing
job journal and pickle key together; use one Alfred replica for this identity.
For a consistent SQLite backup, stop Alfred during the volume snapshot and start
it again afterwards.

Use `ghcr.io/mathix420/alfred:latest` for Alfred and refresh
`ghcr.io/mathix420/todomate-mcp:latest` for TodoMate. Its updated image must include
`/api/tasks`; an older image exposing only `/mcp` cannot serve Alfred's tasks.
Choose **Update the stack** and enable the image re-pull option offered by your
Portainer version. You can also pull these images on the Docker host before
updating the stack:

```bash
docker pull ghcr.io/mathix420/alfred:latest
docker pull ghcr.io/mathix420/todomate-mcp:latest
```

Wait for deployment to finish and check both containers are healthy. Portainer's
[stack editor documentation](https://docs.portainer.io/user/docker/stacks/edit)
describes editing and redeploying an existing stack. Git-managed stacks need the
same Compose change in their repository, followed by **Pull and redeploy**.

```bash
curl --fail --silent --show-error http://127.0.0.1:9191/healthz
```

Open the preview at your server's address and enter `ALFRED_DEVICE_TOKEN` from the
private file. Real tasks should now load and complete through TodoMate. Matrix
can remain disabled while you use the task display.

**3. Find the existing Hermes Matrix settings**

If you are already in the **Hermes container's Portainer console**, paste this
Bash block (replace the example room ID). It downloads the inspector to a private
temporary directory and prints an Alfred environment template:

```bash
(
  set -eu
  umask 077
  alfred_inspector_dir="$(mktemp -d)"
  trap 'rm -rf "$alfred_inspector_dir"' EXIT
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/mathix420/alfred/master/deploy/inspect-hermes-matrix.py \
    --output "$alfred_inspector_dir/inspect.py"
  python "$alfred_inspector_dir/inspect.py" \
    --resolve-user --alfred-env --devices \
    --room '!YOUR_ROOM:example.org'
)
```

The inspector reads the Hermes `.env` and container environment, resolves the bot
identity using its token in memory, and queries public device keys. It never
prints tokens, sends messages, creates sessions, or modifies Hermes settings.
If exactly one allowed sender remains after excluding the bot, it suggests that
user and discovers their homeserver through public Matrix `.well-known`
metadata. Confirm that sender is your account; add `--user '@you:example.org'`
when there are multiple allowed users. Failed discovery leaves a comment to fill
in manually rather than assuming Hermes and your account share a homeserver.

Only discovered public settings become active environment entries. Missing
session credentials and the pickle key remain comments, preserving existing
values on import; device fingerprint candidates are also commented out and must
be independently verified. Matrix stays disabled until setup is complete. Keep
the existing ESP32 device token. If you have never set a Matrix pickle key,
generate it once and save the result privately in the stack environment:

```bash
python -c 'import secrets; print("ALFRED_MATRIX_PICKLE_KEY=" + secrets.token_hex(48))'
```

For the original JSON inspection from your Docker host, use the following commands.
This optional step reads a whitelist of public Matrix settings inside the Hermes
container. It does not print its access token or dump its environment.

```bash
read -r -p 'Existing Portainer stack name: ' ALFRED_STACK

alfred_container() {
  local service="$1"
  local -a matches
  mapfile -t matches < <(
    docker ps \
      --filter "label=com.docker.compose.project=$ALFRED_STACK" \
      --filter "label=com.docker.compose.service=$service" \
      --format '{{.ID}}'
  )
  if (( ${#matches[@]} != 1 )); then
    printf 'Expected exactly one running %s container; found %s.\n' \
      "$service" "${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

ALFRED_HERMES_CONTAINER="$(alfred_container hermes)"
docker exec -i "$ALFRED_HERMES_CONTAINER" python - \
  < "$ALFRED_REPO/deploy/inspect-hermes-matrix.py"
```

Change `hermes` in the lookup to its Compose service name if necessary. If
`MATRIX_USER_ID` is unresolved, this explicit variant makes one authenticated,
read-only `whoami` request using the bot token inside its container:

```bash
docker exec -i "$ALFRED_HERMES_CONTAINER" python - --resolve-user \
  < "$ALFRED_REPO/deploy/inspect-hermes-matrix.py"
```

Use the bot's `MATRIX_USER_ID` for `ALFRED_MATRIX_HERMES_USER_ID`. Alfred's
`ALFRED_MATRIX_HOMESERVER` must be the HTTPS API of **your own account's
homeserver**, which can differ from Hermes's inspected `MATRIX_HOMESERVER`.
Obtain it from your provider or trusted client's connection settings. Select your
existing encrypted room from Beeper's
room details, or the inspected allowed/home-room settings. Its ID looks like
`!room:example.org`, not a room alias or URL. Hermes must already be joined with
encryption enabled and allow your user/room. Leave its model configuration alone.

**4. Create a dedicated session on your own Matrix account**

Alfred sends as your account. Its `ALFRED_MATRIX_USER_ID`, access token and
device ID belong to a **new dedicated session on your account**, distinct from
Hermes and your existing Beeper clients. A Beeper Desktop API token is not a
Matrix session token. Reusing another client's Matrix device with an empty
Alfred crypto store will fail the identity check.

For a **Beeper sender account**, create the fresh session with
[provision-beeper-session.sh](provision-beeper-session.sh). It uses Beeper's
official `bbctl` email-code login with an isolated configuration and
`--no-desktop`, so it does not reuse your existing desktop session or initialize
encryption keys. From the Hermes container console:

```bash
(
  set -eu
  umask 077
  alfred_beeper_script="$(mktemp)"
  trap 'rm -f "$alfred_beeper_script"' EXIT
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/mathix420/alfred/master/deploy/provision-beeper-session.sh \
    --output "$alfred_beeper_script"
  bash "$alfred_beeper_script" "${HERMES_HOME:-/opt/data}/alfred-matrix-session"
)
```

Enter your **Beeper account email** and the code it receives. The new private
directory contains `bbctl.json` and `matrix-session.env`; the latter supplies
only the sender homeserver, user ID, access token, and device ID. It leaves
Alfred's existing device token and pickle key unchanged. Import those four
settings into Portainer, or use the saved Matrix access token at the hidden
prompt of the `inspect` command below to complete fingerprint verification.
Keep this directory if later setup fails; the script refuses to overwrite an
existing session. The Element session used to administer Hermes belongs to the
bot account and must not supply Alfred's sender credentials.

For other Matrix homeservers, discover the supported login methods below. Beeper
users can also run this check, then choose `inspect` with their saved session.

```bash
read -r -p 'Matrix HTTPS homeserver: ' ALFRED_MATRIX_SERVER
read -r -p 'Hermes Matrix user ID (@name:server): ' ALFRED_HERMES_MXID
read -r -p 'Existing encrypted room ID (!id:server): ' ALFRED_MATRIX_ROOM

python3 "$ALFRED_REPO/apps/pocket/matrix/provision.py" flows \
  --homeserver "$ALFRED_MATRIX_SERVER"
```

The following wrapper passes the two existing Alfred secrets to the helper
without executing the environment file or showing their values. It prevents
Matrix setup from changing the device token or pickle key created in step 1.

```bash
alfred_matrix_setup() {
  python3 - "$ALFRED_PRIVATE/alfred.env" \
    "$ALFRED_REPO/apps/pocket/matrix/provision.py" "$@" <<'PY'
import os
from pathlib import Path
import shlex
import subprocess
import sys

required = {"ALFRED_DEVICE_TOKEN", "ALFRED_MATRIX_PICKLE_KEY"}
values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    key, separator, raw = line.partition("=")
    key = key.strip()
    if separator and key in required:
        parsed = shlex.split(raw, comments=True, posix=True)
        if key in values or len(parsed) != 1 or not parsed[0]:
            raise SystemExit("Invalid or duplicate Alfred secret; keep the original values.")
        if any(ord(c) < 32 or ord(c) == 127 or c in "'$" for c in parsed[0]):
            raise SystemExit("Existing secret cannot be represented safely; setup stopped.")
        values[key] = parsed[0]
if values.keys() != required:
    raise SystemExit("Both original Alfred secrets are required; setup stopped.")
environment = os.environ.copy()
environment.update(values)
environment.pop("ALFRED_MATRIX_ACCESS_TOKEN", None)
with open("/dev/tty") as terminal:
    result = subprocess.run(
        [sys.executable, sys.argv[2], *sys.argv[3:], "--no-generate-secrets"],
        env=environment, stdin=terminal, check=False,
    )
raise SystemExit(result.returncode)
PY
}
```

If `flows` advertises `m.login.password`, run this once. The helper prompts for
your user ID and hidden password, requests a fresh device, and saves the new
session before the trust prompts:

```bash
alfred_matrix_setup password-login \
  --homeserver "$ALFRED_MATRIX_SERVER" \
  --hermes-user "$ALFRED_HERMES_MXID" \
  --room "$ALFRED_MATRIX_ROOM" \
  --output "$ALFRED_PRIVATE/matrix.env"
```

Otherwise, use your provider's supported SSO/device authorization flow (or the
Beeper script above) to obtain a fresh dedicated Matrix session, then inspect it
with this alternative. The token prompt is hidden. The Python inspection helper
does not itself perform Beeper/SSO login.

```bash
alfred_matrix_setup inspect \
  --homeserver "$ALFRED_MATRIX_SERVER" \
  --hermes-user "$ALFRED_HERMES_MXID" \
  --room "$ALFRED_MATRIX_ROOM" \
  --output "$ALFRED_PRIVATE/matrix.env"
```

Choose one alternative. The helper refuses to overwrite an existing output file.
If a later lookup fails, retain that file: a newly created session has already
been saved there. Use `inspect` with that session and a new output filename to
finish setup instead of creating another login.

Compare the listed device fingerprints with a trusted client/device view or
their owner through a trusted channel. Select Hermes's verified device and each
of your own Beeper devices that should decrypt these recordings. Server discovery
alone does not establish trust. The helper writes the selected pins as
`ALFRED_MATRIX_TRUSTED_DEVICES`; leaving verification unfinished keeps Matrix
disabled. It sends no messages, joins no rooms and uploads no encryption keys.

The Hermes inspector's `Hermes token device` line identifies the bot's active
session. Include that device after checking its fingerprint. Another Element
login on the bot account is a separate device and is optional. Your own phone,
desktop, and web client sessions are also optional recipients: include the
verified ones where you want to decrypt Alfred's voice notes. Alfred withholds
encryption keys from devices omitted from this list. Device IDs identify a
session, while the `ed25519` value pins its encryption identity; retain both
unchanged when copying a verified entry. In Portainer's individual variable
editor, paste the JSON array alone, without the `.env` assignment or enclosing
shell quotes.

**5. Import Matrix settings and verify the persistent identity**

Import the private `matrix.env` into the same Portainer stack's environment
variables. Preserve the existing TodoMate and other stack entries. The generated
device token and pickle key must match step 1; replace existing Alfred rows with
these matching values if the UI adds duplicates. Keep the LAN/proxy binding
entries already configured. Update the stack.

Alfred's first configured start creates its own encryption keys in `alfred_data`.
Read only the public readiness/identity fields from its authenticated status API:

```bash
ALFRED_CONTAINER="$(alfred_container alfred)"
docker exec "$ALFRED_CONTAINER" bun -e '
const response = await fetch("http://127.0.0.1:9191/api/status", {
  headers: {Authorization: "Bearer " + process.env.ALFRED_DEVICE_TOKEN}
});
if (!response.ok) throw new Error("Status check failed: " + response.status);
const {matrix} = await response.json();
console.log(JSON.stringify({ready: matrix?.ready, error: matrix?.error,
  identity: matrix?.identity}, null, 2));
'
```

Verify this Alfred device ID and Ed25519 fingerprint from Hermes's trusted device
view before using voice. Keep the session, crypto volume and pickle key together
across updates. `matrix_crypto_store_mismatch` means the session already has
different published keys; restore its matching store or provision a fresh
dedicated session. Do not erase the volume and reuse an existing published device.

The ESP32 and browser need only the backend address and `ALFRED_DEVICE_TOKEN`.
Record a short message when ready: the screen shows **Sent!** after the Matrix
homeserver confirms delivery. The original recording appears as your user in the
encrypted chat; Alfred does not process incoming chat or display Hermes replies.
