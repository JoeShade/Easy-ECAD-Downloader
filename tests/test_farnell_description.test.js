/*
 * Issue #15 regression fixtures isolate description parsing and verify the
 * identity sent through GET_PART_CONTEXT and reconstructed SamacSys URLs.
 * Reduced report fixtures are not evidence of live browser acceptance.
 */
import { describe, expect, it } from "vitest";
import products from "./fixtures/issue_15.json";
import { loadContentScript } from "./helpers/content_script_harness.js";

function expectIdentity(context, product, manufacturer = "YAGEO") {
  const baseUrl = `https://${product.brand}.componentsearchengine.com`;
  expect(context).toMatchObject({
    provider: "farnellSamacsys",
    sourcePartLabel: product.label,
    sourcePartNumber: product.orderCode,
    manufacturerPartNumber: product.mpn,
    lookup: { manufacturerName: manufacturer, partnerName: product.brand, samacsysBaseUrl: baseUrl }
  });
  const entry = new URL(context.lookup.entryUrl);
  expect(entry.origin).toBe(baseUrl);
  expect(entry.pathname).toBe("/entry_u_newDesign.php");
  expect(Object.fromEntries(entry.searchParams)).toMatchObject({
    mpn: product.mpn, mna: manufacturer, pna: product.brand, vrq: "multi", fmt: "zip"
  });
}

describe.each(products)("$brand description identity", product => {
  it.each(['property="og:description"', 'name="description"'])(
    "preserves the full issue identity from %s alone", attribute => {
      // A query-only URL and empty body cannot supply a fallback identity.
      const page = loadContentScript("", {
        url: `${new URL(product.url).origin}/webapp/ProductDisplay?partNumber=${product.orderCode}`,
        headMarkup: `<meta ${attribute} content="Buy ${product.mpn} - YAGEO - Resistor.">`
      });
      expectIdentity(page.requestContext(), product);
      page.dom.window.close();
    }
  );

  it("retains the description identity alongside verbose image alt and canonical metadata", () => {
    const page = loadContentScript("", {
      url: product.url,
      headMarkup: `<meta property="og:description" content="Buy ${product.mpn} - YAGEO - Resistor.">
        <meta property="og:image:alt" content="YAGEO ${product.mpn} SMD Chip Resistor, General Purpose">
        <link rel="canonical" href="${product.url}">`
    });
    expectIdentity(page.requestContext(), product);
    page.dom.window.close();
  });

  it("keeps complete direct-link identity and lookup options above conflicting descriptions", () => {
    const href = `https://${product.brand}.componentsearchengine.com/icon.php?mna=YAGEO&mpn=${product.mpn}&pna=${product.brand}&logo=${product.brand}&lang=en-GB&q3=SHOW3D`;
    const page = loadContentScript(`<a href="${href}">ECAD / MCAD</a>`, {
      url: product.url,
      headMarkup: '<meta property="og:description" content="Buy OTHER-123-TR - OTHER-MAKER - Resistor.">'
    });
    const context = page.requestContext();
    expectIdentity(context, product);
    expect(context.lookup.authRefreshUrl).toBe(href);
    const params = new URL(context.lookup.entryUrl).searchParams;
    expect(params.get("logo")).toBe(product.brand);
    expect(params.get("lang")).toBe("en-GB");
    page.dom.window.close();
  });

  it.each(["mpn", "mna"])("fills a partial direct link containing only %s from the description", field => {
    const href = `https://${product.brand}.componentsearchengine.com/icon.php?${field}=${field === "mpn" ? product.mpn : "YAGEO"}`;
    const descriptionMpn = field === "mpn" ? "OTHER-123-TR" : product.mpn;
    const descriptionManufacturer = field === "mna" ? "OTHER-MAKER" : "YAGEO";
    const page = loadContentScript(`<a href="${href}">ECAD / MCAD</a>`, {
      url: product.url,
      headMarkup: `<meta property="og:description" content="Buy ${descriptionMpn} - ${descriptionManufacturer} - Resistor.">`
    });
    const context = page.requestContext();
    expectIdentity(context, product);
    expect(context.lookup.authRefreshUrl).toBe(href);
    page.dom.window.close();
  });
});

describe("shared Farnell description delimiters", () => {
  it.each([
    ["STM32F030C8T6", "STMICROELECTRONICS", " "],
    ["ABC-123-TR", "TEST-MAKER", " "],
    ["ABC-123-TR", "TEST-MAKER", "   "],
    ["ABC-123-TR", "TEST-MAKER", "\t"],
    ["ABC-123-TR", "TEST-MAKER", "\u00a0"]
  ])("preserves MPN %s and manufacturer %s with separator whitespace %j", (mpn, manufacturer, space) => {
    const product = { ...products[0], mpn };
    const page = loadContentScript("", {
      url: `https://uk.farnell.com/webapp/ProductDisplay?partNumber=${product.orderCode}`,
      headMarkup: `<meta property="og:description" content="Buy ${mpn}${space}-${space}${manufacturer}${space}-${space}Resistor.">`
    });
    expectIdentity(page.requestContext(), product, manufacturer);
    page.dom.window.close();
  });

  it("preserves Newark branding and a full hyphenated identity through the shared parser", () => {
    const product = { brand: "newark", label: "Newark part", orderCode: "58K2048", mpn: "ABC-123-TR" };
    const page = loadContentScript("", {
      url: "https://www.newark.com/webapp/ProductDisplay?partNumber=58K2048",
      headMarkup: '<meta name="description" content="Buy ABC-123-TR - TEST-MAKER - Component.">'
    });
    expectIdentity(page.requestContext(), product, "TEST-MAKER");
    page.dom.window.close();
  });
});

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
