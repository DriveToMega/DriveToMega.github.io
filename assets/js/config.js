// Site configuration. The deploy workflow (.github/workflows/pages.yml) rewrites this file from the
// GOOGLE_CLIENT_ID repository secret/variable. An OAuth *Client ID* is public by design — it is not a
// secret and never grants access on its own. Never put a client *secret* in any file of this site.
window.D2M_CONFIG = Object.freeze({
  googleClientId: ''
});
