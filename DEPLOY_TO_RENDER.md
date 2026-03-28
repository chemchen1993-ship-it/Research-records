# Deploy Research Records PWA To Render

This project is ready to deploy as a public HTTPS web app with shared sync.

## What this deployment gives you

- A public `https://...` URL
- Shared saved records between computer and iPad
- Installable PWA on iPad through Safari `Add to Home Screen`
- Persistent storage for records, attachments, and version history

## Before you deploy

This folder already includes:

- `sync_server.py`
- `render.yaml`
- `Procfile`
- `.gitignore`

The local Git repository has also been initialized.

## Step 1. Upload this folder to GitHub

From inside this folder:

```powershell
git add .
git commit -m "Prepare public Research Records deployment"
```

Then create a new empty GitHub repository and push:

```powershell
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

## Step 2. Deploy to Render

Recommended deployment target:

- Render Web Service

Why:

- This app needs a long-running Python server
- It also needs persistent disk storage for records and attachments

## Step 3. Render settings

If Render detects `render.yaml`, you can deploy from it directly.

The included template expects:

- Runtime: `Python`
- Start command: `python sync_server.py`
- Health check path: `/api/health`
- Persistent disk mount path: `/var/data/research-records`
- Environment variable: `RESEARCH_RECORDS_DATA_DIR=/var/data/research-records`

The included template already sets these values.

## Step 4. After deployment

1. Open the Render HTTPS URL on the computer browser.
2. Open the same URL in Safari on iPad.
3. On iPad, tap `Share`.
4. Tap `Add to Home Screen`.

## Important behavior

- Saved records sync through the shared Render server
- Unsaved auto-draft data remains local to each device
- If you redeploy without a persistent disk, cloud restarts can wipe records

## Current project structure

The files that matter most for deployment are:

- `index.html`
- `styles.css`
- `app.js`
- `service-worker.js`
- `sync_server.py`
- `render.yaml`
- `Procfile`

