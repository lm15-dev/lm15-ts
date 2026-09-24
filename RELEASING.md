# Releasing lm15 (TypeScript)

## The first version: once, by hand

npm's trusted publishing is configured per package, so the package must exist
first. The maintainer publishes `1.0.0-rc.1` from a clean checkout:

```bash
git status --short          # nothing
npm login                   # opens the browser
npm publish                 # prepublishOnly runs check, build and every test first
npm view lm15 dist-tags     # latest: 1.0.0-rc.1
```

It becomes `latest` as the only version, so `npm install lm15` installs it;
the README says it is a release candidate.

Then, on npmjs.com: package **lm15** → Settings → Trusted publisher →
GitHub Actions, organization `lm15-dev`, repository `lm15-ts`, workflow
`release.yml`, environment `npm`. From then on no token or login is needed.

## Every later version: from GitHub

1. Set `version` in `package.json` (`1.0.0-rc.2`, `1.0.0`, ...), commit, push;
   `ci` must be green (tests on Linux, macOS and Windows; the contract harness;
   the packed package loads).
2. Create a GitHub release with tag `v<version>` (mark release candidates as
   pre-releases). The `release` workflow checks that the tag matches, runs
   everything again, and waits for the maintainer's approval (environment
   `npm`) before publishing with provenance.
3. A release candidate goes to the `next` tag once a stable version holds
   `latest`; before that it is `latest`.

## History

`v1.0.0` was once a git tag here (2026-06-11, an early prototype). It was
never published to npm; the tag is now `prototype-2026-06-11`.
