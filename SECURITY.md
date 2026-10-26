# Security Policy

## Supported Versions

Security fixes are made against the active development branch and the current browser-store release where practical. Older unpacked development builds are not separately maintained.

## Reporting a Vulnerability

Please do not open a public issue for credential leaks, auth bypasses, extension permission problems, or relay-forwarding vulnerabilities.

Use the repository's private vulnerability reporting or GitHub Security Advisory flow when available. If that is not available, contact the maintainer through the repository, Chrome Web Store listing, or Firefox Add-ons listing with:

- the affected browser and version
- the product page or provider flow involved
- clear reproduction steps
- the impact you believe is possible
- whether credentials, cookies, downloads, or relay requests are involved

Do not include live credentials, private cookies, browser-profile exports, or private KiCad libraries in reports, tests, fixtures, screenshots, or public discussion.

The repository hygiene suite checks for high-confidence token/private-key patterns, placeholder-only credential fixtures, encoded HTTP Basic auth examples, and common temporary, archive, log, and local-environment files. A separate history-wide security check applies those rules across reachable Git history during full validation and CI. Treat these as backstops, not as a substitute for reviewing changes before commit; the history-wide check does not need to be run manually for every intermediate local commit.

## Credential and Auth Handling

The extension stores ordinary settings in `chrome.storage.local`. That storage can include:

- the optional Firefox SamacSys relay URL
- remember-on-this-device flags for optional secrets
- accumulated KiCad symbol-library text used for library-mode exports

The optional Firefox authentication token and optional SamacSys username/password are stored in `chrome.storage.session` by default, so they are kept only for the current browser session. They are copied to `chrome.storage.local` only when the user explicitly ticks the matching `Remember ... on this device` box after reading the warning in the settings page.

Relay auth and upstream SamacSys auth are intentionally separate. The relay auth header is sent only to the configured user-managed relay. Upstream SamacSys auth is sent only to SamacSys or inside a relay payload that asks the relay to contact SamacSys.

The extension rejects redirects from the configured relay endpoint because the POST body can contain upstream cookies and sign-in details. Configure the final relay URL directly. Settings storage-read failures also stop UI saves and exports rather than substituting defaults that could overwrite saved credentials.

SamacSys destinations require HTTPS on `componentsearchengine.com` or its subdomains at the standard port, with empty URL credentials, before upstream authentication is resolved. The relay example applies this rule to every redirect and clears forwarded cookies and authorization when the origin changes. Its deployment guide uses the `RELAY_BEARER_TOKEN` secret and a `Bearer <token>` header value in the extension settings.

Direct Chrome requests still use automatic redirects: preview and ZIP responses can come from outside the initial destination rule. This open gap is tracked in [docs/deviations.md](docs/deviations.md); cross-origin credential disclosure has not been demonstrated.

The repository-owned ZIP reader validates member checksums, expanded lengths and archive bounds before exporting CAD. It accepts classic stored/deflate single-disk archives with at most 256 MiB of expanded data; unsupported encryption, ZIP64 and multi-disk metadata fail explicitly.

The repository does not host or operate a relay service. Users who configure a relay are responsible for its deployment, access controls, logs, and secret handling.

To clear stored credentials, use the clear buttons in the settings page, untick remember-on-this-device options, or remove the extension's local/session storage from the browser. Removing the extension also clears its extension-owned storage in normal browser configurations.

## Developer QA credentials

The optional Windows QA harness has a separate, checkout-scoped credential cache. It encrypts SamacSys credentials with current-user DPAPI in volatile registry keys and provisions only the isolated extension's session storage. The cache survives individual browser runs until Windows restarts, the user hive unloads, or `npm run qa:auth -- --clear` removes it. Removing the extension does not clear this separate cache. Credential entry visibly echoes in a dedicated console; do not record that console. See [the QA harness guide](tests/headless-qa/README.md) for setup, redaction and clearing commands.

## Security-Sensitive Areas

Please report issues involving:

- over-broad extension permissions or unexpected host access
- credential exposure in popup UI, logs, downloads, tests, fixtures, or docs
- incorrect separation between relay auth and upstream SamacSys auth
- unsafe forwarding of cookies or authorization headers
- HTML or URL parsing that could cause incorrect provider detection
- download path construction that could escape the intended Downloads-relative layout
- dependency or supply-chain vulnerabilities
