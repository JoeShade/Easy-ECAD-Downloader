// Core export/conversion work in this file: JoeShade and Josh Webster
/*
 * Storage-backed KiCad symbol-library helpers. Library mode keeps the current
 * merged symbol text in chrome.storage.local so repeated exports append distinct
 * symbol IDs while retaining existing blocks in the accumulated library.
 */

// KiCad symbol roots contain nested symbols for their drawing units. Count
// parentheses outside escaped strings to select only the requested depth:
// depth 1 inside a library wrapper, or depth 0 in already extracted blocks.
function readSymbolBlocks(text, symbolDepth) {
  const blocks = [];
  const symbolStart = /\(symbol\s+"((?:\\.|[^"\\])*)"/y;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "(") {
      if (depth === symbolDepth) {
        symbolStart.lastIndex = index;
        const match = symbolStart.exec(text);
        current = match ? { start: index, id: match[1] } : undefined;
      }
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("KiCad symbol library has unbalanced parentheses.");
      if (depth === symbolDepth && current) {
        blocks.push({ id: current.id, text: text.slice(current.start, index + 1) });
        current = undefined;
      }
    }
  }
  if (depth || inString) throw new Error("KiCad symbol library has unbalanced parentheses or strings.");
  return blocks;
}

// Keep complete root symbols and their nested unit drawings. Structural parsing
// accepts compact and multiline libraries and preserves parentheses in properties.
function extractSymbolBlock(kicadLibraryText) {
  return readSymbolBlocks(kicadLibraryText, 1).map(block => block.text).join("\n") || null;
}

// The stored library is the append authority. Compare each incoming root ID to
// existing root IDs; a bundle may contain both an existing and a new symbol.
function mergeSymbolIntoLibrary(existingLibrary, symbolBlock) {
  if (!symbolBlock) {
    return existingLibrary;
  }
  if (!existingLibrary) {
    return `(kicad_symbol_lib\n  (version 20211014)\n  (generator "Easy ECAD Downloader")\n  ${symbolBlock.replace(/\n/g, "\n  ")}\n)\n`;
  }
  const existingIds = new Set(readSymbolBlocks(existingLibrary, 1).map(block => block.id));
  const additions = [];
  for (const block of readSymbolBlocks(symbolBlock, 0)) {
    if (existingIds.has(block.id)) continue;
    existingIds.add(block.id);
    additions.push(block.text);
  }
  if (!additions.length) return existingLibrary;
  const trimmed = existingLibrary.trimEnd();
  const lastClose = trimmed.lastIndexOf(")");
  if (lastClose === -1) {
    return existingLibrary;
  }
  const before = trimmed.slice(0, lastClose).trimEnd();
  const indentedBlock = `  ${additions.join("\n").replace(/\n/g, "\n  ")}`;
  return `${before}\n${indentedBlock}\n)\n`;
}

async function loadStoredSymbolLibrary(chromeApi, key) {
  return new Promise((resolve, reject) => {
    chromeApi.storage.local.get({ [key]: "" }, (data) => {
      if (chromeApi.runtime.lastError) {
        reject(new Error(`Failed to load symbol library: ${chromeApi.runtime.lastError.message}`));
        return;
      }
      resolve(String(data[key] || ""));
    });
  });
}

async function saveStoredSymbolLibrary(chromeApi, key, content) {
  return new Promise((resolve, reject) => {
    chromeApi.storage.local.set({ [key]: content }, () => {
      if (chromeApi.runtime.lastError) {
        reject(new Error(`Failed to save symbol library: ${chromeApi.runtime.lastError.message}`));
        return;
      }
      resolve();
    });
  });
}

export {
  extractSymbolBlock,
  mergeSymbolIntoLibrary,
  loadStoredSymbolLibrary,
  saveStoredSymbolLibrary
};

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
