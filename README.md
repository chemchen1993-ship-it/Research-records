# Research Records iPad PWA

This folder contains a separate browser-based iPad app with shared sync. It does not modify or reuse the original Tkinter desktop program.

## What this version includes

- `Experiment Report` and `Notes`
- Project, title, tags, and date fields
- Two-column report editor on iPad
- Rich text sections with inline image insertion and paste
- Hide and restore report sections
- Per-section manual height adjustment with persistence
- User registration, sign-in, and sign-out
- Local cache + cloud database sync through a Python sync server
- Search and grouped sidebar
- Save records, duplicate records, delete records
- Version history on every save
- Draft auto-save every 30 seconds
- Offline app shell through service worker
- Installable PWA shell

## Files

- `index.html`: app shell
- `styles.css`: iPad-friendly UI
- `app.js`: app logic, local cache, auth flow, and sync client
- `manifest.webmanifest`: PWA manifest
- `service-worker.js`: offline caching
- `sync_server.py`: static host + auth API + sync API + SQLite storage
- `render.yaml`: internet deployment template for Render
- `Procfile`: generic process entry for platform deploys
- `assets/icon.svg`: icon
- `start_research_records_pwa.bat`: sync server launcher

## Local preview on Windows

Double-click:

`start_research_records_pwa.bat`

Then open:

`http://localhost:8735`

This server also exposes the app on your local network. Use the same server URL on the iPad while both devices are on the same Wi-Fi, then sign in with the same account on both devices.

## Internet deployment

This project can now be deployed to a public HTTPS host so the iPad no longer depends on local network access.

Recommended host:

- Render web service with a persistent disk

One-click Render entry:

- [Deploy this repo on Render](https://render.com/deploy?repo=https://github.com/chemchen1993-ship-it/Research-records.git)

### Render deployment

1. Put this folder in a Git repository.
2. Create a new Render Blueprint or Web Service from that repository.
3. Use the included `render.yaml`, or configure the service manually with:
   - Runtime: `Python`
   - Start command: `python sync_server.py`
   - Health check path: `/api/health`
   - Persistent disk mount path: `/var/data/research-records`
   - Environment variable: `RESEARCH_RECORDS_DATA_DIR=/var/data/research-records`
4. After deploy finishes, open the public `https://...onrender.com` URL on both the computer and the iPad.
5. Create an account once, then sign in with the same email and password on both devices.

### Installing on iPad after deployment

1. Open the site in Safari on iPad.
2. Tap `Share`.
3. Tap `Add to Home Screen`.

## Sync and storage note

Saved records, attachments, and version history are stored in the cloud-backed sync database:

- `sync_data/research_records_sync.db`

When deployed to Render with the included persistent disk, this database becomes the shared cloud source of truth. The browser also keeps a local cache in IndexedDB so previously loaded data returns faster on the same device.

Using the same account on iPad Safari and the computer browser gives you the same saved records after refresh, reload, or reopening the page.

The following items stay local on each device:

- auto-saved unsaved drafts
- the last-selected record in the UI

- Desktop app data is not changed
- Desktop SQLite data is not automatically imported
- Desktop browser and iPad browser share saved data only when both use the same sync server and sign in with the same account
- If you deploy without a persistent disk, cloud restarts or redeploys can wipe saved records
