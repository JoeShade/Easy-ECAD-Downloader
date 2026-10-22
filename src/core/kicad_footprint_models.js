/*
 * Shared structural edits for KiCad footprint model blocks. EasyEDA and
 * SamacSys exports use the same string-aware scanner to preserve quoted
 * properties, geometry, and model transforms while rewriting portable paths.
 */

function isKicadModelBlockStart(text, index) {
  const token = "(model";
  const nextChar = text[index + token.length] || "";
  return (
    text.startsWith(token, index) &&
    (!nextChar || /\s|\)/.test(nextChar))
  );
}

// Quoted KiCad strings can contain parentheses and the word model. Track string
// escapes while locating balanced structural blocks so property text stays intact.
function findNextKicadModelBlock(text, startIndex = 0) {
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (!isKicadModelBlockStart(text, index)) {
      continue;
    }

    let depth = 0;
    let blockInString = false;
    let blockEscaped = false;
    for (let blockEnd = index; blockEnd < text.length; blockEnd += 1) {
      const blockChar = text[blockEnd];
      if (blockInString) {
        if (blockEscaped) {
          blockEscaped = false;
        } else if (blockChar === "\\") {
          blockEscaped = true;
        } else if (blockChar === "\"") {
          blockInString = false;
        }
        continue;
      }
      if (blockChar === "\"") {
        blockInString = true;
        continue;
      }
      if (blockChar === "(") {
        depth += 1;
      } else if (blockChar === ")") {
        depth -= 1;
        if (depth === 0) {
          return { start: index, end: blockEnd + 1 };
        }
      }
    }

    return null;
  }

  return null;
}

function stripKicadFootprintModels(footprintText) {
  const text = String(footprintText || "");
  let result = "";
  let cursor = 0;
  let modelBlock = findNextKicadModelBlock(text, cursor);

  while (modelBlock) {
    let removalStart = modelBlock.start;
    while (removalStart > cursor && /[ \t]/.test(text[removalStart - 1])) {
      removalStart -= 1;
    }
    if (removalStart > cursor && text[removalStart - 1] === "\n") {
      removalStart -= 1;
      if (removalStart > cursor && text[removalStart - 1] === "\r") {
        removalStart -= 1;
      }
    }

    result += text.slice(cursor, removalStart);
    cursor = modelBlock.end;
    modelBlock = findNextKicadModelBlock(text, cursor);
  }

  result += text.slice(cursor);
  return result.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n");
}

// KiCad accepts quoted and bare paths. Return only the path token so model
// offsets, rotations, and scales retain their original text and order.
function findKicadModelPathRange(modelBlockText) {
  if (!modelBlockText.startsWith("(model")) {
    return null;
  }

  let cursor = "(model".length;
  while (cursor < modelBlockText.length && /\s/.test(modelBlockText[cursor])) {
    cursor += 1;
  }

  if (modelBlockText[cursor] === "\"") {
    const pathStart = cursor + 1;
    let escaped = false;
    for (cursor = pathStart; cursor < modelBlockText.length; cursor += 1) {
      const char = modelBlockText[cursor];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        return { start: pathStart, end: cursor, quoted: true };
      }
    }
    return null;
  }

  const pathStart = cursor;
  while (
    cursor < modelBlockText.length &&
    !/[\s)]/.test(modelBlockText[cursor])
  ) {
    cursor += 1;
  }

  if (cursor === pathStart) {
    return null;
  }

  return { start: pathStart, end: cursor };
}

// Replace the first structural model path using string slices. Literal dollar
// signs and quotes in filenames remain data throughout the replacement.
function rewriteFirstKicadFootprintModelPath(footprintText, modelPath) {
  if (!modelPath) {
    return stripKicadFootprintModels(footprintText);
  }

  const text = String(footprintText || "");
  const modelBlock = findNextKicadModelBlock(text);
  if (!modelBlock) {
    return text;
  }

  const modelBlockText = text.slice(modelBlock.start, modelBlock.end);
  const pathRange = findKicadModelPathRange(modelBlockText);
  if (!pathRange) {
    return text;
  }

  const escapedPath = modelPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const pathToken = pathRange.quoted ? escapedPath : `"${escapedPath}"`;
  const rewrittenBlock = `${modelBlockText.slice(0, pathRange.start)}${pathToken}${modelBlockText.slice(pathRange.end)}`;
  return `${text.slice(0, modelBlock.start)}${rewrittenBlock}${text.slice(modelBlock.end)}`;
}

export { rewriteFirstKicadFootprintModelPath, stripKicadFootprintModels };

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
