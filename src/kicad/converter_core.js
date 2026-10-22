/*
 * Internal converter orchestration for EasyEDA-backed parts. This stitches
 * together the symbol parser, footprint parser, KiCad emitters, and OBJ-to-WRL
 * conversion while keeping the public facade stable in kicad_converter.js.
 */

import { parseEasyedaFootprint } from "./easyeda_footprint_parser.js";
import { parseEasyedaSymbol } from "./easyeda_symbol_parser.js";
import { convertFootprintToKiCad, drillToKi, exportKiCadFootprint } from "./kicad_footprint_emitter.js";
import { convertSymbolToKiCad, exportKiCadSymbolLibrary } from "./kicad_symbol_emitter.js";
import { convertObjToWrl } from "./obj_to_wrl.js";
import { applyPinNameStyle, applyTextStyle, parseSvgPath, sanitizeFields } from "./shared.js";

// Build only requested asset types so a footprint-only upstream payload can be
// exported independently of the symbol parser, and vice versa.
function convertEasyedaCadToKicad(cadData, options = {}) {
  const result = {};

  if (options.symbol) {
    const eeSymbol = parseEasyedaSymbol(cadData);
    const kiSymbol = convertSymbolToKiCad(eeSymbol);
    result.symbol = {
      name: sanitizeFields(eeSymbol.info.name || "symbol"),
      content: exportKiCadSymbolLibrary(kiSymbol)
    };
  }

  if (options.footprint) {
    const eeFootprint = parseEasyedaFootprint(cadData);
    const kiFootprint = convertFootprintToKiCad(eeFootprint);
    result.footprint = {
      name: eeFootprint.info.name || "footprint",
      content: exportKiCadFootprint(kiFootprint, "${KIPRJMOD}")
    };
  }

  return result;
}

function convertObjToWrlString(objData) {
  return convertObjToWrl(objData);
}

export {
  applyPinNameStyle,
  applyTextStyle,
  convertEasyedaCadToKicad,
  convertObjToWrlString,
  drillToKi,
  parseSvgPath
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
