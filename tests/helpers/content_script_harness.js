/*
 * Execute the production content script in jsdom with real message listeners
 * and mocked Chrome registration for provider detection regression tests.
 */
import { vi } from "vitest";
import { JSDOM } from "jsdom";
import { runSourceFile } from "./test_harness.js";

export function loadContentScript(
  markup,
  { url = "https://www.lcsc.com/product-detail/example", headMarkup = "" } = {}
) {
  const dom = new JSDOM(
    `<!doctype html><html><head>${headMarkup}</head><body>${markup}</body></html>`,
    {
      url
    }
  );
  const listeners = [];
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };

  const context = runSourceFile("src/content_script.js", {
    context: {
      chrome,
      document: dom.window.document,
      window: dom.window
    },
    append: `
globalThis.__testExports = {
  parseLoadPartDivCall,
  buildSamacsysEntryUrl,
  parseSamacsysLinkUrl,
  parseEasyedaProductUrl,
  findLcscId,
  findManufacturerPartNumber,
  findMouserPartContext,
  findFarnellPartContext,
  findEasyedaPartContext,
  findPartContext
};
`
  });

  return {
    dom,
    hooks: context.__testExports,
    listener: listeners[0],
    requestContext() {
      const respond = vi.fn();
      listeners[0]({ type: "GET_PART_CONTEXT" }, null, respond);
      return respond.mock.calls[0][0];
    }
  };
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
