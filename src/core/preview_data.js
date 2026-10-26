// Core export/conversion work in this file: JoeShade and Josh Webster
/*
 * Shared filename, URL, and preview-data helpers. These keep provider modules
 * from re-implementing small but easy-to-drift rules for datasheet filenames
 * and image/SVG data URL generation.
 */

function sanitizeFilenamePart(value, fallback = "datasheet") {
  const sanitized = String(value || "").trim().replace(/[^\w.-]+/g, "_");
  return sanitized || fallback;
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  return url;
}

// btoa consumes one byte per character. Bounded chunks avoid the JavaScript
// argument-count limit while preserving the original binary bytes.
function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Percent encoding yields UTF-8 bytes; unescape turns each byte into the
// binary-string representation accepted by btoa, including non-ASCII CAD text.
function textToBase64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

function makeSvgDataUrl(svgText) {
  return svgText
    ? `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`
    : null;
}

function makeBase64DataUrl(mimeType, base64Text) {
  if (!base64Text) {
    return null;
  }
  return `data:${mimeType};base64,${base64Text}`;
}

export {
  sanitizeFilenamePart,
  normalizeUrl,
  arrayBufferToBase64,
  textToBase64,
  makeSvgDataUrl,
  makeBase64DataUrl
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
