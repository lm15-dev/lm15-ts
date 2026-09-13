# lm15.dev: GitHub Pages + GoDaddy

The public playground is a static, client-side SDK demo, hosted by GitHub
Pages from this repository. GoDaddy is only the registrar and authoritative
DNS provider. No application server, proxy, CDN vendor, analytics, API-key
secret, or GoDaddy credential is needed in GitHub Actions.

## Deployment and verification

`.github/workflows/pages.yml` builds on pushes to `main`; pull requests build
and test without deploying. The job:

1. Checks out the Python, Rust and contract revisions in `sources.json`.
2. Installs pinned build tools and npm's locked dependencies.
3. Builds the Python wheel and Rust wasm codec from source on GitHub's runner.
4. Collects the Rust dependency license notices from its locked wasm graph.
5. Runs type checks, the SDK suite and the provider-browser tests.
6. Packages an explicit allowlist of public files into `_site/`.
7. Drives that exact static artifact in Chromium, including all three runtimes,
   multi-turn replay, settings, encrypted remembered keys, forgetting, mobile
   layout, license links, and file checksums. Provider responses are simulated;
   these tests do not spend money or prove a provider allows real browser calls.
8. Uploads only `_site/`. A separate, minimally privileged deployment job
   publishes it to the `github-pages` environment only after every check passes.

The site includes `/release.json` with source revisions and SHA-256 file hashes.
Dependencies and the page use a content-addressed asset directory. That avoids
quietly combining different cached releases, at the cost of downloading runtime
files again after a release. A very old open tab may need a reload after a
release, since Pages only retains the current artifact. Python still loads only
when selected. All runtime files are served by this site, not a third-party CDN.

The packager updates the import map and its CSP hash together. The public CSP
allows HTTPS providers, not local HTTP endpoints. For local servers, run the
local demo. The public site cannot serve the private credential handoff route;
no `.env`, credentials, repository metadata or test server is copied.

GitHub Pages does not support custom response headers. The HTML meta CSP is
useful but cannot enforce every server-side protection (notably
`frame-ancestors`). Do not advertise remembered browser keys as a secure vault.
The page and `/about.html` state the actual storage and trust limits.

### Updates

- Playground/TypeScript: commit and push to `main`.
- Python/Rust: review and update their full commit hashes in `sources.json`.
- Contract: update `CONTRACT_PIN` and `sources.json` together after parity checks.
- Pyodide: update the npm lockfile, matching source/license notices in
  `about.html`, and run the browser tests before publishing.
- The toolchain and third-party GitHub Actions are pinned. Update deliberately.

No personal credentials should ever be added as deployment secrets. Pages
uses GitHub's short-lived deployment token. Anyone who can change the published
scripts can change what happens to keys entered there; repository access and
review are part of the security boundary.

### Local checks

Check out the pinned sibling repositories, then:

```sh
npm ci
npm run build                 # Rust uses rcargo on the author's laptop
npm run check
npm test
node --experimental-strip-types --test tools/provider_ui.test.ts
```

License collection must run where Cargo's dependency sources were downloaded.
For the home build server:

```sh
ssh 192.168.2.24 'python3 - /home/maxime/Projects/lm15-dev/lm15-rs' \
  < tools/rust_licenses.py > vendor/rust/THIRD_PARTY_LICENSES.txt
npm run site:package
npm run site:test
```

Once live, test the deployment with no real keys or paid calls:

```sh
SITE_URL=https://lm15.dev/ npm run site:test
```

The live check uses normal certificate validation and verifies that the
published wasm/wheel bytes match the release manifest.

### Rollback

Revert the offending commit on `main` and push; the same workflow rebuilds,
tests and redeploys the previous source/pins. Do not bypass tests by uploading a
laptop directory. A failed build leaves the last successful deployment live.

## Domain settings

GitHub repository Settings → Pages:

- Source: **GitHub Actions**
- Custom domain: **lm15.dev**
- **Enforce HTTPS** once GitHub finishes issuing the certificate

The domain is associated with the repository **before** pointing DNS at GitHub,
so there is no unclaimed Pages hostname. Keep the domain configured and do not
leave DNS pointing to Pages after disabling/removing the site. For stronger
protection against takeover if the site is removed, use organization Settings →
Pages → **Add a domain** and publish GitHub's ownership-verification TXT record.
That account-level verification is separate from configuring a site's hostname.

GoDaddy DNS (TTL 600 seconds):

| Type | Name | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | lm15-dev.github.io |

GitHub redirects `www` to the canonical `lm15.dev` address. Do not add wildcard
DNS records. Nameservers, domain-connect and unrelated TXT/MX records are left
alone. GitHub provides the HTTPS certificate at no extra cost.

**Domain auto-renewal is off at the owner's request.** The current registration
expires September 12, 2027. Renew it manually before then to keep the site.
