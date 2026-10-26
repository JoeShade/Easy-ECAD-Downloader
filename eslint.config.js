/*
 * ESLint configuration for the extension modules and test harnesses. The
 * explicit globals keep browser, extension, and Node test boundaries visible.
 */

import js from "@eslint/js";

const browserGlobals = {
  Blob: "readonly",
  DecompressionStream: "readonly",
  Event: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  atob: "readonly",
  btoa: "readonly",
  clearInterval: "readonly",
  chrome: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  document: "readonly",
  encodeURIComponent: "readonly",
  fetch: "readonly",
  globalThis: "readonly",
  navigator: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  unescape: "readonly",
  window: "readonly"
};

const nodeGlobals = {
  Buffer: "readonly",
  process: "readonly"
};

export default [
  {
    ignores: [
      "coverage/**",
      "dist/**",
      ".qa-output/**",
      "**/qa-run/**",
      "easyECADDownloader.crx",
      "easyECADDownloader.zip",
      "node_modules/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "tests/**/*.js", "vitest.config.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...browserGlobals,
        ...nodeGlobals
      },
      sourceType: "module"
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          varsIgnorePattern: "^_"
        }
      ]
    }
  }
];

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
