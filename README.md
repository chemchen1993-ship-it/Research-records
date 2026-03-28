# Research Records iPad PWA

This folder contains a separate browser-based iPad app with shared sync. It does not modify or reuse the original Tkinter desktop program.

## What this version includes

- `Experiment Report` and `Notes`
- Project, title, tags, and date fields
- Two-column report editor on iPad
- Rich text sections with inline image insertion and paste
- Hide and restore report sections
- Per-section manual height adjustment with persistence
- Computer + iPad sync through a Python sync server
- Search and grouped sidebar
- Save records, duplicate records, delete records
- Version history on every save
- Draft auto-save every 30 seconds
- Offline app shell through service worker
- Installable PWA shell

## Files

- `index.html`: app shell
- `styles.css`: iPad-friendly UI
- `app.js`: app logic, local draft storage, and sync client
- `manifest.webmanifest`: PWA manifest
- `service-worker.js`: offline caching
- `sync_server.py`: static host + sync API + SQLite storage
- `render.yaml`: internet deployment template for Render
- `Procfile`: generic process entry for platform deploys
- `assets/icon.svg`: icon
- `start_research_records_pwa.bat`: sync server launcher

## Local preview on Windows

Double-click:

`start_research_records_pwa.bat`

Then open:

`http://localhost:8735`

This server also exposes the app on your local network. Use the same server URL on the iPad while both devices are on the same Wi-Fi.

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

### Installing on iPad after deployment

1. Open the site in Safari on iPad.
2. Tap `Share`.
3. Tap `Add to Home Screen`.

## Sync and storage note

Saved records, attachments, and version history are stored in:

- `sync_data/research_records_sync.db`

They sync between this computer and iPad through the shared Python sync server.

The following items stay local on each device:

- auto-saved unsaved drafts
- the last-selected record in the UI

- Desktop app data is not changed
- Desktop SQLite data is not automatically imported
- Desktop browser and iPad browser share saved data only when both use the same sync server
- If you deploy without a persistent disk, cloud restarts or redeploys can wipe saved records
