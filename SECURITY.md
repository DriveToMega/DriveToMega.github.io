# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through
[GitHub Security Advisories](https://github.com/DriveToMega/DriveToMega.github.io/security/advisories/new).
We aim to acknowledge reports within 72 hours.

## Threat model

Drive to MEGA is a static site with **no backend**. The assets worth protecting all live in the user's browser tab:

- the Google OAuth access token (`drive.readonly`),
- the MEGA password and the session/master key that megajs derives from it,
- the content of the files being transferred.

The main risks are code injection into the page (XSS, a compromised dependency or CDN), framing or
clickjacking, and the leaking of credentials to storage, logs or third parties.

## Controls in place

| Area | Control |
|---|---|
| Script injection | Strict **Content-Security-Policy** on every page: `script-src 'self' https://accounts.google.com/gsi/client`. No `'unsafe-inline'`, no `'unsafe-eval'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. |
| DOM XSS | All UI is built with a small element builder that only writes `textContent` and attributes. `innerHTML` is used only for constant icon markup. File names such as `<img onerror=…>` render as text. |
| Supply chain | megajs is **vendored** (no third-party CDN), checked against the npm registry's integrity hash, and loaded with **Subresource Integrity** (`sha384`). The build fails if the file and the pinned hash drift apart. |
| Network egress | CSP `connect-src` allows only Google APIs and `*.mega.co.nz` / `*.mega.nz` / `*.mega.io`. |
| Credentials at rest | Google token and MEGA password/session are kept **in memory only**. The password field is cleared right after submit. `localStorage` holds preferences only, and Settings has a one-click erase. |
| Least privilege | Google scope is `drive.readonly`, and the app checks that the scope was actually granted. Tokens are revoked on disconnect and when the Client ID changes. |
| Clickjacking | GitHub Pages can't send `frame-ancestors` / `X-Frame-Options`, so a pre-paint script hides the page and breaks out when it's framed. |
| Referrer leakage | `strict-origin-when-cross-origin` page policy. API calls use `referrerPolicy: 'no-referrer'` and `credentials: 'omit'`. |
| Input handling | Drive IDs are validated against `^[A-Za-z0-9_-]+$` and query strings are escaped before use in Drive queries. File and folder names are stripped of control characters. CSV export neutralises spreadsheet formula injection. Client IDs are validated, and pasting a client secret is rejected. |
| Service worker | Caches only same-origin static files. Google and MEGA traffic is never intercepted, so tokens and file contents never reach Cache Storage. |
| Secrets in CI | The only build-time input is the public OAuth Client ID. The workflow uses least-privilege `permissions`, `persist-credentials: false`, and deploys only from `main`. |

## Known limitations

- **No custom HTTP headers on GitHub Pages.** HSTS comes from the `github.io` preload list. `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` and a header-delivered CSP (with `frame-ancestors` and reporting) would need a
  proxy such as Cloudflare in front of a custom domain.
- **Google Identity Services can't use SRI.** Google serves it from a moving URL, so it's allowed by exact URL in the CSP.
- **Browser extensions** with access to the page can read anything the page can. Use a clean browser profile for sensitive accounts.
- **Trust in Google and MEGA.** Files are decrypted by Google's API and re-encrypted locally by MEGA's library.
