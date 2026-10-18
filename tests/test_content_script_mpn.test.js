/*
 * Issue #14 regressions exercise the production GET_PART_CONTEXT listener.
 * The JLCPCB fixture is captured markup; all generated LCSC/edge cases are
 * synthetic, using report-derived identifiers rather than live-page evidence.
 */
import { describe, expect, it } from "vitest";
import { loadContentScript } from "./helpers/content_script_harness.js";
import { readRepoFile } from "./helpers/test_harness.js";

const LCSC_URL = "https://www.lcsc.com/product-detail/C132649.html?s_z=n_q_RC1206FR-0710KL";
const MPN_VALUES = ["0451001.MRL", "0402CG2R7B500NT", "35ZLH100MEFC6.3X11",
  "MCP6001T-I/OT", "74LVC1G14GM,132", "FH12-10S-0.5SH(55)", "B2B-PH-K-S(LF)(SN)",
  "G5V-1 DC5", "Hi7011", "687110182122", "3000"];

function expectContext(page, mpn, id = "C132649") {
  expect(page.requestContext()).toEqual({ provider: "easyedaLcsc", sourcePartLabel: "LCSC part",
    sourcePartNumber: id, manufacturerPartNumber: mpn, lookup: { lcscId: id } });
}

function productFields(mpn = "RC1206FR-0710KL", label = "MPN") {
  return `<dl><dt>Manufacturer</dt><dd>YAGEO</dd><dt>${label}</dt><dd>${mpn}</dd>
    <dt>LCSC Part #</dt><dd>C132649</dd></dl>`;
}

describe("EasyEDA manufacturer part metadata", () => {
  it("reads the captured JLCPCB facts with wrapped pairs and empty copy icons", () => {
    const page = loadContentScript(readRepoFile("tests/fixtures/issue_14_jlcpcb.html"),
      { url: "https://jlcpcb.com/partdetail/Littelfuse-0451001MRL/C3099" });
    expectContext(page, "0451001.MRL", "C3099");
  });

  it.each(["separate", "multiple", "wrapped", "table"])(
    "recognizes LCSC MPN in supported %s fields", structure => {
      const pairs = [["Manufacturer", "YAGEO"], ["MPN", "RC1206FR-0710KL"], ["LCSC Part #", "C132649"]];
      const fields = structure === "table" ? `<table class="tableInfoWrap">${pairs.map(([label, value]) =>
        `<tr><th>${label}</th><td><span>${value}</span></td></tr>`).join("")}</table>` :
        pairs.map(([label, value]) => {
          const pair = `<dt>${label}</dt><dd><span>${value}</span></dd>`;
          return structure === "separate" ? `<dl>${pair}</dl>` : structure === "wrapped" ? `<div>${pair}</div>` : pair;
        }).join("");
      const page = loadContentScript(structure === "table" || structure === "separate" ? fields : `<dl>${fields}</dl>`,
        { url: LCSC_URL });
      expectContext(page, "RC1206FR-0710KL");
    });

  it.each(MPN_VALUES)("preserves the exact string %s under both accepted labels", mpn => {
    for (const label of ["MPN", "MFR.Part #"]) {
      expectContext(loadContentScript(productFields(` \n ${mpn}\n `, label), { url: LCSC_URL }), mpn);
    }
  });

  it.each(["mpn", "MpN:", " MPN. "])("normalizes the explicit %s label", label => {
    expectContext(loadContentScript(productFields(undefined, label), { url: LCSC_URL }), "RC1206FR-0710KL");
  });

  it.each(["Part", "Model", "Manufacturer", "Customer #", "Other MPN", "MPN alternative"])(
    "does not reinterpret %s as manufacturer metadata", label => {
      expectContext(loadContentScript(productFields(undefined, label), { url: LCSC_URL }), null);
    });

  it("deduplicates agreeing aliases and omits conflicting MPNs", () => {
    const page = loadContentScript(productFields() + "<dl><dt>MFR.Part #</dt><dd>RC1206FR-0710KL</dd></dl>",
      { url: LCSC_URL });
    expectContext(page, "RC1206FR-0710KL");
    page.dom.window.document.querySelector("dl:last-child dd").textContent = "Other-MPN";
    expectContext(page, null);
  });

  it.each(["", " \n "])("skips an empty MPN before later valid evidence: %s", empty => {
    expectContext(loadContentScript(`<dl><dt>MPN</dt><dd>${empty}</dd></dl>${productFields()}`,
      { url: LCSC_URL }), "RC1206FR-0710KL");
  });

  it.each(["hidden", 'aria-hidden="true"', "inert", 'style="display:none"', 'style="visibility:hidden"'])(
    "does not import hidden MPN text: %s", attribute => {
      expectContext(loadContentScript(productFields(`<span ${attribute}>RC1206FR-0710KL</span>`),
        { url: LCSC_URL }), null);
    });

  it("does not attach an MPN when the agreeing catalogue field is hidden", () => {
    const markup = '<dl><dt>MPN</dt><dd>RC1206FR-0710KL</dd><dt>LCSC Part #</dt><dd hidden>C132649</dd></dl>';
    expectContext(loadContentScript(markup, { url: LCSC_URL }), null);
  });

  it("excludes outside-main, related, aside, hidden and differently linked MPN fields", () => {
    const other = '<dl><dt>MPN</dt><dd>Other-MPN</dd><dt>LCSC Part #</dt><dd>C999999</dd></dl>';
    const markup = `${other}<main><aside>${other}</aside><section class="related-products">${other}</section>
      <div hidden>${other}</div><a href="https://lcsc.com/product-detail/C999999.html">${other}</a>
      ${productFields()}</main>`;
    expectContext(loadContentScript(markup, { url: LCSC_URL }), "RC1206FR-0710KL");
  });

  it("keeps unowned plain tables out of current-product evidence", () => {
    const markup = '<table><tr><th>MPN</th><td>Other-MPN</td></tr></table>' + productFields();
    expectContext(loadContentScript(markup, { url: LCSC_URL }), "RC1206FR-0710KL");
  });

  it("recomputes alias fields after navigation while preserving the catalogue agreement guard", () => {
    const page = loadContentScript(productFields(), { url: LCSC_URL });
    expectContext(page, "RC1206FR-0710KL");
    page.dom.reconfigure({ url: "https://lcsc.com/product-detail/C60490.html" });
    expect(page.requestContext().provider).toBeNull();
    page.dom.window.document.querySelector("dl").innerHTML = "<dt>MPN</dt><dd>RC1206FR-0710KL</dd>";
    expectContext(page, null, "C60490");
    page.dom.window.document.querySelector("dl").innerHTML =
      "<dt>MPN</dt><dd>RC0402FR-0710KL</dd><dt>LCSC Part #</dt><dd>C60490</dd>";
    expectContext(page, "RC0402FR-0710KL", "C60490");
  });

  it("uses labelled facts on the short route without accepting URL-only identity", () => {
    const page = loadContentScript(productFields("MT3608").replace("C132649", "C84817"),
      { url: "https://jlcpcb.com/partdetail/C84817" });
    expectContext(page, "MT3608", "C84817");
    page.dom.window.document.body.innerHTML = "<h1>MT3608</h1>";
    expect(page.requestContext().provider).toBeNull();
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
