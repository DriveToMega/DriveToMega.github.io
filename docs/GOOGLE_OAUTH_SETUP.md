# Google sign-in setup (OAuth Client ID + GitHub secret)

Drive to MEGA signs in to Google with **Google Identity Services' token model**: a public browser client
that only needs an **OAuth Client ID**. There is **no client secret** in this flow, and you must never add
one to the site. Anything shipped to a browser is public.

You'll do this once, in about 10 minutes:

1. Create a Google Cloud project and OAuth Client ID.
2. Save the Client ID as a GitHub Actions secret.
3. Switch GitHub Pages to deploy from GitHub Actions.

---

## 1. Create the OAuth Client ID in Google Cloud

1. Open <https://console.cloud.google.com/> and **create a project** (e.g. `drive-to-mega`).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **Google Auth Platform → Branding** (older consoles call it the *OAuth consent screen*):
   - App name: `Drive to MEGA`
   - User support email: your email
   - App logo: `assets/icons/icon-512.png` (optional; adding one triggers brand review)
   - App home page: `https://drivetomega.github.io/`
   - Privacy policy: `https://drivetomega.github.io/privacy.html`
   - Terms of service: `https://drivetomega.github.io/terms.html`
   - Authorized domains: `drivetomega.github.io`
   - Developer contact: your email
4. **Audience**: User type **External**, publishing status **Testing**. Under **Test users** add every
   Gmail address that will use the app (up to 100).
5. **Data Access → Add or remove scopes**: add
   `https://www.googleapis.com/auth/drive.readonly` (“See and download all your Google Drive files”).
6. **Clients → Create client**:
   - Application type: **Web application**
   - Name: `Drive to MEGA web`
   - **Authorized JavaScript origins**:
     - `https://drivetomega.github.io`
     - `http://localhost:8080` (only if you test locally)
   - **Authorized redirect URIs**: leave empty. The token model uses a popup, not redirects.
7. Click **Create** and copy the **Client ID**. It looks like
   `123456789012-abc123def456.apps.googleusercontent.com`.

> ⚠️ The dialog also shows a **Client secret** (`GOCSPX-…`). **Don't use it anywhere.** This app doesn't
> need it, and putting it in a public site would leak it. The build refuses anything that isn't a Client ID.

## 2. Add the Client ID to GitHub (Actions secret)

1. Open the repository on GitHub → **Settings → Secrets and variables → Actions**.
2. On the **Secrets** tab, click **New repository secret**.
   - **Name:** `GOOGLE_CLIENT_ID`
   - **Secret:** the Client ID from step 1.7
3. Click **Add secret**.

The workflow `.github/workflows/pages.yml` reads `secrets.GOOGLE_CLIENT_ID`, or `vars.GOOGLE_CLIENT_ID`
if you'd rather store it as a plain **Variable** on the *Variables* tab. Either works. `scripts/build.mjs`
validates the value and writes it into `assets/js/config.js` in the deployed copy only. The repository
itself always keeps an empty Client ID, so forks don't inherit yours.

**Why a "secret" for something public?** An OAuth Client ID isn't confidential: every visitor's browser
receives it, and it only works from the origins you listed in step 1.6. Storing it as a secret just keeps it
out of the git history and lets you rotate it without a commit. A **Variable** is equally fine.

## 3. Deploy with GitHub Actions

1. Repository **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. Push to `main`, or open **Actions → Build & deploy to GitHub Pages → Run workflow**.
3. When the run is green, open <https://drivetomega.github.io/>. Clicking **Sign in with Google** now works
   without visiting Settings.

Every deploy also stamps the service-worker version with the commit SHA. Installed apps pick up the update
and show an **Update** button.

## Without the workflow

If you keep Pages on "Deploy from a branch", the site still works: each user opens **⚙ Settings** and pastes a
Client ID. It's stored only in that browser's `localStorage`.

## Rotating or revoking

- **Rotate:** create a new client in Google Cloud, update the `GOOGLE_CLIENT_ID` secret, re-run the workflow,
  then delete the old client.
- **Users revoke access:** <https://myaccount.google.com/permissions>, or **Disconnect** in the app (the app
  revokes the token itself).

## Testing mode vs. going public

`drive.readonly` is a **restricted** scope:

| Mode | Who can sign in | What's required |
|---|---|---|
| **Testing** (recommended for personal/team use) | Up to 100 test users you list | Nothing more. Users see a "Google hasn't verified this app" notice and click **Continue**. |
| **In production** | Anyone with a Google account | Google OAuth verification **and** an annual third-party security assessment (CASA) for restricted scopes. |

For a public launch without the restricted-scope audit, the app would have to switch to the `drive.file`
scope with the Google Picker. Users would then pick files explicitly and couldn't browse their whole Drive.

## Troubleshooting

| Error | Fix |
|---|---|
| `origin_mismatch` / "Not a valid origin" | The exact origin (scheme + host + port, no trailing slash) must be in **Authorized JavaScript origins**. Changes can take a few minutes to apply. |
| `access_denied` / "has not completed the Google verification process" | Add the account under **Audience → Test users**. |
| "Drive access wasn't granted" | On the consent screen, tick **See and download all your Google Drive files**. |
| Pop-up blocked | Allow pop-ups for the site. Google sign-in opens in a small window. |
| `idpiframe_initialization_failed` / third-party cookies | Use a normal (non-incognito) window or allow third-party cookies for `accounts.google.com`. |
