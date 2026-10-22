/*
 * Shared test harness utilities for reading repository files, importing fresh
 * modules, and executing source files inside controlled VM contexts. These
 * helpers keep browser globals mocked consistently across implementation tests.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const FALLBACK_ATOB = (value) => Buffer.from(value, "base64").toString("binary");
const FALLBACK_BTOA = (value) => Buffer.from(value, "binary").toString("base64");

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

let moduleImportNonce = 0;

// A distinct URL bypasses ESM's module cache so each test binds fresh browser
// globals. Shared imported dependencies retain their own ordinary module cache.
export async function importRepoModule(relativePath) {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, relativePath));
  moduleUrl.searchParams.set("t", String(moduleImportNonce++));
  return import(moduleUrl.href);
}

// Execute classic-script source with explicit browser substitutes. Tests supply
// text transforms for module syntax and append exports inside the same VM scope.
export function runSourceFile(
  relativePath,
  { context = {}, transforms = [], append = "" } = {}
) {
  let source = readRepoFile(relativePath);
  for (const transform of transforms) {
    source = transform(source);
  }
  if (append) {
    source = `${source}\n${append}\n`;
  }

  const script = new vm.Script(source, { filename: relativePath });
  const vmContext = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Map,
    WeakMap,
    ArrayBuffer,
    Uint8Array,
    URL,
    Blob,
    TextEncoder,
    TextDecoder,
    atob: globalThis.atob || FALLBACK_ATOB,
    btoa: globalThis.btoa || FALLBACK_BTOA,
    encodeURIComponent,
    decodeURIComponent,
    unescape: globalThis.unescape,
    ...context
  });

  script.runInContext(vmContext);
  return vmContext;
}

export function replaceExactImport(source, fromText, toText) {
  return source.replace(fromText, toText);
}

export function stripEsmFunctionExports(source) {
  return source.replace(/^export function /gm, "function ");
}

export function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n");
}

export async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
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
