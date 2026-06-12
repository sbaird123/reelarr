# Peekarr

A TikTok-style trailer browser for **Radarr** and **Sonarr**. Peek at upcoming movies and trending shows, autoplay their trailers, and add the ones you like straight to your library with a tap.

Built to feel like any other *arr — drop it in your Docker stack, configure through the UI, done.

![Peekarr](docs/screenshot.png)

## Features

- Vertical swipe feed of YouTube trailers (TMDB source)
- **Movies** tab (Upcoming / Now Playing / Popular) and **TV** tab (Trending / Popular / New & Upcoming / On Air / Top Rated)
- **Library** tab — trailers for everything already in your Radarr + Sonarr libraries, so you can rediscover stuff you forgot you had
- **Play On TV** — with Jellyfin configured, one tap in the Library tab beams the movie or show straight to a Jellyfin client (TV, Chromecast, browser tab, etc.) via Jellyfin's remote-control API
- One-tap **Add to Radarr / Sonarr** with quality profile + root folder selection
- Search bar for anything in TMDB
- Marks already-in-library entries so you don't re-add
- "Watched" list so you don't see the same trailers again
- Soft deprioritisation of trailers you keep skipping
- Config stored in a SQLite volume — no `.env` edits needed after install

## Install (Docker Compose)

```yaml
services:
  peekarr:
    image: ghcr.io/sbaird123/peekarr:latest
    container_name: peekarr
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    restart: unless-stopped
```

Then:

```sh
docker compose up -d
```

Open <http://localhost:3000/settings> and plug in:

- **TMDB API key** (free from <https://www.themoviedb.org/settings/api>)
- **Radarr** URL + API key (Radarr → Settings → General → Security)
- **Sonarr** URL + API key (Sonarr → Settings → General → Security)
- **Jellyfin** URL + API key *(optional, enables Library → Play On TV — Jellyfin → Dashboard → API Keys → New)*. After saving, open Jellyfin on the TV/browser you want to cast to, then pick it from the **Play On device** dropdown.

Hit **Test** next to each one, then **Save Changes**. Visit `/` and start swiping.

### Security note

Peekarr has **no authentication** — like most *arr apps, anyone who can reach the port can browse, change settings, and read the stored API keys. Keep it on a trusted LAN or VPN; if you want it reachable from outside, put it behind a reverse proxy with auth (Authelia, basic auth, Tailscale, etc.). Don't port-forward it to the internet.

### Running in the same stack as Radarr/Sonarr

Use the Docker service name as the URL — e.g. `http://radarr:7878` and `http://sonarr:8989`. Make sure all containers share a Docker network.

## Install on TrueNAS SCALE

Tested on TrueNAS SCALE Electric Eel (25.x).

1. Create a dataset for persistent config, e.g. `tank/apps/peekarr/config`.
2. **Apps → Discover Apps → Custom App** (top-right).
3. Fill in:
   - **Application Name:** `peekarr`
   - **Image Repository:** `ghcr.io/sbaird123/peekarr`
   - **Image Tag:** `latest`
   - **Networking → Port Forwarding:** add an entry with **Container Port** `3000` and **Node Port** of your choice (e.g. `30007`). TrueNAS won't expose the app externally without this — the container listens on 3000 inside, but nothing reaches it from the LAN until you map it to a host port here.
   - **Storage → Host Path Volumes** (or **ixVolumes**): mount your config dataset → `/config`
4. Install, wait for the app to go green, then visit `http://<truenas-ip>:<node-port>/settings`.

## Build from source

```sh
git clone https://github.com/sbaird123/peekarr
cd peekarr
docker build -t peekarr .
docker run -d --name peekarr -p 3000:3000 -v $(pwd)/config:/config peekarr
```

## Develop locally

```sh
npm install
cp .env.example .env    # optional — settings UI works without this
npm run dev
```

Runs on <http://localhost:3000>. Node 20+ required.

## Environment variables

Everything is optional — the Settings UI is the source of truth. Env vars only seed defaults on first run.

| Variable         | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `PORT`           | HTTP port (default `3000`)                                 |
| `CONFIG_DIR`     | Path for the SQLite DB (default `/config` in Docker)       |
| `PUID` / `PGID`  | uid/gid the app drops to at startup (default `1000`/`1000`) — match your host user if files under `/config` need to be readable outside the container |
| `TMDB_API_KEY`   | TMDB v3 API key                                            |
| `RADARR_URL`     | e.g. `http://radarr:7878`                                  |
| `RADARR_API_KEY` | Radarr API key                                             |
| `SONARR_URL`     | e.g. `http://sonarr:8989`                                  |
| `SONARR_API_KEY` | Sonarr API key                                             |
| `JELLYFIN_URL`   | e.g. `http://jellyfin:8096` (optional, enables Play On TV) |
| `JELLYFIN_API_KEY` | Jellyfin API key                                         |

## Volume layout

```
/config/
  data.db        # settings, watched list
```

Back this up and you've backed up everything Peekarr knows.

## Gestures

- **Swipe up/down** — next / previous trailer
- **Single tap** — play / pause (and unmute)
- **Triple tap** — quick-add dialog
- **"+ Add"** / **"Watched"** / **"Skip"** buttons on each slide

## License

MIT
