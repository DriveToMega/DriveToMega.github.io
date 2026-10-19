# Drive to MEGA

A single-page web app that copies files and folders from **Google Drive** to **MEGA**, entirely in the browser. No backend, no database — host it on GitHub Pages.

## How it works

- **Google Drive** — signs in with Google Identity Services using the read-only scope `drive.readonly`. Files are streamed from the Drive API (`files.get?alt=media`).
- **MEGA** — logs in with [megajs](https://github.com/qgustavor/mega) (supports 2FA). Each Drive stream is piped straight into MEGA's client-side encryption and uploaded in chunks, so large files never sit fully in memory.
- Folders are recreated in MEGA with the same structure (existing folders with the same name are reused).
- Google Docs/Sheets/Slides are exported as `.docx/.xlsx/.pptx` (or PDF, or skipped).
- Files that already exist in the destination (same name + size) are skipped by default.
- Shortcuts are followed; "Shared with me" and Shared drives are supported.

> Data flows **Google → your browser → MEGA**, so your own connection is used for both the download and the upload. Keep the tab open until the queue finishes.

## One-time setup (Google OAuth Client ID)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → User type *External* → leave it in *Testing* → add your Gmail under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. **Authorized JavaScript origins** → add the exact origin you'll host on, e.g.
   - `https://ashenwijesingha.github.io`
   - `http://localhost:8080` (for local testing)
6. Copy the Client ID, open the app, click **⚙ Settings**, paste it, save.

No client secret is needed — this is a public browser client.

`drive.readonly` is a restricted scope. In *Testing* mode it works for up to 100 test users you list yourself, which is fine for personal or team use. Making it public for anyone would require Google's verification.

## Deploy to GitHub Pages

```bash
git init drive-to-mega && cd drive-to-mega
# copy index.html and README.md in
git add . && git commit -m "Drive to MEGA"
git branch -M main
git remote add origin https://github.com/AshenWijesingha/drive-to-mega.git
git push -u origin main
```

Then **Settings → Pages → Deploy from branch → main / root**. Your app is at `https://ashenwijesingha.github.io/drive-to-mega/`, and the OAuth origin is `https://ashenwijesingha.github.io`.

To test locally: `npx serve -l 8080 .` (opening the file directly via `file://` won't work with Google sign-in).

## Limits worth knowing

- **Google sessions last ~1 hour.** If a long queue runs past that, transfers pause and a "Renew Google session" banner appears — one click resumes. A file that's already streaming keeps going.
- **Google export cap:** Docs/Sheets/Slides exports are limited by Google to about 10 MB each.
- **MEGA storage:** the app warns if the queued size exceeds your free space.
- **Very large libraries:** for multi-terabyte, unattended, server-side copies, `rclone` on a VPS (`rclone copy gdrive: mega:`) is the better tool; this app is for doing it from a browser without installing anything.

## Privacy

- The MEGA password is sent only to MEGA's API and is never stored.
- The Google token lives in memory only; the Client ID is saved in `localStorage`.
- There's no server — nothing passes through anyone else's infrastructure.
