# Publishing to Google Search Console (and Bing)

The site is ready for indexing. It has a sitemap, robots.txt, canonical URLs, structured data (JSON-LD), social
preview images, `llms.txt` for AI assistants, and a long-form guide page. These steps get it into Google.

## 1. Add the property

1. Open <https://search.google.com/search-console> and click **Add property**.
2. Choose **URL prefix**, not *Domain*: `github.io` subdomains can't be verified by DNS. Enter
   `https://drivetomega.github.io/` and click **Continue**.

## 2. Verify ownership (pick one)

### Option A: HTML tag (recommended, no code changes)
1. In the verification dialog, open **HTML tag** and copy the value of `content="…"`, e.g.
   `<meta name="google-site-verification" content="AbC123…" />` → `AbC123…`.
   Pasting the whole tag also works; the build extracts the token.
2. On GitHub, go to **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   - Name: `GOOGLE_SITE_VERIFICATION`
   - Value: the token
3. Re-run the deploy: **Actions → Build & deploy to GitHub Pages → Run workflow**.
4. When the run is green, click **Verify** in Search Console.

### Option B: HTML file
Download the `googleXXXXXXXX.html` file Search Console offers, commit it to the repository root, and push to
`main`. The build publishes it automatically. Then click **Verify**.

> Keep the tag or file in place after verifying. Google re-checks it periodically.

## 3. Submit the sitemap
In Search Console go to **Indexing → Sitemaps**, enter `sitemap.xml` and click **Submit**.

## 4. Request indexing for the key pages
In **URL inspection**, inspect and click **Request indexing** for:
- `https://drivetomega.github.io/`
- `https://drivetomega.github.io/how-to-transfer-google-drive-to-mega/`

## 5. Check the enhancements
- **Rich Results Test**: <https://search.google.com/test/rich-results>. Run it on both URLs above. You should see
  FAQ, Breadcrumb, Software App and Article data detected with no errors. (Google shows FAQ rich results only
  for some sites, but the data still helps understanding and AI answers.)
- **PageSpeed Insights**: <https://pagespeed.web.dev/>. Check Core Web Vitals on mobile.

## Bing Webmaster Tools (also feeds Copilot and DuckDuckGo)
1. Open <https://www.bing.com/webmasters>. You can **import from Google Search Console** after step 2 above.
2. Or add the site and choose **HTML Meta Tag**. Put the `content` value in a repository variable named
   `BING_SITE_VERIFICATION`, then re-run the deploy and verify.
3. Submit `https://drivetomega.github.io/sitemap.xml`.

## What to expect
New sites usually take a few days to a few weeks to appear in Google. Watch **Performance** and
**Pages** in Search Console, and update `<lastmod>` in `sitemap.xml` when page content changes.

## AI assistants and answer engines
- `robots.txt` explicitly allows AI crawlers: GPTBot, OAI-SearchBot, ClaudeBot, Claude-SearchBot, PerplexityBot,
  Google-Extended, Applebot-Extended and others.
- `/llms.txt` (short summary with links) and `/llms-full.txt` (full facts, limits and FAQ) follow the
  [llms.txt](https://llmstxt.org/) convention, so agents can understand the tool without running JavaScript.
- The home page has a plain-HTML "What is Drive to MEGA?" section with quotable facts. Its FAQ JSON-LD is
  generated from the visible FAQ, so the two never disagree.
