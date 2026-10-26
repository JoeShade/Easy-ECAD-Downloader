/*
 * Keep browser events separate from final files. Only the configured grouped
 * symbol library permits overwrites; content hashes/timestamps establish the
 * applicable final write independently of download search result order.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const sha256 = content => createHash("sha256").update(content).digest("hex");

// Read balanced S-expressions and collect only top-level symbols; nested symbols
// describe units and drawing styles within those entries.
export function symbolEntries(text) {
  const tokens = String(text).match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) || [];
  const stack = [];
  let root;
  for (const token of tokens) {
    if (token === "(") {
      const node = [];
      if (stack.length) stack.at(-1).push(node);
      else if (root) throw new Error("Multiple symbol-library roots");
      else root = node;
      stack.push(node);
    } else if (token === ")") {
      if (!stack.length) throw new Error("Unbalanced symbol library");
      stack.pop();
    } else {
      if (!stack.length) throw new Error("Atom outside symbol library");
      stack.at(-1).push(token.startsWith('"') ? JSON.parse(token) : token);
    }
  }
  if (stack.length || root?.[0] !== "kicad_symbol_lib") throw new Error("Invalid KiCad symbol library");
  const names = root.filter(node => Array.isArray(node) && node[0] === "symbol").map(node => node[1]);
  if (!names.length || names.some(name => typeof name !== "string" || !name) || new Set(names).size !== names.length) {
    throw new Error("Empty or duplicate symbol entries");
  }
  return names;
}

export function symbolDownloadEvidence(item) {
  // A broken payload remains evidence for this event while accounting continues
  // for other files. Decoding and parsing share that failure boundary.
  try {
    let text = item.symbolLibraryText;
    if (!text && /\.kicad_sym$/i.test(item.filename) && item.symbolDataUrl?.startsWith("data:")) {
      const match = item.symbolDataUrl.match(/^data:[^,]*?(;base64)?,([\s\S]*)$/);
      if (match) text = match[1] ? Buffer.from(match[2], "base64").toString("utf8") : decodeURIComponent(match[2]);
    }
    if (typeof text !== "string") return {};
    return { contentHash: sha256(Buffer.from(text)), expectedEntries: symbolEntries(text), expectationSource: "generated download payload" };
  }
  catch (error) { return { payloadError: error.message }; }
}

// Grouped mode derives its one overwrite-eligible library from validated segments.
function groupedDestination(settings) {
  const root = settings?.libraryDownloadRoot?.replaceAll("\\", "/");
  if (settings?.downloadIndividually !== false || !root || root.split("/").some(segment => !segment || [".", ".."].includes(segment))) return null;
  return `${root}/${root.split("/").at(-1)}.kicad_sym`;
}

// Matching payload bytes establish a final write even when downloads overlapped.
// Otherwise only a write starting after every other completion establishes order.
function chooseFinal(completed, fileHash, intentional) {
  if (!completed.length) return { event: null, ordering: "NO_COMPLETED_WRITE" };
  if (completed.length === 1) return { event: completed[0], ordering: "SINGLE_COMPLETED_WRITE" };
  const matches = completed.filter(item => item.contentHash === fileHash);
  if (intentional && matches.length === 1) return { event: matches[0], ordering: "FINAL_CONTENT_HASH" };
  if (intentional && matches.length === completed.length) return { event: null, equivalent: matches, ordering: "EQUIVALENT_CONTENT; event order unknown" };
  const final = completed.filter(candidate => {
    const start = Date.parse(candidate.startTime);
    return Number.isFinite(start) && completed.every(other => other === candidate ||
      (Number.isFinite(Date.parse(other.endTime)) && Date.parse(other.endTime) < start));
  });
  return final.length === 1 ? { event: final[0], ordering: "NONOVERLAPPING_BROWSER_TIMESTAMPS" } :
    { event: null, ordering: "UNKNOWN; overlapping or missing timestamps/content evidence" };
}

function containedPath(root, filename) {
  const relative = path.relative(root, filename);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Reconcile every event with one final file per destination. The file hash and
// known symbol names establish retention; unrelated path collisions remain failures.
export async function accountDownloads(items, directory, { settings, expectedEntries, extensionId } = {}) {
  const events = [], assets = [];
  const expectedDestination = groupedDestination(settings);
  const root = await fs.realpath(directory);
  const groups = new Map();
  for (const item of items) {
    const destination = path.resolve(item.filename);
    const key = process.platform === "win32" ? destination.toLowerCase() : destination;
    if (!groups.has(key)) groups.set(key, { destination, items: [] });
    groups.get(key).items.push({ ...item, ...symbolDownloadEvidence(item) });
  }
  for (const { destination, items: writes } of groups.values()) {
    const relative = path.relative(root, destination);
    let contained = containedPath(root, destination);
    const stat = contained ? await fs.stat(destination).catch(() => null) : null;
    if (stat) {
      contained = containedPath(root, await fs.realpath(destination));
    }
    const relativePath = contained ? relative.replaceAll(path.sep, "/") : null;
    const intentional = Boolean(relativePath && expectedDestination && relativePath.toLowerCase() === expectedDestination.toLowerCase() &&
      (!extensionId || writes.every(item => item.byExtensionId === extensionId)));
    const collision = writes.length > 1 && !intentional;
    const exists = contained && Boolean(stat?.isFile()), size = exists ? stat.size : 0;
    let readError = null;
    const bytes = exists ? await fs.readFile(destination).catch(error => { readError = error.message; return null; }) : null;
    const fileHash = bytes ? sha256(bytes) : null;
    const completed = writes.filter(item => item.state === "complete");
    const { event: final, equivalent, ordering } = chooseFinal(completed, fileHash, intentional);
    const known = [...new Set([...(expectedEntries || []), ...writes.flatMap(item => item.expectedEntries || [])])];
    const expectationsComplete = Array.isArray(expectedEntries) || writes.every(item => Array.isArray(item.expectedEntries));
    let parsed = [], parseError = readError;
    if (bytes && /\.kicad_sym$/i.test(destination)) {
      try { parsed = symbolEntries(bytes.toString("utf8")); } catch (error) { parseError = error.message; }
    }
    const missing = known.filter(name => !parsed.includes(name));
    const library = /\.kicad_sym$/i.test(destination);
    const completeness = !library ? "NOT_APPLICABLE" : parseError || missing.length ? "FAIL" : expectationsComplete ? "PASS" : "REVIEW";
    const applicable = final ? [final] : equivalent || [];
    const sizeMatches = applicable.length > 0 && applicable.every(item => !(item.bytesReceived > 0) || size === item.bytesReceived);
    const hashMatches = !final?.contentHash || final.contentHash === fileHash;
    const verified = exists && size > 0 && !collision && applicable.length > 0 && sizeMatches && hashMatches && !parseError && !missing.length;
    const asset = { filename: path.basename(destination), relativePath, exists, size, sha256: fileHash, verified,
      eventIds: writes.map(item => item.id), intentionalLibraryOverwrite: intentional && writes.length > 1,
      unexpectedCollision: collision, finalEventId: final?.id ?? null, ordering, sizeMatches,
      applicableEventIds: applicable.map(item => item.id),
      symbolEntries: library ? parsed : undefined, expectedEntries: library ? known : undefined,
      completeness, completenessSource: expectationsComplete ? (Array.isArray(expectedEntries) ? "explicit expectations" : "all generated download payloads") : "authoritative expected-entry list unavailable",
      missingExpectedEntries: missing, parseError, outcome: verified ? "PASS" : !collision && exists && !final ? "REVIEW" : "FAIL" };
    assets.push(asset);
    for (const item of writes) {
      const superseded = intentional && final && item.state === "complete" && item.id !== final.id;
      const outcome = item.state !== "complete" || !contained || collision ? "FAIL" :
        superseded ? "PASS" : asset.outcome;
      events.push({ id: item.id, filename: path.basename(destination), destination, relativePath, byExtensionId: item.byExtensionId,
        state: item.state, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, error: item.error || null,
        startTime: item.startTime || null, endTime: item.endTime || null, contentHash: item.contentHash || null,
        expectedEntries: item.expectedEntries, payloadError: item.payloadError,
        disposition: superseded ? "SUPERSEDED" : item.state !== "complete" ? "INCOMPLETE" : final?.id === item.id ? "FINAL" : equivalent ? "COMPLETED_EQUIVALENT_WRITE" : "ORDER_UNCERTAIN",
        outcome, limitation: superseded ? "Historical bytes intentionally superseded; final file verified separately" : undefined });
    }
  }
  return { events, assets };
}

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
