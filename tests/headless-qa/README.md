# Background browser QA on Windows 11

This developer-only harness operates the repository's actual unpacked extension in
headed Chrome for Testing on a private Windows desktop. Its windows never appear
on the user's input desktop or take focus from their work. KiCad 10 CLI renders
downloaded libraries without interactive KiCad windows. Production source and the
manifest are unchanged. The existing `tests/headless-qa/` path and commands remain.

## Install

Use Windows **11**, Node **22.13+ or 24+**, Python **3.10+**, and KiCad **10.x** for browser QA.
The regression suite retains its existing Node support; the optional Puppeteer
25.13.0 dependency requires Node 22.12 or newer. Windows PowerShell can use
`npm.cmd` when its execution policy prevents `npm.ps1` from running.

From the repository root:

```powershell
npm.cmd ci
python -m pip install -r tests/headless-qa/requirements.txt
python -m pip install -r tests/headless-qa/requirements-lint.txt
npm.cmd run qa:preflight -- --id preflight-001
npm.cmd run qa:lint
npm.cmd run qa:smoke
```

`npm ci` installs pinned Puppeteer **25.13.0**, its supported Chrome for Testing
binary, and resvg **2.6.2** for SVG-to-PNG conversion. `.puppeteerrc.cjs` keeps
Chrome under `.qa-output/cache/` and skips the older headless-shell browser.
If browser installation was skipped, run:

```powershell
npx.cmd puppeteer browsers install chrome
```

Preflight launches headed Chrome over a debugging pipe, dynamically installs
the extension, verifies the live service worker and `chrome.action.openPopup`,
opens the actual popup on a blank tab, and checks Python/Pillow plus KiCad's
installed version and command help. It does not demonstrate product detection.
Missing cached Chrome reports the install command above before native launch. The implementation follows the [Puppeteer extension guide](https://pptr.dev/guides/chrome-extensions);
the installed implementation is also checked by preflight.

The configured `--python` executable also runs the standard-library Win32 launcher.
It creates a unique `EasyEcadQa-*` desktop, forwards Puppeteer's existing debugging
pipes, and starts Chrome suspended until it belongs to a Windows job that terminates
its process tree if the launcher exits unexpectedly. No debugging port is opened.
Chrome's first window is created minimized and unfocused, then restored and activated
only on that private desktop so genuine action popups and screenshots work normally.
The harness never switches the user's input desktop. Desktop isolation is mandatory:
an unavailable desktop, job or debugging pipe blocks the run without a foreground
or headless fallback. Offline smoke tests remain cross-platform.

## Execute one exact product URL

```powershell
npm.cmd run qa:run -- --url "https://jlcpcb.com/partdetail/0603WAF1002T5E/C25804" --id sample-001 --out ".qa-output"
```

Use a new ID for every attempt. Reusing an existing run directory fails instead
of appending to old downloads or replacing evidence. Output inside the repository
must be gitignored. External output directories are also supported.

The product tab is activated within the private desktop before `chrome.action.openPopup()` creates the real
action popup. The target is additionally verified using the extension's popup
view type. An ordinary `popup.html` tab is never substituted. The runner calls
the real content-script `GET_PART_CONTEXT` handler with no expected identifiers.
It stores independent product-page JSON-LD and labelled fields, final redirects,
the returned context, displayed popup identifiers, option availability, status,
and image decoding/fallback states. It waits for the product DOM to settle before
inspection. Search results, visible login forms, and access-blocked pages stop
the dependent workflow. Login classification checks computed visibility and
ancestor opacity so hidden login dialogs preserve product-page classification.

The harness clears only its new profile's local/session extension storage, sets
grouped-library mode and `easyECADDownloader` as the library root, selects every
enabled popup export option, and clicks the real Download button. It observes
that button's actual export callback without changing its request or response.
Download accounting waits for the reported number of browser download records
to reach terminal states, then separates browser **events** from final filesystem
**assets**. Only the configured grouped symbol-library path permits intentional
overwrites, with extension provenance checked on live runs. Earlier completed
versions are retained as superseded events; their byte counts are not compared
with the final overwritten file. Unexpected duplicate paths still fail.

The final write is identified through matching generated-payload hashes or
strictly nonoverlapping browser start/end timestamps, never search-result order.
Equivalent contents can verify a file without identifying the last event; this
uncertainty remains REVIEW. Missing ordering evidence leaves the asset unverified.
The final symbol library's S-expression structure and entry names are checked.
Known expected entries come from all available generated download payloads;
deterministic fixtures also supply an authoritative expected list. Missing names
fail. When a complete expected list is unavailable, completeness is REVIEW.
This establishes retention of known exported entries, not upstream CAD coverage.
KiCad parsing/rendering is a separate check. Downstream discovery uses verified
final assets, not historical download events.

Completed-download accounting is saved before final popup evidence is captured.
A closed popup leaves its capture BLOCKED while preserving the download inventory
and copied assets. Cleanup rechecks acquisition files after Chrome exits; late or
changed files retain the acquisition directory for recovery.

The isolated Chrome profile's download-directory preferences point to a separate,
short temporary acquisition directory. This prevents nested evidence paths from
making Chrome truncate otherwise ordinary filenames on Windows. Final files are
copied into the run's `downloads/` tree without renaming or changing their bytes;
size and SHA-256 checks verify both the acquisition and evidence copies. Browser
events keep their actual acquisition destinations, and preservation metadata
records both roots. A failed copy is a harness BLOCKED result, and unpreserved
acquisitions remain available for recovery. A CDP download override would discard
generated data-URL filenames on the tested Chrome build. The harness never
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
| `--samacsys-login` | off | Reuse Windows' memory cache; prompt when it is empty |

```powershell
npm.cmd run qa:preflight -- --id preflight-002 --python "C:\Python310\python.exe" --kicad-cli "C:\Program Files\KiCad\10.0\bin\kicad-cli.exe"
```

KiCad settings and user-document directories are isolated under the render
output. Each browser run uses a unique `easy-ecad-qa-*` profile in the system
temporary directory, independently of the evidence path. Nesting profiles under
long campaign/run paths can exceed Windows path limits for Chrome's extension
storage and fail with `IO error: .../LOCK: File not found.`. Browser downloads use
their own unique `ecad-dl-*` directory in the system temporary directory; evidence
copies retain the delivered relative library layout under the selected run.
Both temporary paths and the private desktop mode are logged. Profiles are deleted
only after the launcher exits and its receipt confirms the Chrome process tree has
stopped and the desktop was released, including failure cleanup. Missing cleanup
confirmation retains both temporary directories with a BLOCKED finding. Acquisition directories are removed only when empty
or all contents have been preserved. Failed preservation and unaccounted partial
downloads retain that directory with a recovery path in `execution.log`.
No normal Chrome profile, existing sign-in session, or credentials are
imported. URLs containing credentials or obvious session query parameters are
rejected. Diagnostic records omit authorization values, email addresses, image
data URLs and common secret query parameters. Full page screenshots are saved
only for classified product pages; blocked/login pages get structured evidence.

Windows automation sandboxes that deny Chrome's GPU/network child processes can
cause a separate browser startup timeout, even without loading an extension.
Run the harness in a normal local terminal or through approved native-process
execution when those subprocess permissions are unavailable. Short profile paths
address the extension-storage failure; they do not grant process permissions.
Ctrl+C requests termination of the owned browser job and runs evidence cleanup.
An abrupt launcher/parent exit also terminates the owned browser tree. A forced
exit without a cleanup receipt retains the temporary directories for inspection.

### Reuse SamacSys credentials until Windows restarts

Before starting a full matrix, run this gate from the repository root (including
from a noninteractive agent terminal):

```powershell
Remove-Item Env:DEBUG, Env:NODE_DEBUG, Env:NODE_DEBUG_NATIVE -ErrorAction SilentlyContinue
npm.cmd run qa:auth -- --terminal
if ($LASTEXITCODE -ne 0) { throw 'Credential setup did not complete; do not start the matrix' }
```

It opens a separate visible console on your working desktop and waits for you to
enter SamacSys username/password there. Both fields remain visible as you type.
This console intentionally takes focus; Chrome continues on its private desktop.
No credential-console output is captured by the calling agent or evidence logs.
The command prompts for a new pair even when the cache already contains credentials.
A valid submission replaces the cache; cancellation or invalid input keeps the old
cache and returns a failure, so the matrix must not begin. Closing the console,
Ctrl+C, Escape or the 15-minute setup timeout also blocks startup.

After exit code 0, initialise the campaign, run preflight, then include
`--samacsys-login` for each SamacSys case. Cache provisioning is not upstream login
verification. Do not launch the full matrix in parallel with credential setup.
The tracing-variable removal above affects only that shell and its child commands.
Repeat it in each separate agent shell invocation that uses credentials.

For manual entry in an already interactive terminal, the existing command remains:

```powershell
npm.cmd run qa:auth
npm.cmd run qa:run -- --samacsys-login --url "https://www.mouser.co.uk/en/ProductDetail/YAGEO/RC0603FR-0710KL?qs=grNVn54RoB%252B3GtjbJj3wJQ%3D%3D" --id samacsys-session-001
```

When the cache is empty, the terminal prompts for **SamacSys** username and password with both fields
visible as you type. Use the account accepted by SamacSys/Component Search Engine, rather than
distributor account credentials. Enter finishes a field; Backspace edits it;
Ctrl+U clears it; Ctrl+C or Escape cancels. `qa:auth` populates the cache independently
of product navigation; an authenticated run can also populate it on first use.
`qa:auth -- --prompt` always asks for replacement credentials in the current terminal;
it is also the child mode used by `--terminal`. `--clear`, `--terminal` and `--prompt`
are mutually exclusive.
Subsequent `--samacsys-login` runs reuse it automatically, including after failures
and after closing terminal/browser windows. Cached runs also work without a TTY;
initial entry requires one. Redirected credential input is rejected.
There are no secret command-line, environment or
file inputs, so the command itself contains no credentials.
Disable `DEBUG`, `NODE_DEBUG` and `NODE_DEBUG_NATIVE` before this mode; it refuses
debug tracing that could print terminal input or Chrome protocol arguments.

The Windows cache encrypts both fields with current-user DPAPI and holds the
encrypted payload in a fresh GUID-named **volatile** registry key under
`HKCU\Software\EasyECADDownloader\HeadlessQaSessions\<checkout-hash>`.
The checkout hash isolates repositories; a named mutex serializes access.
Fresh secret keys prevent an existing nonvolatile key from ignoring the volatile
creation option. Only the nonsecret active-key name is placed in its parent.
[Volatile keys stay in memory and are excluded from saved registry data](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regcreatekeyexw).
The cache clears when Windows restarts or the user hive unloads, which can happen
on sign-out. It is scoped to your Windows account and checkout. Private Node/
PowerShell stdin/stdout pipes carry values; helper responses are never logged.
No background keeper, startup task or permanent Credential Manager entry is used.

To discard or replace cached credentials before restarting:

```powershell
npm.cmd run qa:auth -- --clear
npm.cmd run qa:auth
```

For each browser run, the harness copies the values into `chrome.storage.session`, restricts access
to trusted extension contexts and forces `rememberSamacsysCredentials: false`.
Session storage is [in memory](https://developer.chrome.com/docs/extensions/reference/api/storage#session),
not persisted in the profile. The extension's existing auth path consumes these
settings without changing production behavior. It retries an unauthorized
SamacSys ZIP request with configured Basic auth; provisioning does not prove
that the service accepted the login. Metadata records only the mode and whether
configuration succeeded. Exact entered values and their common encoded forms
are redacted from evidence and runtime errors in addition to structural redaction.
Screenshots are omitted with a REVIEW record if their DOM echoes an entered value.
The runner clears Chrome session storage, closes Chrome and deletes its isolated profile
on completion or a caught failure, with browser shutdown handling terminal
interruption. Node discards its credential references and redaction registry
when the run ends. The shared Windows cache remains for later runs. Credentials
are never written to the harness's files or logs.

This option authenticates SamacSys requests; it does not log in to Mouser or
Farnell, import browser cookies, or change distributor navigation. A product-page
403 or protocol error can still stop the run before any SamacSys request.

Authentication, CAPTCHA, rate limits and access denials are recorded as external
blockers. The harness stops without trying to evade them. Its default mode is
unauthenticated. A SamacSys ZIP requiring authentication can therefore be blocked
even when its previews work; the optional terminal credentials do not guarantee
access. Successful
preview evidence is retained, but an authentication-blocked export is not an
end-to-end validated provider flow. Website login and account management remain
outside the harness.

Named identifier checks separately compare page fields with detected MPN,
distributor number and supported manufacturer name, then compare the actual
popup display with both detection and available page evidence. Identifiers only
trim surrounding whitespace: punctuation, case, suffixes and order-code characters
remain meaningful. Manufacturer names and source labels collapse whitespace and
case, without invented aliases. Missing/conflicting references produce REVIEW.
EasyEDA's absent manufacturer name is REVIEW because that provider does not
expose it. JLCPCB uses the documented **LCSC part** popup label; Farnell-family
labels follow the documented site conventions. Popup activation and identifier
agreement are distinct checks.

CDP Runtime/Log listeners are installed before extension loading and navigation,
including Chrome's `other` action-popup target type. Uncaught exceptions and
console warnings/errors stream to `execution.log` and atomically saved
`browser/diagnostics.json`. Records include timestamps, context, source URL,
stage and bounded messages. Capture is capped at 200 records with a dropped count;
listeners and CDP sessions are removed during cleanup. Retries retain their first
failure and final execution result. Generic fetch/network/preview/export errors
remain observations with **unknown cause**. Only explicit access evidence, such
as an authentication requirement or an HTTP access status, establishes an external
blocker; demonstrated environment/harness timeouts retain their own category.
Product-page `net::ERR_*` transport errors are navigation `BLOCKED` observations
with unknown cause: no extension detection, preview or export has run yet.
SamacSys's sign-in-required message and its entry/preview/ZIP HTTP 401, 403 and 429
errors are also `BLOCKED`, rather than component failures. Credentials configured
in the harness authenticate SamacSys ZIP requests; they do not establish distributor
page access. A passing blank-page preflight does not establish product navigation.

Evidence redaction recursively copies structured objects and arrays before
serialization. Concurrent saves publish complete snapshots in call order.
Diagnostic attachment uses stable target IDs to capture startup events once and
retain current source URLs. Sensitive keys, URL credentials/query values, authorization text
and image/blob payloads are omitted without modifying component identifiers or
downloaded assets. It is applied to metadata, redirects, contexts and diagnostics.

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
remain in the entry directory. When back-side content is present, additional
back copper/silk, fabrication and courtyard views are exported. Through-hole
pad layer wildcards also trigger back views. Each inspection records its layers.

The renderer copies the complete download directory into the inspection project
and embeds each footprint into a temporary board placed beside its copy,
preserving model blocks, offsets, rotation, scale and directory context. Legacy
arc syntax is translated to equivalent start/mid/end syntax only in the embedded
fixture text because modern boards cannot load legacy angle-based arc records.
`fixtureNormalizations` records each translation; source files stay unchanged.
A closed rectangular Edge.Cuts outline is computed from complete circle extents,
arc sweep extrema, translated primitive coordinates, and rotated pad extents.
Cubic curves use their conservative control-point hull. Margin is at least 2 mm
or 15% of the footprint span. Native-compatible zero-radius point arcs are retained
and recorded in `geometryObservations`; they are not repaired. Other malformed or
nonfinite geometry, unsupported graphic types/custom pad primitives, and unexpected
root placement are rejected explicitly. Original files are hashed before/after
rendering, including failed exits. Model paths and
placements are never corrected to make a render work. The native text fixture
generator is tested without requiring `pcbnew` bindings.

`pcb render` requests 1200 x 900 top, isometric and side views; image checks record
the actual PNG dimensions returned by the installed KiCad build. KiCad 10.0.1's
argument parser accepts the positive equivalent `315,0,45` for the isometric
rotation. A known-good relative WRL reference is calibrated first by rendering
a synthetic red block and checking that its pixels appear. Calibration failure
marks model assessment BLOCKED as a fixture/environment problem. Calibration
success plus an unresolved exported path is an exported-asset REVIEW, without
guessing its cause. A synthetic STEP solid is also calibrated against a model-free
control image: changed pixels establish visible known-good model geometry.

Every downloaded `.step`, `.stp` and `.wrl` has an explicit model inventory record:
original relative path/hash, verified-download status, actual footprint references,
exercise kind, commands/images, outcome and limitations. Primary assembly boards
preserve exported geometry and model transforms, with the fixture-only arc syntax
translation recorded above. Additional models use clearly labelled
**derived-model-inspection** fixtures with a relative reference and identity
transforms. These unassociated importer fixtures do not establish that an original
reference works or that a model aligns with a footprint. No association is guessed.
The inventory retains models that could not be exercised, with an outstanding
limitation. File existence, command success and decoded images do not prove that
general model geometry appeared. Model results remain REVIEW for visual assessment.
All derived fixture changes occur in the inspection project; originals stay untouched.

Derived model outlines scale to conservative source-model bounds when available.
Transparent camera-fit probes check image-edge clearance and retain bounded zoom
attempts before the final opaque view. Exhausted fitting remains REVIEW with an
outstanding inspection. Image containment does not prove that the expected model
geometry appeared or that its association, dimensions or placement are correct.

Run the known-good rendering fixture separately from live integration:

```powershell
python tests/headless-qa/render.py --input "tests/headless-qa/fixtures/known-good" --output ".qa-output/offline-fixture-001/renders" --project ".qa-output/offline-fixture-001/inspection-project"
```

`qa:lint` runs pinned Ruff's default correctness rules (E4, E7, E9 and F) on the
QA Python implementation and tests. `npm run lint` covers QA JavaScript. Install
`requirements-lint.txt` alongside the image requirements before these local checks.
The `Offline QA harness` CI job runs Python linting and the same JS/Python smoke
command on Node 24 and Python 3.10, with browser downloads skipped at installation.
Native Chrome/KiCad integration remains local opt-in validation.

`qa:smoke` runs deterministic JS and Python checks with no Chrome, KiCad or
network required: atomic persistence, exclusive run isolation, download
containment/completion, bounded timeouts (including a hung observation),
structural redaction, merged-library retention/collisions, identifier comparisons,
runtime capture/cleanup and classification, partial coverage, download preservation,
legacy-arc compatibility, circle/arc/rotated-pad bounds, camera fitting, back views, complete model inventory,
visible credential entry, session-only settings, cache reuse/clearing and credential cleanup/redaction.
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
Partial completed CAD downloads are still rendered. A failure between stages
retains a top-level failure finding and a nonzero exit. Exit codes are 0 for
PASS/REVIEW-only results, 1 for FAIL, and 2 for BLOCKED-only results in the underlying
runner; npm on Windows may normalize a nonzero script exit to 1.

**Schema 2:** `downloads.events` retains every browser event and its destination,
state/times/bytes/error/disposition. `downloads.assets` replaces the earlier
event-based `downloads.files` inventory with one record per final file. Metadata
and results are redacted structurally. Renderer `models` inventories every model;
`missingModelReferences` records unresolved original references. Command indices
inside model exercises refer to the renderer's `commands` array. `--inventory
<result.json>` requires schema 2, safe relative paths, explicit verification and
matching current file sizes and SHA-256 hashes before rendering. Malformed symbol
libraries and model references retain outstanding inspection records while valid
assets keep their own coverage. Omit this flag for standalone rendering of a
supplied directory. Existing schema-1 evidence
is preserved rather than migrated.

Run and renderer `coverage` summarize expected, attempted, produced and outstanding
assets/inspections. The renderer plans inspections before CLI preflight so blocked
commands leave concrete tasks outstanding. A browser run with unavailable rendering
reports an unavailable plan and pending rendering instead of assuming zero work.
Completed execution is never labelled fully inspected: automated evidence leaves
visual inspection pending. `liveWorkflowEvidenceProduced` requires complete stage
execution, selected assets, decoded previews, produced inspections and no failed/
blocked checks or runtime errors. It does not assert geometry appearance or visual
correctness. `liveEndToEndDemonstrated` stays false while review remains outstanding.
Offline fixtures
and synthetic runtime probes are not live provider validation.

New renderer reports identify `browser-run-render` (a supplied browser accounting
inventory) versus `standalone-render` and record the input directory. Standalone
input-file eligibility does not establish browser download completion or provenance.

Successful decoding or a nonblank-image heuristic is never a claim of component
correctness. Pin mapping, dimensions and model alignment require inspection.
Browser QA is local opt-in validation; deterministic JS smoke tests also run in
the normal Vitest suite. Run `npm.cmd run validate` before finalizing changes.
