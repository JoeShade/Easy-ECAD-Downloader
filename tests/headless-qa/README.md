# Headless QA on Windows 11

This developer-only harness operates the repository's actual unpacked extension in
headless Chrome for Testing. KiCad 10 CLI renders downloaded libraries without a
desktop session or interactive KiCad windows. Production source and the manifest
are unchanged.

## Install

Use Node **22.13+ or 24+** for browser QA, Python **3.10+**, and KiCad **10.x**.
The regression suite retains its existing Node support; the optional Puppeteer
25.13.0 dependency requires Node 22.12 or newer. Windows PowerShell can use
`npm.cmd` when its execution policy prevents `npm.ps1` from running.

From the repository root:

```powershell
npm.cmd ci
python -m pip install -r tests/headless-qa/requirements.txt
npm.cmd run qa:preflight -- --id preflight-001
npm.cmd run qa:smoke
```

`npm ci` installs pinned Puppeteer **25.13.0**, its supported Chrome for Testing
binary, and resvg **2.6.2** for SVG-to-PNG conversion. `.puppeteerrc.cjs` keeps
Chrome under `.qa-output/cache/` and skips the older headless-shell browser.
If browser installation was skipped, run:

```powershell
npx.cmd puppeteer browsers install chrome
```

Preflight launches headless Chrome over a debugging pipe, dynamically installs
the extension, verifies the live service worker and `chrome.action.openPopup`,
opens the actual popup on a blank tab, and checks Python/Pillow plus KiCad's
installed version and command help. It does not demonstrate product detection.
The implementation follows the [Puppeteer extension guide](https://pptr.dev/guides/chrome-extensions);
the installed implementation is also checked by preflight.

## Execute one exact product URL

```powershell
npm.cmd run qa:run -- --url "https://jlcpcb.com/partdetail/0603WAF1002T5E/C25804" --id sample-001 --out ".qa-output"
```

Use a new ID for every attempt. Reusing an existing run directory fails instead
of appending to old downloads or replacing evidence. Output inside the repository
must be gitignored. External output directories are also supported.

The product tab is activated before `chrome.action.openPopup()` creates the real
action popup. The target is additionally verified using the extension's popup
view type. An ordinary `popup.html` tab is never substituted. The runner calls
the real content-script `GET_PART_CONTEXT` handler with no expected identifiers.
It stores independent product-page JSON-LD and labelled fields, final redirects,
the returned context, displayed popup identifiers, option availability, status,
and image decoding/fallback states. It waits for the product DOM to settle before
inspection. Search results, visible login forms, and access-blocked pages stop
the dependent workflow.

The harness clears only its new profile's local/session extension storage, sets
grouped-library mode and `easyECADDownloader` as the library root, selects every
enabled popup export option, and clicks the real Download button. It observes
that button's actual export callback without changing its request or response.
Download accounting waits for the reported number of browser download records
to reach terminal states, then verifies file size, unique paths and existence
on disk. The isolated Chrome profile's download-directory preferences preserve
the extension's filenames; a CDP download override would discard generated
data-URL filenames on the tested Chrome build. It never
calls provider download endpoints or extension conversion functions directly.

Symbol/footprint/3D checkboxes can remain enabled when upstream assets are absent.
The runner records their selection and missing-file review flags; it cannot infer
availability solely from an enabled control. Datasheet export is disabled by the
extension for SamacSys parts.

Options (milliseconds unless stated otherwise):

| Option | Default | Purpose |
|---|---:|---|
| `--timeout` | 45000 | Browser startup, navigation, popup, detection and each preview |
| `--download-timeout` | 180000 | Export response and terminal download completion |
| `--render-timeout` | 180000 | Each KiCad/Python render command |
| `--retries` | 1 | Bounded content-message retries; maximum 3 |
| `--python` | `python` | Python executable; also `QA_PYTHON` |
| `--kicad-cli` | discovered | KiCad executable; also `KICAD_CLI` |

```powershell
npm.cmd run qa:preflight -- --id preflight-002 --python "C:\Python310\python.exe" --kicad-cli "C:\Program Files\KiCad\10.0\bin\kicad-cli.exe"
```

KiCad settings and user-document directories are isolated under the render
output. Browser profiles are deleted after closing Chrome, including failure
cleanup. No normal Chrome profile, existing sign-in session, or credentials are
imported. URLs containing credentials or obvious session query parameters are
rejected. Diagnostic records omit authorization values, email addresses, image
data URLs and common secret query parameters. Full page screenshots are saved
only for classified product pages; blocked/login pages get structured evidence.

Authentication, CAPTCHA, rate limits and access denials are recorded as external
blockers. The harness stops without trying to evade them. This compact harness
does not implement sign-in or credential provisioning. A SamacSys ZIP requiring
authentication may therefore be blocked even when its previews work.

## Render existing downloads

```powershell
python tests/headless-qa/render.py --input ".qa-output/sample-001/downloads" --output ".qa-output/manual-render-001/renders" --project ".qa-output/manual-render-001/inspection-project"
```

Optional renderer flags are `--kicad-cli`, `--timeout` (seconds), and `--project`.
It discovers KiCad on PATH or under `Program Files/KiCad/10.x/bin`. An explicit
path is authoritative. `--preflight --output <new-directory>` checks the Python
and KiCad rendering environment alone. Node must also be on PATH for resvg.

Every top-level symbol entry in every `.kicad_sym` is exported individually with
`sym export svg`. Every `.kicad_mod` gets `fp export svg` views for copper/silk,
fabrication with sketched/numbered pads, and courtyard/fabrication. SVG originals
and decoded PNG copies are preserved. Multiple units/styles produced by KiCad
remain in the entry directory.

The renderer copies the complete download directory into the inspection project
and embeds each footprint **verbatim** into a temporary board placed beside its
copy, preserving model blocks, offsets, rotation, scale and directory context.
A closed rectangular Edge.Cuts outline is computed from footprint geometry and
pad extents. Original files are hashed before/after rendering. Model paths and
placements are never corrected to make a render work. The native text fixture
generator is tested without requiring `pcbnew` bindings.

`pcb render` produces 1200×900 top, isometric and side views. KiCad 10.0.1's
argument parser accepts the positive equivalent `315,0,45` for the isometric
rotation. A known-good relative WRL reference is calibrated first by rendering
a synthetic red block and checking that its pixels appear. Calibration failure
marks model assessment BLOCKED as a fixture/environment problem. Calibration
success plus an unresolved exported path is an exported-asset REVIEW, without
guessing its cause. File existence alone does not prove KiCad loaded a model or
that its placement is correct. Rendering STEP assets uses KiCad's own importer.

Run the known-good rendering fixture separately from live integration:

```powershell
python tests/headless-qa/render.py --input "tests/headless-qa/fixtures/known-good" --output ".qa-output/offline-fixture-001/renders" --project ".qa-output/offline-fixture-001/inspection-project"
```

`qa:smoke` runs deterministic JS and Python checks with no Chrome, KiCad or
network required: atomic persistence, exclusive run isolation, download
containment/completion, bounded timeouts (including a hung observation),
redaction, exact fixture preservation, closed outlines and failure evidence.
The separate command above exercises real KiCad rendering of synthetic assets.

## Evidence and interpretation

Each browser run contains:

```text
<out>/<id>/
  metadata.json
  result.json
  execution.log
  browser/                 product fields, product/popup/preview screenshots
  downloads/               original grouped library tree
  renders/environment/     installed version and command help
  renders/assets/          SVGs, PNGs, render-result.json, command log
  inspection-project/      calibration and copied assets with temporary boards
```

Standalone rendering creates `render-result.json` and `execution.log` in the
chosen render directory. Browser metadata records Node, Chrome, Puppeteer,
Python, Pillow, KiCad, extension version, commit and dirty-tree state. Each stage
is saved atomically before and after execution. `RUNNING`, `COMPLETED`, `FAILED`
and `NOT_RUN` describe execution; check outcomes are separate:

- `PASS`: the specifically named condition was established, such as image decoding.
- `FAIL`: an observed mismatch or failed harness/command check.
- `BLOCKED`: environment or external precondition prevented the check.
- `REVIEW`: ambiguity, missing availability evidence, or required visual inspection.
- `NOT_RUN`: a dependent stage was not attempted.

An overall execution of `COMPLETED` does not mean all checks passed or all stages
ran. Read stage execution plus outcomes. A detection FAIL can coexist with later
completed popup/download stages; a download failure can leave rendering NOT_RUN.
Partial completed CAD downloads are still rendered. Exit codes are 0 for
PASS/REVIEW-only results, 1 for FAIL, and 2 for BLOCKED-only results.

Successful decoding or a nonblank-image heuristic is never a claim of component
correctness. Pin mapping, dimensions and model alignment require inspection.
Browser QA is local opt-in validation; deterministic JS smoke tests also run in
the normal Vitest suite. Run `npm.cmd run validate` before finalizing changes.
