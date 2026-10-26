/*
 * Shared fixtures for converter and worker tests. They provide compact but
 * representative EasyEDA payloads and KiCad symbol libraries as self-contained
 * inputs for focused tests.
 */

export function createCadData({
  lcscId = "C12345",
  datasheetUrl = "https://cdn.example.test/datasheets/demo-part.pdf",
  modelUuid = "model-uuid-1",
  modelName = "Model QFN"
} = {}) {
  return {
    SMT: true,
    title: "Demo Logic Part",
    lcsc: {
      number: lcscId,
      url: datasheetUrl
    },
    dataStr: {
      BBox: { x: 10, y: 20, width: 80, height: 50 },
      head: {
        x: 10,
        y: 20,
        c_para: {
          name: "Logic / Buffer",
          pre: "U?",
          package: "QFN-16/Example",
          BOM_Manufacturer: "ACME Semi",
          "BOM_JLCPCB Part Class": "JLC-001",
          link: datasheetUrl
        }
      },
      shape: [
        "P~show~1~1~20~30~0~pin-1~false^^0^^M 20 30 h10~#000^^show~24~30~0~CLK#/RESET#~start~Arial~7pt^^0^^show~19~30^^show~M 0 0",
        "R~30~25~0~0~40~20",
        "PL~30 25 70 25 70 45~#000~0~0~none",
        "PG~30 25 50 15 70 25",
        "C~50~35~5~#000~0~none",
        "A~M 30 35 A 5 5 0 0 1 40 45~#000~0~0~none",
        "PT~M 30 25 L 40 35 L 30 45 Z"
      ]
    },
    packageDetail: {
      title: "QFN-16/Example",
      dataStr: {
        BBox: { x: 90, y: 190, width: 40, height: 30 },
        head: {
          x: 100,
          y: 200,
          c_para: {
            package: "QFN-16/Example",
            link: datasheetUrl,
            "3DModel": modelName
          }
        },
        shape: [
          "PAD~RECT~100~200~20~10~1~~(1)~0~~90~pad-1~0~~true~false",
          "PAD~POLYGON~120~200~10~10~1~~2~0~120 195 125 205 115 205~0~pad-2~0~~true~false",
          "TRACK~1~3~~100 190 120 190 120 210~track-1~false",
          "HOLE~110~210~2~hole-1~false",
          "VIA~118~208~3~~1~via-1~false",
          "CIRCLE~110~210~5~1~3~circle-1~false",
          "ARC~1~3~~M 100 200 A 10 10 0 0 1 120 200~~arc-1~false",
          "RECT~95~195~30~20~1~rect-1~3~false",
          "TEXT~N~105~205~0.5~270~~3~~4~REF**~~show~text-1~false",
          `SVGNODE~{"attrs":{"title":"${modelName}","uuid":"${modelUuid}","c_origin":"105,205","c_rotation":"0,90,180","z":"2"}}`
        ]
      }
    }
  };
}

export function createSymbolLibrary(symbolId = "ExistingSymbol") {
  return `(kicad_symbol_lib
  (version 20211014)
  (generator "Easy ECAD Downloader")
  (symbol "${symbolId}"
    (in_bom yes)
    (on_board yes)
  )
)
`;
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
