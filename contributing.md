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

For QA harness changes, follow [tests/headless-qa/README.md](tests/headless-qa/README.md)
to install its pinned Python image and lint requirements, then run `npm run qa:lint`
and `npm run qa:smoke` alongside normal validation. The `Offline QA harness` CI job
runs those checks on Node 24 and Python 3.10. Browser/KiCad integration checks remain
local opt-in runs with isolated evidence directories.

The Vitest suite includes a history-wide security hygiene check. It is meant for full validation, CI, security cleanup, and before sharing pushed history; it does not need to be run manually for every intermediate local commit while iterating.

Use `README.md` for the operator-facing overview. Use `systemDesign.md` for the implemented design and `docs/architecture-notes.md` for short implementation notes.

## CI and delivery requirements

CI runs on pushes and pull requests with the three Node validation jobs and the offline QA job. Repository settings must require those passing checks before merging to integration branches. Branch protection and current revision results require separate verification through GitHub; local validation establishes the local working tree's results.

On 2026-10-22, GitHub reported `Development` unprotected and `main` protected with required status-check enforcement off and no required checks; the repository ruleset list was empty. Required merge gates remain unresolved. Enable all three Node validation checks and `Offline QA harness` for both integration branches, then verify them on the revision being merged.

Automated packaging/delivery and a documented store-release/recovery procedure are currently absent. These remain unresolved review requirements. Browser-store publication requires the maintainer's release process and credentials; this repository provides no approved CD exception.

Current automated lint covers JavaScript and the QA harness Python files. Dedicated lint for PowerShell, HTML/CSS, workflow YAML and the local `.agents` matrix scripts remains outside the required CI commands. Manual matrix Ruff/unit checks supplement this scope during review; they do not establish a CI gate.

## Change guidelines

- Make small, explicit changes.
- Update tests with every substantive behavior change.
- Update docs when behavior, support boundaries, or module ownership changes.
- Update `CHANGELOG.md` for user-visible changes, repository validation changes, security changes, and release-relevant fixes.
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
