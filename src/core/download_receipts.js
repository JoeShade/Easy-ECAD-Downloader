/*
 * Observe bounded, ID-scoped browser download completion and validate the
 * delivered model name within the requested portable directory layout.
 */

const MODEL_DOWNLOAD_TIMEOUT_MS = 60000;

// Subscribe before querying so completion during startup stays observable.
// Serialize queries, invalidate snapshots when events arrive, and bound polling
// by the caller's remaining deadline. Every result describes this exact ID.
function waitForDownload(chromeApi, downloadId, requestedFilename, onTerminal, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let querying = false;
    let inspectAgain = false;
    let initialFilename = "";
    let timer;
    let poll;

    function finish(item) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chromeApi.downloads.onChanged.removeListener(changed);
      resolve({ downloadId, requestedFilename, initialFilename, ...item });
    }

    function unverified(error) {
      finish({ state: "unverified", error });
      // Stop abandoned model writes before releasing a Blob URL. A late terminal
      // event retains cleanup ownership until cancellation is acknowledged.
      try {
        chromeApi.downloads.cancel(downloadId, () => {
          if (!chromeApi.runtime.lastError) onTerminal();
        });
      } catch { /* The terminal listener remains responsible for URL cleanup. */ }
    }

    function inspect() {
      if (settled) return;
      if (querying) { inspectAgain = true; return; }
      querying = true;
      try {
        chromeApi.downloads.search({ id: downloadId }, items => {
          querying = false;
          const error = chromeApi.runtime.lastError;
          if (settled) return;
          if (error) { unverified("Browser download query failed."); return; }
          const item = items?.find(candidate => candidate.id === downloadId);
          if (!item) { unverified("Browser download item is missing."); return; }
          if (!initialFilename && item.filename) initialFilename = item.filename;
          // An event during search invalidates its snapshot, including a stale
          // terminal result. Requery after subscribing to obtain a current snapshot.
          if (inspectAgain) { inspectAgain = false; inspect(); return; }
          if (item.state === "complete" || item.state === "interrupted") {
            onTerminal();
            finish({ state: item.state, filename: item.filename, error: item.error,
              exists: item.exists });
          }
        });
      } catch { querying = false; unverified("Browser download query failed."); }
    }

    function changed(delta) {
      if (delta.id === downloadId) inspect();
    }

    chromeApi.downloads.onChanged.addListener(changed);
    timer = setTimeout(() => unverified("Browser download verification timed out."), timeoutMs);
    // API calls also prevent MV3 idle suspension during this bounded request.
    // Worker termination abandons the export and its in-memory receipt state.
    poll = setInterval(inspect, 1000);
    inspect();
  });
}

// Normalize browser-reported drive, UNC and POSIX paths into parent/name pairs.
// Segment checks keep parent traversal and Windows alternate streams outside the
// portable layout used by completedModelFilename.
function parseAbsoluteDownloadPath(value) {
  if (typeof value !== "string" || [...value].some(char => char.charCodeAt(0) < 32)) return null;
  const path = value.replace(/\\/g, "/");
  const windows = /^[a-z]:\//i.test(path) || path.startsWith("//");
  if (!windows && !path.startsWith("/")) return null;
  const segments = path.split("/");
  const filename = segments.pop();
  const start = path.startsWith("//") ? 2 : 1;
  if (path.startsWith("//") && segments.length < 4) return null;
  if (segments.slice(start).some(part => !part || /:/.test(part))) return null;
  if (!filename || segments.some(part => part === "." || part === "..") ||
      filename === "." || filename === ".." || /:/.test(filename)) return null;
  return { directory: segments.join("/"), filename, windows };
}

// A usable receipt proves completion within an unchanged requested directory.
// An earlier selected model anchors the shared Downloads root; only the observed
// basename enters KiCad's portable relative reference.
function completedModelFilename(receipt, anchorReceipt) {
  if (receipt?.state !== "complete" || receipt.exists === false) return "";
  const delivered = parseAbsoluteDownloadPath(receipt.filename);
  const initial = parseAbsoluteDownloadPath(receipt.initialFilename);
  if (!delivered || !initial || delivered.windows !== initial.windows) return "";
  const compare = value => delivered.windows ? value.toLowerCase() : value;
  if (compare(delivered.directory) !== compare(initial.directory)) return "";
  const requested = receipt.requestedFilename.replace(/\\/g, "/").split("/");
  const requestedName = requested.pop();
  if (requested.some(part => !part || part === "." || part === ".." || /:/.test(part))) return "";
  const directory = requested.join("/");
  // Establish the requested relative layout at a segment boundary. Loose mode
  // uses the observed unchanged parent and requires co-location with the project.
  if (directory && !compare(delivered.directory).endsWith(compare(`/${directory}`))) return "";
  if (anchorReceipt) {
    // Removing each requested relative directory yields the inferred Downloads
    // root. STEP and WRL receipts must agree before one can replace the other.
    const anchor = parseAbsoluteDownloadPath(anchorReceipt.filename);
    if (!anchor || anchor.windows !== delivered.windows) return "";
    const anchorDirectory = anchorReceipt.requestedFilename.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    const root = directory ? delivered.directory.slice(0, -directory.length - 1) : delivered.directory;
    const anchorRoot = anchorDirectory ? anchor.directory.slice(0, -anchorDirectory.length - 1) : anchor.directory;
    if (compare(root) !== compare(anchorRoot)) return "";
  }
  if (delivered.filename.split(".").pop().toLowerCase() !== requestedName.split(".").pop().toLowerCase()) return "";
  return delivered.filename;
}

export { completedModelFilename, MODEL_DOWNLOAD_TIMEOUT_MS, waitForDownload };

/*
######################################################################################################################


                                        AAAAAAAA
                                      AAAA    AAAAA              AAAAAAAA
                                    AAA          AAA           AAAA    AAA
                                    AA            AA          AAA       AAA
                                    AA            AAAAAAAAAA  AAA       AAAAAAAAAA
                                    AAA                  AAA  AAA               AA
                                     AAA                AAA    AAAAA            AA
                                      AAAAA            AAA        AAA           AA
                                         AAA          AAA                       AA
                                         AAA         AAA                        AA
                                         AA         AAA                         AA
                                         AA        AAA                          AA
                                        AAA       AAAAAAAAA                     AA
                                        AAA       AAAAAAAAA                     AA
                                        AA                   AAAAAAAAAAAAAA     AA
                                        AA  AAAAAAAAAAAAAAAAAAAAAAAA    AAAAAAA AA
                                       AAAAAAAAAAA                           AA AA
                                                                           AAA  AA
                                                                         AAAA   AA
                                                                      AAAA      AA
                                                                   AAAAA        AA
                                                               AAAAA            AA
                                                            AAAAA               AA
                                                        AAAAAA                  AA
                                                    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA


######################################################################################################################

                                                Copyright (c) JoeShade
                              Licensed under the GNU Affero General Public License v3.0

######################################################################################################################

                                        +44 (0) 7356 042702 | joe@jshade.co.uk

######################################################################################################################
*/
