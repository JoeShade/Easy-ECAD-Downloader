/*
 * Preserve browser-delivered bytes and asset names under the evidence root.
 * Acquisition paths stay independent of evidence-directory depth on Windows.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { sha256 } from "./download_accounting.js";

function preservationError(message) {
  return Object.assign(new Error(message), { outcome: "BLOCKED", category: "harness", cause: "download preservation" });
}

function contained(root, filename) {
  const relative = path.relative(root, filename);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function overlaps(first, second) {
  return !path.relative(first, second) || contained(first, second) || contained(second, first);
}

// Accept portable relative segments before applying the host filesystem's rules.
function segments(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || [...relativePath].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) {
    throw preservationError("Download has no safe relative evidence path");
  }
  const parts = relativePath.replaceAll("\\", "/").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw preservationError("Download relative path contains traversal or empty segments");
  }
  return parts;
}

// Inspect each existing component before reading or creating the next component.
// Resolved containment and link checks keep acquisition and evidence trees separate.
async function inspectPath(root, parts, createParents = false) {
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (!contained(root, current)) throw preservationError("Download path escapes its root");
    const parent = index < parts.length - 1;
    if (parent && createParents) {
      await fs.mkdir(current).catch(error => { if (error.code !== "EEXIST") throw error; });
    }
    const stat = await fs.lstat(current).catch(error => {
      if (error.code === "ENOENT" && !parent && createParents) return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw preservationError("Download preservation refuses symbolic links");
    if (parent && !stat?.isDirectory()) throw preservationError("Download parent is not a directory");
    if (stat && !contained(root, await fs.realpath(current))) throw preservationError("Resolved download path escapes its root");
  }
  return current;
}

// Bind the read to one regular file and compare its identity after inspection.
async function readRegularFile(root, parts) {
  const filename = await inspectPath(root, parts);
  const before = await fs.lstat(filename);
  if (!before.isFile()) throw preservationError("Download source is not a regular file");
  // An open handle retains the inspected file identity during the read.
  // O_NOFOLLOW enforces the leaf-link constraint where the host supports it.
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    await inspectPath(root, parts);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw preservationError("Download source changed before preservation");
    }
    return { bytes: await handle.readFile(), stat: opened };
  } finally { await handle.close(); }
}

// Copy exclusively, then reread both roots so a concurrent change retains the
// acquisition directory for recovery instead of authorizing its removal.
async function preserveAsset(asset, sourceRoot, evidenceRoot) {
  const parts = segments(asset.relativePath);
  if (!Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/i.test(asset.sha256 || "")) {
    throw preservationError("Download accounting lacks a size or SHA-256 for preservation");
  }
  const { bytes, stat: before } = await readRegularFile(sourceRoot, parts);
  if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
    throw preservationError("Download source no longer matches its accounted size/SHA-256");
  }
  const destination = await inspectPath(evidenceRoot, parts, true);
  await fs.writeFile(destination, bytes, { flag: "wx" });
  const { bytes: preservedBytes } = await readRegularFile(evidenceRoot, parts);
  const { bytes: sourceBytes, stat: after } = await readRegularFile(sourceRoot, parts);
  const preservedHash = sha256(preservedBytes);
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile() ||
      sourceBytes.length !== asset.size || sha256(sourceBytes) !== asset.sha256 ||
      preservedBytes.length !== asset.size || preservedHash !== asset.sha256) {
    throw preservationError("Download source or evidence copy changed during preservation");
  }
  return { preserved: true, preservedSha256: preservedHash, evidenceRelativePath: parts.join("/") };
}

// Walk all acquisition contents, including partial files absent from browser
// accounting. Cleanup requires matching bytes for every preserved source.
async function remainingSources(sourceRoot, assets, evidenceRoot = null) {
  const preserved = new Map(assets.filter(asset => asset.preserved).map(asset => [asset.evidenceRelativePath, asset]));
  const unpreservedPaths = [], inventoryErrors = [];
  let sourceFiles = 0;
  async function visit(parts = []) {
    const directory = parts.length ? await inspectPath(sourceRoot, parts) : sourceRoot;
    for (const name of await fs.readdir(directory)) {
      const childParts = [...parts, name], relative = childParts.join("/");
      try {
        const child = await inspectPath(sourceRoot, childParts), stat = await fs.lstat(child);
        if (stat.isDirectory()) await visit(childParts);
        else if (stat.isFile()) {
          sourceFiles++;
          const asset = preserved.get(relative);
          if (!asset) unpreservedPaths.push(relative);
          else {
            const { bytes } = await readRegularFile(sourceRoot, childParts);
            if (bytes.length !== asset.size || sha256(bytes) !== asset.preservedSha256) unpreservedPaths.push(relative);
            else if (evidenceRoot) {
              const { bytes: evidenceBytes } = await readRegularFile(evidenceRoot, childParts);
              if (evidenceBytes.length !== asset.size || sha256(evidenceBytes) !== asset.preservedSha256) unpreservedPaths.push(relative);
            }
          }
        } else unpreservedPaths.push(relative);
      } catch (error) {
        unpreservedPaths.push(relative);
        inventoryErrors.push({ relativePath: relative, message: error.message });
      }
    }
  }
  await visit().catch(error => { inventoryErrors.push({ relativePath: ".", message: error.message }); });
  return { sourceFiles, unpreservedPaths, inventoryErrors,
    cleanupSafe: !unpreservedPaths.length && !inventoryErrors.length };
}

// Recheck both trees after Chrome exits. Late downloads or modified evidence
// invalidate the earlier preservation snapshot and keep source bytes recoverable.
export async function downloadCleanupInventory(sourceRoot, evidenceRoot, assets = []) {
  try {
    for (const root of [sourceRoot, evidenceRoot]) {
      const stat = await fs.lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw preservationError("Cleanup roots must be regular directories without symbolic links");
    }
    return await remainingSources(await fs.realpath(sourceRoot), assets, await fs.realpath(evidenceRoot));
  } catch (error) {
    return { cleanupSafe: false, unpreservedPaths: [], inventoryErrors: [{ relativePath: ".", message: error.message }] };
  }
}

// Preserve all existing accounted files and inventory leftovers before publishing
// the cleanup decision. Assets retain their browser verification outcome.
export async function preserveDownloads(accounting, sourceRoot, evidenceRoot) {
  const requestedSource = path.resolve(sourceRoot), requestedEvidence = path.resolve(evidenceRoot);
  if (overlaps(requestedSource, requestedEvidence)) {
    throw preservationError("Browser download and evidence roots must not overlap");
  }
  let source, evidence;
  try {
    for (const root of [requestedSource, requestedEvidence]) {
      const stat = await fs.lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw preservationError("Download roots must be regular directories without symbolic links");
    }
    source = await fs.realpath(requestedSource);
    evidence = await fs.realpath(requestedEvidence);
    if (overlaps(source, evidence)) throw preservationError("Resolved browser download and evidence roots must not overlap");
  } catch (error) { throw preservationError(`Download preservation roots are unavailable: ${error.message}`); }
  const errors = [], assets = [];
  for (const asset of accounting.assets) {
    const result = { ...asset, preserved: false, preservedSha256: null, evidenceRelativePath: null };
    if (asset.exists) {
      try { Object.assign(result, await preserveAsset(asset, source, evidence)); }
      catch (error) {
        result.verified = false;
        result.outcome = "BLOCKED";
        result.category = "harness";
        result.preservationError = error.message;
        errors.push({ relativePath: asset.relativePath, message: error.message });
      }
    }
    assets.push(result);
  }
  const inventory = await remainingSources(source, assets);
  return { ...accounting, assets, preservation: {
    outcome: errors.length ? "BLOCKED" : "PASS", category: "harness", cause: "download preservation",
    sourceRoot: source, evidenceRoot: evidence, copiedFiles: assets.filter(asset => asset.preserved).length, errors,
    ...inventory, cleanupSafe: !errors.length && inventory.cleanupSafe
  } };
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
