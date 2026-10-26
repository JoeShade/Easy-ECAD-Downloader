# Contributing to Easy ECAD Downloader

Thanks for contributing.

This repository is a compact browser extension that exports KiCad-compatible CAD assets from supported EasyEDA-backed and SamacSys-backed product pages. Keep the current scope, runtime split, and repository rules in mind when making changes.

Read `AGENTS.md` before changing code, tests, or governance docs.

## Ways to contribute

- Bug reports for broken detection, preview failures, wrong file naming, or bad export behavior
- Compatibility fixes for changed site markup on supported providers
- Focused feature work that fits the current popup, content-script, and service-worker model
- Documentation improvements for setup, troubleshooting, and supported behavior

## Useful bug report details

Include:

- the exact product page URL
- the detected part number or expected part number
- expected behavior versus actual behavior
- browser and OS version
- any relevant popup, content-script, or service-worker errors

For SamacSys-backed pages, note whether previews worked, whether ZIP export failed, and whether the upstream site required sign-in.

## Development setup

Use Node `22.13.0+` recommended, Node `20.19.0+`, or Node `24+`. Node `21.x` is not supported by the current Vitest/Vite/jsdom stack.

1. Clone the repository.
2. Install dependencies with `npm install`.
3. Load the extension unpacked in Chrome or temporarily in Firefox.
4. Run `npm run validate` before finalizing changes.

The repository includes `.nvmrc` for the recommended Node version.

## Manual extension loading

Chrome:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the repository root that contains `manifest.json`.

Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on`.
3. Select `manifest.json` from the repository root.

The development manifest expects Firefox `121+` so Firefox can use the background-document fallback while Chrome uses the Manifest V3 service worker.

## Local validation

Run the local checks with:

```bash
npm install
npm run lint
npm test
npm run validate
```

`npm run validate` runs linting, the Vitest regression suite, a moderate-severity dependency audit, and whitespace checks. CI uses `npm ci` and the same validation script on the supported Node lines.

On Windows PowerShell installations that block npm's script shim, use `npm.cmd` and `npx.cmd` for the same commands.

The browser/KiCad QA harness and all `qa:*` commands are optional developer tools.
They are not required for commits or pull requests, and `npm test` / `npm run validate`
exclude the harness's test suite. Developers working on the harness can use
`npm run qa:lint` and `npm run qa:smoke` after installing the pinned requirements in
[the QA guide](tests/headless-qa/README.md). Live browser/KiCad runs remain local opt-in checks.

Harness source and matrix-management scripts are tracked. Actual test matrices and
campaign evidence stay untracked, normally under the sibling `../qa-run/` directory.
Ignore rules also cover a local `qa-run/` directory and the known matrix filenames
if copied into this checkout.

The Vitest suite includes a history-wide security hygiene check. It is meant for full validation, CI, security cleanup, and before sharing pushed history; it does not need to be run manually for every intermediate local commit while iterating.

Use `README.md` for the operator-facing overview. Use `systemDesign.md` for the implemented design and `docs/architecture-notes.md` for short implementation notes.

## CI and delivery requirements

CI runs on pushes and pull requests with the three Node validation jobs, skipping the QA browser download. The separate `Optional QA harness` workflow runs only through manual `workflow_dispatch` and offers offline checks on Node 24 and Python 3.10. Local validation establishes the local working tree's results.

Version-tag pushes publish the unpacked-extension ZIP and SHA-256 checksum to GitHub Releases through the `Release` workflow. Browser-store publication is managed separately by the maintainer.

Routine lint checks JavaScript, including harness source, without executing the harness. QA Python lint is available through the optional workflow or `npm run qa:lint`. Dedicated lint for PowerShell, HTML/CSS, workflow YAML and the local `.agents` matrix scripts remains outside routine CI. Matrix helper Ruff/unit checks are optional developer checks.

## Packaging and GitHub Releases

Packaging requires Git and Python 3.10+ on PATH and uses only the Python standard library:

```bash
npm run package:test
npm run package
```

The command creates `dist/easy-ecad-downloader-<version>.zip`, its `.zip.sha256` checksum, and `dist/release-notes.md`. These generated files are ignored by Git. The ZIP contains the tracked `manifest.json`, `LICENSE`, runtime JavaScript/HTML/CSS/PNG files under `src/`, and PNG icons under `icons/`. New runtime files must be added to Git's index to be included. Working-tree edits to tracked files are included; text line endings and ZIP metadata are normalized. Developer tooling, QA data, documentation and installation instructions are excluded.

Packaging checks the manifest, package and both root lockfile versions, the matching changelog section, manifest entrypoints, static module/HTML/CSS references, and the final ZIP inventory and bytes. Release notes use only the matching changelog section and link repository documents at the version tag.

To publish, merge the version and changelog changes into `main`, then create and push an annotated tag matching the manifest version. For example, for version 1.1.0:

```bash
git switch main
git pull --ff-only
git tag -a v1.1.0 -m "Easy ECAD Downloader 1.1.0"
git push origin v1.1.0
```

The `Release` workflow reuses the three Node validation jobs, checks that the tag resolves to a commit on `main`, runs the packaging tests, and verifies the package against the tag. It uploads the ZIP and checksum to a draft, then publishes the completed release with changelog notes. No QA harness run is required. Ordinary branch/PR CI does not publish releases.

An interrupted upload leaves a draft that the same workflow can finish on rerun. Published releases are not overwritten by the workflow; corrections use a new version and tag. The workflow uses GitHub's built-in token and needs no separately configured release secret.

## Change guidelines

- Make small, explicit changes.
- Update tests with every substantive behavior change.
- Update docs when behavior, support boundaries, or module ownership changes.
- Update `CHANGELOG.md` for user-visible changes, repository validation changes, security changes, and release-relevant fixes.
- Keep the version in `manifest.json`, `package.json` and both root-package version fields in `package-lock.json` aligned.
- Do not refactor production files unless behavior or repository rules require it.
- Keep browser API orchestration in the worker, DOM extraction in the content script, and UI state in the popup.
- Use the established naming styles: lower snake_case for JavaScript files, lower kebab-case for docs and image assets, and lower camelCase for function declarations.
- Split maintained JavaScript before it grows past the repository line-count limits enforced by the hygiene suite.
- Keep a responsibility explainer at the start of maintained code-bearing files and explain non-obvious domain rules and asynchronous behavior in plain language. Follow the affirmative comment guidance in `AGENTS.md`.

## Pull requests

- Run `npm run validate` before opening or updating a pull request.
- Summarize the user-visible or repository-level impact clearly.
- Call out manual verification, assumptions, and remaining risks.

## Security

Do not commit secrets, browser-profile data, or private keys. Read `SECURITY.md` before reporting credential, permission, relay, or auth-forwarding issues, and report security-sensitive issues privately.

## License

By contributing, you agree that your contributions will be distributed under the repository license.
