# Putting the assistant on a server

This takes you from a fresh Linux machine to a working `https://` site, on one
small machine (for example a free Oracle Cloud VM). It uses Docker, so the only
things you install on the machine are Docker and git.

What runs:

```text
students' browsers
      |  https (ports 80 and 443)
      v
   Caddy  ---- serves the web app's files (web/dist)
      |
      |  /api/*
      v
    API (Node, port 5051, not reachable from outside)
      |
      v
  four folders of data, kept in Docker volumes
```

HTTPS is not optional: passwords and sign-in tokens travel in every request.
Caddy gets the certificate and renews it by itself.

**Read [What has and has not been tested](#what-has-and-has-not-been-tested)
at the end before you rely on this.** The Docker image builds and starts, and
the Caddy configuration is valid (both are checked on every push), but the
whole recipe has not yet been followed on a real server.

Throughout, `assistant.example.edu` stands for your own name and
`/opt/academic-assistant-ai` for where you put the code.

---

## 1. Before you start

You need:

- A Linux machine with a public IP address. 1 GB of memory is enough to run
  it. Building the web app needs more for a minute or two (see step 5).
- A name for the site, and someone who can add a DNS record for it.
- A Groq API key (<https://console.groq.com/keys>).
- A mail server that will send the sign-up codes: its host, port, user name
  and password. Without it students cannot create accounts.

## 2. Point the name at the machine and open the ports

1. Add a DNS **A record**: `assistant.example.edu` -> the machine's public IP.
2. Open ports **80** and **443** (TCP) to the internet. Port 80 is needed too:
   the certificate is issued through it, and Caddy uses it to send
   `http://` visitors to `https://`.
3. Do **not** open port 5051.

On Oracle Cloud the ports are closed in two places:

- In the web console: Networking -> your VCN -> Security List -> add Ingress
  Rules for TCP 80 and TCP 443 from `0.0.0.0/0`.
- On the machine itself, Oracle's Ubuntu images have their own firewall rules.
  Oracle's tutorials open the ports like this (not tested by us):

  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

Check the name from your own computer before going on. It must print the
machine's IP:

```bash
dig +short assistant.example.edu      # or: nslookup assistant.example.edu
```

If you start Caddy before the name points at the machine, the certificate
request fails. Caddy tries again by itself, but many failures in a row can get
you rate-limited by the certificate authority for a while.

## 3. Install Docker and get the code

On the machine:

```bash
# Docker, from Docker's own install script (see https://docs.docker.com/engine/install/)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# log out and back in, so the group change takes effect

sudo mkdir -p /opt/academic-assistant-ai
sudo chown "$USER" /opt/academic-assistant-ai
git clone https://github.com/Baboucar/academic-assistant-ai.git /opt/academic-assistant-ai
cd /opt/academic-assistant-ai
```

All commands from here on are run in `/opt/academic-assistant-ai`.

## 4. Fill in the settings

There are two files. Neither is committed to git.

**`.env`**, next to `docker-compose.yml`: one line, the site's name, without
`https://`. Caddy asks for the certificate for this name, and the web app is
built to call the API at this name.

```bash
echo "SITE_DOMAIN=assistant.example.edu" > .env
```

**`deploy/.env.production`**: the API's settings and secrets.

```bash
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
nano deploy/.env.production
```

The file explains each setting. The server refuses to start in production
until these are filled in:

| Setting | What to put |
| --- | --- |
| `GROQ_API_KEY` | Your Groq key. |
| `ORIGIN` | `https://assistant.example.edu` (the address students type; `*` is refused). |
| `ADMIN_USER`, `ADMIN_PASS` | The admin sign-in. The password must be 12 characters or longer. `openssl rand -base64 24` makes a good one. |
| `SMTP_HOST` and the other `SMTP_*`, `MAIL_FROM` | Your mail server. Use port 587 or 465: Oracle Cloud, like many providers, blocks outgoing port 25. |

Also check `STUDENT_EMAIL_DOMAINS` (who may sign up) and leave `TRUST_PROXY=1`.
Leave `DEV_SHOW_CODES` unset and leave the "Where data is stored" block
commented out: with Docker the image sets those paths.

Keep a copy of `deploy/.env.production` somewhere safe that is not this
machine (a password manager is fine). It is not in git and not in the backups.

## 5. Build the web app

```bash
docker compose run --rm web-build
```

This runs `npm ci` and `npm run build` for `web/` inside a Node 22 container
and leaves the result in `web/dist`. The API address
(`https://` + `SITE_DOMAIN`) is fixed into the files at this point, so run it
again if the name ever changes.

Two things to know:

- The files it creates (`web/dist`, `web/node_modules`) belong to root. That is
  harmless; you only notice if you try to delete them (use `sudo`).
- On a 1 GB machine the build may be killed for lack of memory (it ends with
  `Killed` or exit code 137). Either add swap and run it again:

  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  ```

  or build on your own computer and copy the folder across:

  ```bash
  # on your computer, in the repository
  npm --prefix web ci
  VITE_API_BASE=https://assistant.example.edu npm --prefix web run build
  rsync -a --delete web/dist/ you@assistant.example.edu:/opt/academic-assistant-ai/web/dist/
  ```

  If `web/dist` already exists on the server and belongs to root, run
  `sudo chown -R "$USER" web/dist` there first.

## 6. Start it

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
```

The first time, this builds the API image (a few minutes) and downloads Caddy.
The `GIT_SHA=...` part is optional: it makes the health check report which
commit is running.

Then check, in this order:

```bash
docker compose ps
```

`api` should show `healthy` after about half a minute, and `caddy` should be
`running`. If `api` keeps restarting, a required setting is missing and the log
says which:

```bash
docker compose logs api
```

```text
Refusing to start in production until these are fixed (see server/.env.example, or deploy/.env.production.example with Docker):
  - SMTP_HOST is not set: sign-up codes cannot be emailed.
```

Fix `deploy/.env.production`, then run `docker compose up -d` again. (Use
`up -d`, not `restart`: `restart` does not re-read the settings file.)

When it has started the log says `API on :5051 (production)`.

Now from your own computer:

```bash
curl https://assistant.example.edu/api/health
```

You should get JSON that starts with `{"ok":true` and contains
`"mode":"production"` and `"ai_configured":true`. If the connection fails or
the certificate is wrong,
look at Caddy's log; it says plainly why a certificate could not be issued
(usually DNS or a closed port):

```bash
docker compose logs caddy
```

## 7. First admin sign-in and first timetable

1. Open `https://assistant.example.edu/admin` and sign in with `ADMIN_USER` and
   `ADMIN_PASS`. (Reloading the page signs you out again; that is intended.)
2. Upload a class timetable (PDF or Excel). Choose its type, give it a
   department or school code such as `CS`, and upload.
3. Read the result. It shows how many rows were read and lists anything the
   reader corrected or could not place. A file with 0 rows was not understood.
4. Open `https://assistant.example.edu`, create a student account with a real
   university address, and wait for the code. **This is the test that email
   works.** If no email arrives, look for `Email could not be sent` in
   `docker compose logs api`.
5. Ask a question about the timetable you uploaded. The answer should appear
   piece by piece as it is written. If it only ever appears all at once,
   something between the browser and the API is holding the stream back.
   Streaming through Caddy is one of the things that has not been tested yet
   (see the end of this document).

## 8. Turn on the nightly backup

The student accounts cannot be rebuilt from anything. Back them up.

Run a backup once by hand to see it work:

```bash
docker compose exec api npm run backup
```

```text
accounts: /app/state/backups/accounts-2026-11-21T02-00-00.db (81920 bytes)
timetable: /app/state/backups/timetable-2026-11-21T02-00-00.db (69632 bytes)
```

It is safe to run while the site is in use. Each run writes one dated copy of
each database and keeps the newest 14 of each. The time in the name is UTC.

Do not back up by copying the `.db` files yourself while the server runs: the
most recent changes are in a second file next to each database, and a plain
copy misses them.

Then make it nightly. Run `crontab -e` (as a user who can run `docker`) and add:

```cron
0 2 * * * cd /opt/academic-assistant-ai && docker compose exec -T api npm run backup >> "$HOME/utg-backup.log" 2>&1
15 2 * * * cd /opt/academic-assistant-ai && mkdir -p "$HOME/utg-backups" && docker compose cp api:/app/state/backups/. "$HOME/utg-backups/" >> "$HOME/utg-backup.log" 2>&1
```

The first line makes the backup. The second copies the backup folder out of
Docker into `~/utg-backups`, an ordinary folder. Nothing deletes old files
from `~/utg-backups`, so clear it out now and then.

**A backup on the same machine does not help if the machine is lost.** From
another computer, fetch the folder regularly (or put this in that computer's
own cron):

```bash
rsync -a you@assistant.example.edu:utg-backups/ ./utg-backups/
```

The uploaded timetable files are not part of `npm run backup`. Keep the
originals you uploaded, or copy them out the same way:

```bash
mkdir -p timetable-files && docker compose cp api:/app/state/data/. timetable-files/
```

Check `~/utg-backup.log` after the first night.

## 9. Updating to a new version

```bash
cd /opt/academic-assistant-ai
docker compose exec api npm run backup     # a copy from just before the update
git pull
GIT_SHA=$(git rev-parse --short HEAD) docker compose build api   # new API image
docker compose run --rm web-build          # new web app files
docker compose up -d                       # replace the running API
docker compose ps                          # api should become "healthy" again
```

The site is down for a few seconds while the API is replaced. The server
brings its databases up to date by itself when it starts. `version` in
`/api/health` shows the commit that is now running.

If the new version misbehaves: `git checkout` the previous commit, run the
same build and `up -d` steps again, and if the databases were changed by the
new version, restore the backup you took in the first line (section 11).

Check `deploy/.env.production.example` after each `git pull` for new settings.

## 10. Where the data lives

| What | Docker volume | Path inside the API container | If it is lost |
| --- | --- | --- | --- |
| Uploaded timetable files, and `.sources.json` (the type, semester and department chosen for each) | `utg-assistant_data` | `/app/state/data` | Upload the files again. |
| Timetable database | `utg-assistant_db` | `/app/state/db/utg.db` | Restore a backup, or rebuild it from the files (see below). |
| Student accounts, sessions, admin settings, the admin log and the log of questions asked | `utg-assistant_accounts` | `/app/state/accounts/accounts.db` | **Gone unless you have a backup.** Every student would have to sign up again. |
| Backups | `utg-assistant_backups` | `/app/state/backups` | Only matters if you need one. |
| HTTPS certificates | `utg-assistant_caddy_data` | (Caddy) | Caddy asks for new ones. |

Outside Docker, on the machine: `.env`, `deploy/.env.production`, `web/dist`.

Not on the server at all: students' chats. They are kept in each student's
browser.

Two commands to be careful with:

- `docker compose down` stops and removes the containers. The data stays.
- `docker compose down -v` also **deletes every volume above**. Do not use `-v`.

## 11. Restoring from a backup

A restore puts the databases back to how they were when the backup was made.
Anything after that (new accounts, new uploads) is lost, so use the newest
backup that is good.

On a brand-new machine, first do steps 2 to 6 so that the site runs (empty),
then continue here.

**1. If the backup files are not on this machine**, copy them into the backup
volume first (the file names are examples; use yours):

```bash
docker compose cp ./accounts-2026-11-21T02-00-00.db  api:/app/state/backups/
docker compose cp ./timetable-2026-11-21T02-00-00.db api:/app/state/backups/
```

**2. See which backups there are** (this works whether or not the API is
running):

```bash
docker compose run --rm --no-deps api ls -l /app/state/backups
```

**3. Stop the API.** The databases must not be in use while they are replaced.

```bash
docker compose stop api
```

**4. Copy the backup files into place.** Change the two file names to the ones
you chose in step 2.

```bash
docker compose run --rm --no-deps --user root api sh -c '
  cd /app/state &&
  cp backups/accounts-2026-11-21T02-00-00.db  accounts/accounts.db &&
  cp backups/timetable-2026-11-21T02-00-00.db db/utg.db &&
  rm -f accounts/accounts.db-wal accounts/accounts.db-shm db/utg.db-wal db/utg.db-shm &&
  chown node:node accounts/accounts.db db/utg.db &&
  ls -l accounts db'
```

The `rm` line matters. The `-wal` and `-shm` files belong to the database that
was there before; left in place they would be applied to the restored one.
The `chown` line gives the files back to the user the API runs as.

**5. Start the API and check:**

```bash
docker compose start api
docker compose ps
curl https://assistant.example.edu/api/health
```

The `counts` in the health reply should match what you expect, and a student
account from before the backup should be able to sign in.

**Only the accounts?** Leave the two `timetable`/`utg.db` parts out of step 4.

**No timetable backup?** The timetable database can be rebuilt from the
uploaded files. With the API running:

```bash
docker compose exec api node /app/ingest/ingest.js
```

It reads every file in the data folder again. The type, semester and
department you chose for each file at upload are kept in `.sources.json` next
to the files, so they survive. Check the list in the admin dashboard
afterwards all the same. Files you had removed "from answers only" are still
in the folder, so they come back.

## 12. When students say "it is busy"

Work down this list.

**1. Is the site up at all?**

```bash
curl -s https://assistant.example.edu/api/health
docker compose ps
```

`"ok":true` only means the API is running. Look at the `ai` part of the reply:

| `ai.state` | Meaning |
| --- | --- |
| `ok` | A model call succeeded in the last five minutes. |
| `busy` | The most recent model call was turned away for being over the limit. Go to 3. |
| `down` | The most recent model call failed for another reason; `ai.last_error_status` is the provider's status code; the full message is in the API log ("Model error ..."). Go to 2. |
| `unknown` | No question has reached the model in the last five minutes (or since the restart). Ask one yourself and look again. |

The health check never calls the model itself; it reports how the students'
own questions have gone. So `"ok":true` with `"state":"busy"` is exactly what
"it is busy" looks like.

No reply at all: `docker compose ps`, then `docker compose logs caddy` and
`docker compose logs api`.

**2. What does the API log say?**

```bash
docker compose logs api --since 30m | grep -E "Model error|Model request failed|-> 429|-> 5[0-9][0-9]"
```

| Line in the log | Meaning | What to do |
| --- | --- | --- |
| `Model error 429: ...` | Groq says the key has used its allowance for the minute or the day. Students see "The AI model is busy right now." | Step 3. |
| `-> 429` lines with no `Model error` next to them | One student reached their own limit (`CHAT_PER_MINUTE`, `CHAT_PER_DAY`), or one network address reached the sign-in limit (`AUTH_PER_15_MIN`). | Nothing, unless everyone hits it: then raise the limits in `deploy/.env.production`. |
| `Model error 401` | Groq rejected the key. | Check `GROQ_API_KEY`. |
| `Model error 404` | The model named in `MODEL` no longer exists. | Set `MODEL` to a current one. |
| `Model request failed: ...` | The server could not reach Groq at all. | Check the machine's internet connection and Groq's status page. |
| `-> 500`, or an error with a stack trace | A bug, or a full disk. | Step 4, then report it with the log lines. |

After changing a setting: `docker compose up -d`.

For numbers instead of log lines, the admin API has a summary of the questions
asked in the last day or more: how many, how many model calls they cost, how
many came from the cache, and how many ended in an error. It asks for the
admin password:

```bash
curl -s -u admin "https://assistant.example.edu/api/admin/questions?days=1"
```

**3. Look at the limits on Groq's side.** Sign in at
<https://console.groq.com> and look at the limits and usage for the key.
A question can cost up to two model calls. On the free tier that came to about
3 to 4 questions a minute for all students together when it was measured (see
"Capacity" in the README). If the log is full of `Model error 429` at busy
times, the allowance is too small for the number of students: move to a paid
tier, or to another provider with `GROQ_BASE_URL` and `MODEL`. Restarting the
server does not help.

**4. Is the machine itself in trouble?**

```bash
df -h /                      # disk full?
free -m                      # memory
docker stats --no-stream     # what each container is using
```

A full disk makes the databases fail. The usual causes are old Docker images
(`docker image prune`) and the `~/utg-backups` folder.

---

## The web app on Netlify instead

The repository has a `netlify.toml`, so the web app can be served by Netlify
and only the API runs on your machine. The differences:

- The machine's name is then the API's name, for example
  `api.assistant.example.edu`. Put that in `.env` as `SITE_DOMAIN`.
- In Netlify's site settings add the environment variable
  `VITE_API_BASE=https://api.assistant.example.edu`, then deploy.
- In `deploy/.env.production`, `ORIGIN` is the address of the Netlify site
  (for example `https://utg-assistant.netlify.app`, or your own domain there).
  If it does not match exactly, the browser blocks every request to the API.
- Skip step 5. Everything else is the same.

---

## Without Docker (systemd)

The same thing with Node and Caddy installed directly. Shorter, because the
ideas are the same; **none of this section has been run**.

**Install** Node 22 (from <https://nodejs.org> or your distribution), Caddy
(<https://caddyserver.com/docs/install>), git, and the tools npm needs if it
has to compile the database module:

```bash
sudo apt-get install -y git build-essential python3
```

**A user, the code, the packages:**

```bash
sudo useradd --system --create-home --home-dir /var/lib/utg-assistant --shell /usr/sbin/nologin utg
sudo git clone https://github.com/Baboucar/academic-assistant-ai.git /opt/academic-assistant-ai
cd /opt/academic-assistant-ai
sudo npm --prefix server ci --omit=dev
sudo npm --prefix ingest ci --omit=dev
sudo npm --prefix web ci
sudo VITE_API_BASE=https://assistant.example.edu npm --prefix web run build
```

Both `server` and `ingest` are needed: the API runs `ingest/ingest.js` when a
file is uploaded.

**Settings:**

```bash
sudo cp deploy/.env.production.example /etc/utg-assistant.env
sudo chmod 600 /etc/utg-assistant.env
sudo nano /etc/utg-assistant.env
```

Fill it in as in step 4, and this time **uncomment** the four lines under
"Where data is stored" (`DATA_DIR`, `DB_PATH`, `ACCOUNTS_DB_PATH`,
`BACKUP_DIR`), so the data is in `/var/lib/utg-assistant` and not inside the
git checkout.

**The service**, as `/etc/systemd/system/utg-assistant.service`:

```ini
[Unit]
Description=UTG Academic Assistant API
After=network-online.target
Wants=network-online.target

[Service]
User=utg
Group=utg
WorkingDirectory=/opt/academic-assistant-ai/server
EnvironmentFile=/etc/utg-assistant.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now utg-assistant
systemctl status utg-assistant
journalctl -u utg-assistant -n 50        # the log
curl http://127.0.0.1:5051/api/health
```

`ExecStart` is what `npm --prefix server start` runs. If `which node` prints
something other than `/usr/bin/node`, use that path.

**HTTPS**, as `/etc/caddy/Caddyfile` (a shorter version of `deploy/Caddyfile`,
with the name written out and local paths), then `sudo systemctl reload caddy`:

```caddyfile
assistant.example.edu {
	handle /api/* {
		reverse_proxy 127.0.0.1:5051 {
			flush_interval -1
		}
	}
	handle {
		root * /opt/academic-assistant-ai/web/dist
		encode zstd gzip
		header Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}
```

The API listens on port 5051 on every network interface, so make sure the
firewall keeps 5051 closed to the outside (step 2).

**Nightly backup**, as two more files.

`/etc/systemd/system/utg-assistant-backup.service`:

```ini
[Unit]
Description=Back up the UTG Academic Assistant databases

[Service]
Type=oneshot
User=utg
Group=utg
WorkingDirectory=/opt/academic-assistant-ai/server
EnvironmentFile=/etc/utg-assistant.env
ExecStart=/usr/bin/npm run backup
```

`/etc/systemd/system/utg-assistant-backup.timer`:

```ini
[Unit]
Description=Nightly backup of the UTG Academic Assistant databases

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now utg-assistant-backup.timer
sudo systemctl start utg-assistant-backup.service     # run one now
sudo ls -l /var/lib/utg-assistant/backups
```

Copy `/var/lib/utg-assistant/backups` to another machine regularly, as in
step 8.

**Restore:**

```bash
sudo systemctl stop utg-assistant
S=/var/lib/utg-assistant
sudo -u utg cp $S/backups/accounts-2026-11-21T02-00-00.db  $S/accounts/accounts.db
sudo -u utg cp $S/backups/timetable-2026-11-21T02-00-00.db $S/db/utg.db
sudo rm -f $S/accounts/accounts.db-wal $S/accounts/accounts.db-shm $S/db/utg.db-wal $S/db/utg.db-shm
sudo systemctl start utg-assistant
```

**Update:**

```bash
cd /opt/academic-assistant-ai
sudo systemctl start utg-assistant-backup.service
sudo git pull
sudo npm --prefix server ci --omit=dev
sudo npm --prefix ingest ci --omit=dev
sudo npm --prefix web ci
sudo VITE_API_BASE=https://assistant.example.edu npm --prefix web run build
sudo systemctl restart utg-assistant
```

For "it is busy", use section 12 with `journalctl -u utg-assistant --since "30 min ago"`
in place of `docker compose logs api --since 30m`.

---

## What has and has not been tested

This recipe has not yet been followed from start to finish on a real server,
so be ready for small corrections the first time. Please fix this document when
you find one.

Checked automatically on every push (the "docker image" job in
`.github/workflows/web.yml`, on a Linux x86_64 machine):

- The Docker image builds, including the database module.
- A container started from it answers `/api/health`.
- `caddy validate` accepts `deploy/Caddyfile`.

Tested (on macOS with Node 22, using a copy of `server/` and `ingest/` with
only the files the image contains, and the image's settings):

- `npm ci --omit=dev` for `server/` and `ingest/` installs, and the database
  module loads.
- With `NODE_ENV=production` and no settings, the server refuses to start and
  lists what is missing. With the required settings it starts, with all four
  data locations taken from `DATA_DIR`, `DB_PATH`, `ACCOUNTS_DB_PATH` and
  `BACKUP_DIR`.
- The image's health check command: it succeeds while the server is up and
  fails while it is down.
- Admin sign-in, an upload (which runs the ingest as a child process), and
  `npm run backup` while the server is running.
- The restore steps in section 11 (the commands inside the `sh -c '...'`):
  after a later upload and a forced kill of the server, copying the backups
  into place and removing the `-wal`/`-shm` files brought back exactly the
  state at backup time. The rebuild with `ingest/ingest.js` was also run on an
  emptied timetable database, and the type, semester and department chosen at
  upload came back.
- The replies of `/api/health` and `/api/admin/questions` quoted in section 12.
- `docker compose config` accepts `docker-compose.yml` and reads the example
  settings file as intended, including values in single quotes that contain
  `$`, `#`, `"` and `\`. Without `.env` or without `deploy/.env.production` it
  stops with a clear message.

Not tested:

- The Docker image on an ARM processor (Oracle's free machines are ARM): only
  x86_64 is built automatically. The Dockerfile includes a compiler in case no
  ready-made database module exists for the processor.
- Caddy actually serving the site: certificate issuing and streamed answers
  through Caddy have not been seen working.
- Volume ownership for the non-root user, and the image's own HEALTHCHECK as
  Docker runs it.
- `docker compose run --rm web-build`, the cron lines, `docker compose cp`, and
  the `docker compose` commands in the restore steps.
- Everything under "Without Docker (systemd)" and "The web app on Netlify
  instead".
- The Oracle Cloud firewall commands, and whether the web build fits in 1 GB
  of memory.
- Email delivery through a real mail server, and answers from the real model.
