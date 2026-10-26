/*
 * These tests cover provider-aware DOM detection in the content script. They
 * run the script in jsdom with mocked chrome messaging so page parsing can be
 * exercised in an isolated DOM with controlled message listeners.
 */

import { describe, expect, it, vi } from "vitest";
import cases from "./fixtures/issue_13.json";

import { loadContentScript } from "./helpers/content_script_harness.js";

describe("content script", () => {
  it("uses SamacSys link metadata when a fallback product path has malformed encoding", () => {
    const page = loadContentScript(`
      <dl><dt>Order Code</dt><dd>123456</dd></dl>
      <a href="https://farnell.componentsearchengine.com/entry_u_newDesign.php?mna=ACME&amp;mpn=PART-1&amp;pna=farnell">ECAD</a>
    `, { url: "https://uk.farnell.com/acme/%E0%A4%A/part/dp/123456" });
    expect(page.requestContext()).toMatchObject({
      provider: "farnellSamacsys", sourcePartNumber: "123456", manufacturerPartNumber: "PART-1"
    });
    page.dom.window.close();
  });
  it("extracts EasyEDA identifiers from supported page text", () => {
    const { hooks } = loadContentScript("<div>ignored</div>");

    expect(hooks.findLcscId()).toBeNull();
    expect(hooks.findManufacturerPartNumber()).toBeNull();
  });

  it("detects a labelled EasyEDA/LCSC context and answers extension messages", () => {
    const { hooks, listener } = loadContentScript(`
      <dl><dt>LCSC Part #</dt><dd>c777888</dd></dl>
      <dl>
        <dt>Mfr. Part #</dt>
        <dd>STM32F030F4P6</dd>
      </dl>
    `);

    expect(hooks.findLcscId()).toBe("C777888");
    expect(hooks.findManufacturerPartNumber()).toBe("STM32F030F4P6");
    expect(hooks.findEasyedaPartContext()).toEqual({
      provider: "easyedaLcsc",
      sourcePartLabel: "LCSC part",
      sourcePartNumber: "C777888",
      manufacturerPartNumber: "STM32F030F4P6",
      lookup: {
        lcscId: "C777888"
      }
    });

    const sendResponse = vi.fn();
    expect(listener({ type: "GET_PART_CONTEXT" }, null, sendResponse)).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({
      provider: "easyedaLcsc",
      sourcePartLabel: "LCSC part",
      sourcePartNumber: "C777888",
      manufacturerPartNumber: "STM32F030F4P6",
      lookup: {
        lcscId: "C777888"
      }
    });
  });

  it("returns a null manufacturer part number when only the LCSC identifier is present", () => {
    const { hooks, listener } = loadContentScript(`
      <table class="tableInfoWrap">
        <tr>
          <td>LCSC Part #</td>
          <td>C424242</td>
        </tr>
      </table>
    `);

    expect(hooks.findManufacturerPartNumber()).toBeNull();

    const sendResponse = vi.fn();
    listener({ type: "GET_PART_CONTEXT" }, null, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({
      provider: "easyedaLcsc",
      sourcePartLabel: "LCSC part",
      sourcePartNumber: "C424242",
      manufacturerPartNumber: null,
      lookup: {
        lcscId: "C424242"
      }
    });
  });

  it("extracts JLCPCB manufacturer part numbers from compact labels", () => {
    const { hooks } = loadContentScript(
      `
      <dl>
        <dt>MFR.Part #</dt>
        <dd>35ZLH100MEFC6.3X11</dd>
      </dl>
      <dl>
        <dt>JLCPCB Part #</dt>
        <dd>C109392</dd>
      </dl>
    `,
      {
        url: "https://jlcpcb.com/partdetail/Rubycon-35ZLH100MEFC63X11/C109392"
      }
    );

    expect(hooks.findPartContext()).toEqual({
      provider: "easyedaLcsc",
      sourcePartLabel: "LCSC part",
      sourcePartNumber: "C109392",
      manufacturerPartNumber: "35ZLH100MEFC6.3X11",
      lookup: {
        lcscId: "C109392"
      }
    });
  });

  it("detects a Mouser SamacSys part context from the ECAD button and DOM metadata", () => {
    const { hooks } = loadContentScript(
      `
      <div class="row">
        <label for="MouserPartNumFormattedForProdInfo">Mouser No:</label>
        <div id="divMouserPartNum">
          <span id="spnMouserPartNumFormattedForProdInfo">511-STM32U3C5RIT6Q</span>
          <input
            id="MouserPartNumFormattedForProdInfo"
            value="511-STM32U3C5RIT6Q"
          />
        </div>
      </div>
      <div class="row">
        <label for="ManufacturerPartNumber">Mfr. No:</label>
        <div>
          <span id="spnManufacturerPartNumber">STM32U3C5RIT6Q</span>
          <input id="ManufacturerPartNumber" value="STM32U3C5RIT6Q" />
        </div>
      </div>
      <button
        id="lnk_CadModel"
        data-testid="ProductInfoECAD"
        onclick='dataLayer.push({"event_mouserpn":"511-stm32u3c5rit6q","event_manufacturer":"stmicroelectronics","event_manufacturerpn":"stm32u3c5rit6q"}); javascript:loadPartDiv("STMicroelectronics", "STM32U3C5RIT6Q", "mouser",1,"epw", 0, "","en-GB")'
      ></button>
    `,
      { url: "https://www.mouser.co.uk/ProductDetail/test" }
    );

    expect(
      hooks.parseLoadPartDivCall(
        'javascript:loadPartDiv("STMicroelectronics", "STM32U3C5RIT6Q", "mouser",1,"epw", 0, "","en-GB")'
      )
    ).toEqual({
      manufacturerName: "STMicroelectronics",
      manufacturerPartNumber: "STM32U3C5RIT6Q",
      partnerName: "mouser",
      format: "epw",
      logo: null,
      lang: "en-GB"
    });
    expect(
      hooks.buildSamacsysEntryUrl({
        baseUrl: "https://ms.componentsearchengine.com",
        manufacturerName: "STMicroelectronics",
        manufacturerPartNumber: "STM32U3C5RIT6Q",
        partnerName: "mouser",
        lang: "en-GB"
      })
    ).toBe(
      "https://ms.componentsearchengine.com/entry_u_newDesign.php?mna=STMicroelectronics&mpn=STM32U3C5RIT6Q&pna=mouser&vrq=multi&fmt=zip&lang=en-GB"
    );
    expect(hooks.findMouserPartContext()).toEqual({
      provider: "mouserSamacsys",
      sourcePartLabel: "Mouser part",
      sourcePartNumber: "511-STM32U3C5RIT6Q",
      manufacturerPartNumber: "STM32U3C5RIT6Q",
      lookup: {
        manufacturerName: "STMicroelectronics",
        entryUrl:
          "https://ms.componentsearchengine.com/entry_u_newDesign.php?mna=STMicroelectronics&mpn=STM32U3C5RIT6Q&pna=mouser&vrq=multi&fmt=zip&lang=en-GB",
        partnerName: "mouser",
        samacsysBaseUrl: "https://ms.componentsearchengine.com"
      }
    });
  });

  it("falls back to ECAD-button data for Mouser pages and returns no provider when ECAD is unavailable", () => {
    const { hooks: withEcadHooks } = loadContentScript(
      `
      <button
        id="lnk_CadModel"
        data-testid="ProductInfoECAD"
        onclick='dataLayer.push({"event_mouserpn":"511-stm32u3c5rit6q","event_manufacturer":"stmicroelectronics","event_manufacturerpn":"stm32u3c5rit6q"}); javascript:loadPartDiv("STMicroelectronics", "STM32U3C5RIT6Q", "mouser",1,"zip", 0, "","en-GB")'
      ></button>
    `,
      { url: "https://www.mouser.co.uk/ProductDetail/test" }
    );
    expect(withEcadHooks.findPartContext()).toEqual({
      provider: "mouserSamacsys",
      sourcePartLabel: "Mouser part",
      sourcePartNumber: "511-STM32U3C5RIT6Q",
      manufacturerPartNumber: "STM32U3C5RIT6Q",
      lookup: {
        manufacturerName: "STMicroelectronics",
        entryUrl:
          "https://ms.componentsearchengine.com/entry_u_newDesign.php?mna=STMicroelectronics&mpn=STM32U3C5RIT6Q&pna=mouser&vrq=multi&fmt=zip&lang=en-GB",
        partnerName: "mouser",
        samacsysBaseUrl: "https://ms.componentsearchengine.com"
      }
    });

    const { hooks: withoutEcadHooks } = loadContentScript(
      `
      <div>
        <label for="ManufacturerPartNumber">Mfr. No:</label>
        <input id="ManufacturerPartNumber" value="NO_ECAD_PART" />
      </div>
    `,
      { url: "https://www.mouser.co.uk/ProductDetail/test" }
    );
    expect(withoutEcadHooks.findMouserPartContext()).toBeNull();
    expect(withoutEcadHooks.findPartContext()).toEqual({
      provider: null,
      sourcePartLabel: null,
      sourcePartNumber: null,
      manufacturerPartNumber: null,
      lookup: null
    });
  });

  it("does not report Mouser support when the ECAD button lacks export metadata", () => {
    const { hooks } = loadContentScript(
      `
      <button
        id="lnk_CadModel"
        data-testid="ProductInfoECAD"
        onclick='dataLayer.push({"event_manufacturerpn":"stm32u3c5rit6q"});'
      ></button>
    `,
      { url: "https://www.mouser.co.uk/ProductDetail/test" }
    );

    expect(hooks.findMouserPartContext()).toBeNull();
    expect(hooks.findPartContext()).toEqual({
      provider: null,
      sourcePartLabel: null,
      sourcePartNumber: null,
      manufacturerPartNumber: null,
      lookup: null
    });
  });

  it("detects a Farnell SamacSys part context from a Supplyframe link", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer Part No: FQP27P06</div>
        <div>Order Code: 1848693</div>
        <a href="https://farnell.componentsearchengine.com/icon.php?lang=en-GB&mna=ONSEMI&mpn=FQP27P06&pna=farnell&logo=farnell&q3=SHOW3D">
          <img alt="Supply Frame Models Link" />
        </a>
      </section>
    `,
      { url: "https://uk.farnell.com/webapp/wcs/stores/servlet/ProductDisplay?partNumber=1848693" }
    );

    expect(
      hooks.parseSamacsysLinkUrl(
        "https://farnell.componentsearchengine.com/icon.php?lang=en-GB&mna=ONSEMI&mpn=FQP27P06&pna=farnell&logo=farnell&q3=SHOW3D",
        "farnell"
      )
    ).toEqual({
      baseUrl: "https://farnell.componentsearchengine.com",
      manufacturerName: "ONSEMI",
      manufacturerPartNumber: "FQP27P06",
      partnerName: "farnell",
      logo: "farnell",
      lang: "en-GB"
    });
    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "Farnell part",
      sourcePartNumber: "1848693",
      manufacturerPartNumber: "FQP27P06",
      lookup: {
        manufacturerName: "ONSEMI",
        entryUrl:
          "https://farnell.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=FQP27P06&pna=farnell&vrq=multi&fmt=zip&logo=farnell&lang=en-GB",
        authRefreshUrl:
          "https://farnell.componentsearchengine.com/icon.php?lang=en-GB&mna=ONSEMI&mpn=FQP27P06&pna=farnell&logo=farnell&q3=SHOW3D",
        partnerName: "farnell",
        samacsysBaseUrl: "https://farnell.componentsearchengine.com"
      }
    });
  });

  it("rejects SamacSys links on lookalike component-search hostnames", () => {
    const { hooks } = loadContentScript("", {
      url: "https://uk.farnell.com/webapp/wcs/stores/servlet/ProductDisplay?partNumber=1848693"
    });

    expect(
      hooks.parseSamacsysLinkUrl(
        "https://evilcomponentsearchengine.com/icon.php?mna=ONSEMI&mpn=FQP27P06&pna=farnell",
        "farnell"
      )
    ).toBeNull();
  });

  it("falls back to Farnell page labels when the Supplyframe link is absent", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer: STMICROELECTRONICS</div>
        <div>Manufacturer Part No: STM32F030C8T6</div>
        <div>Order Code: 2393634</div>
      </section>
      `,
      { url: "https://uk.farnell.com/stmicroelectronics/stm32f030c8t6/mcu-32bit-48mhz-2-4v-3-6v-lqfp/dp/2393634" }
    );

    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "Farnell part",
      sourcePartNumber: "2393634",
      manufacturerPartNumber: "STM32F030C8T6",
      lookup: {
        manufacturerName: "STMICROELECTRONICS",
        entryUrl:
          "https://farnell.componentsearchengine.com/entry_u_newDesign.php?mna=STMICROELECTRONICS&mpn=STM32F030C8T6&pna=farnell&vrq=multi&fmt=zip",
        partnerName: "farnell",
        samacsysBaseUrl: "https://farnell.componentsearchengine.com"
      }
    });
  });

  it("detects an element14 SamacSys part context and preserves the element14 host", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer Part No: NB3L553DG</div>
        <div>Order Code: 2101848</div>
        <a href="https://element14.componentsearchengine.com/icon.php?lang=en-GB&mna=ONSEMI&mpn=NB3L553DG&pna=element14&logo=element14&q3=SHOW3D">
          <img alt="Supply Frame Models Link" />
        </a>
      </section>
      `,
      {
        url: "https://au.element14.com/webapp/wcs/stores/servlet/ProductDisplay?partNumber=2101848"
      }
    );

    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "element14 part",
      sourcePartNumber: "2101848",
      manufacturerPartNumber: "NB3L553DG",
      lookup: {
        manufacturerName: "ONSEMI",
        entryUrl:
          "https://element14.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=NB3L553DG&pna=element14&vrq=multi&fmt=zip&logo=element14&lang=en-GB",
        authRefreshUrl:
          "https://element14.componentsearchengine.com/icon.php?lang=en-GB&mna=ONSEMI&mpn=NB3L553DG&pna=element14&logo=element14&q3=SHOW3D",
        partnerName: "element14",
        samacsysBaseUrl: "https://element14.componentsearchengine.com"
      }
    });
  });

  it("falls back to element14 page labels when the Supplyframe link is absent", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer: ONSEMI</div>
        <div>Manufacturer Part No: NB3L553DG</div>
        <div>Order Code: 2101848</div>
      </section>
      `,
      {
        url: "https://au.element14.com/onsemi/nb3l553dg/clock-fanout-buffer-soic-8/dp/2101848"
      }
    );

    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "element14 part",
      sourcePartNumber: "2101848",
      manufacturerPartNumber: "NB3L553DG",
      lookup: {
        manufacturerName: "ONSEMI",
        entryUrl:
          "https://element14.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=NB3L553DG&pna=element14&vrq=multi&fmt=zip",
        partnerName: "element14",
        samacsysBaseUrl: "https://element14.componentsearchengine.com"
      }
    });
  });

  it("detects a Newark SamacSys part context and preserves the Newark host", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer Part No: PN2222ATF</div>
        <div>Newark Part No.: 58K2048</div>
        <a href="https://newark.componentsearchengine.com/icon.php?lang=en-US&mna=ONSEMI&mpn=PN2222ATF&pna=newark&logo=newark&q3=SHOW3D">
          <img alt="Supply Frame Models Link" />
        </a>
      </section>
      `,
      {
        url: "https://www.newark.com/webapp/wcs/stores/servlet/ProductDisplay?catalogId=15003&langId=-1&partNumber=58K2048&storeId=10194&urlRequestType=Base"
      }
    );

    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "Newark part",
      sourcePartNumber: "58K2048",
      manufacturerPartNumber: "PN2222ATF",
      lookup: {
        manufacturerName: "ONSEMI",
        entryUrl:
          "https://newark.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=PN2222ATF&pna=newark&vrq=multi&fmt=zip&logo=newark&lang=en-US",
        authRefreshUrl:
          "https://newark.componentsearchengine.com/icon.php?lang=en-US&mna=ONSEMI&mpn=PN2222ATF&pna=newark&logo=newark&q3=SHOW3D",
        partnerName: "newark",
        samacsysBaseUrl: "https://newark.componentsearchengine.com"
      }
    });
  });

  it("falls back to Newark page labels when the Supplyframe link is absent", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer: ONSEMI</div>
        <div>Manufacturer Part No: PN2222ATF</div>
        <div>Newark Part No.: 58K2048</div>
      </section>
      `,
      {
        url: "https://www.newark.com/onsemi/pn2222atf/transistor-bjt-npn-to-226aa/dp/58K2048"
      }
    );

    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "Newark part",
      sourcePartNumber: "58K2048",
      manufacturerPartNumber: "PN2222ATF",
      lookup: {
        manufacturerName: "ONSEMI",
        entryUrl:
          "https://newark.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=PN2222ATF&pna=newark&vrq=multi&fmt=zip",
        partnerName: "newark",
        samacsysBaseUrl: "https://newark.componentsearchengine.com"
      }
    });
  });

  it("prefers Farnell canonical and meta product data over flattened body text", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>STM32F030C8T6 Order</div>
        <div>2393634 Product</div>
      </section>
      `,
      {
        url: "https://uk.farnell.com/stmicroelectronics/stm32f030c8t6/example/dp/2393634",
        headMarkup: `
          <link rel="canonical" href="https://uk.farnell.com/stmicroelectronics/stm32f030c8t6/mcu-32bit-48mhz-2-4v-3-6v-lqfp/dp/2393634" />
          <meta property="og:image:alt" content="STMICROELECTRONICS STM32F030C8T6" />
          <meta property="og:description" content="Buy STM32F030C8T6 - STMICROELECTRONICS - ARM MCU, Value Line. Farnell UK." />
        `
      }
    );

    expect(hooks.findFarnellPartContext()).toEqual({
      provider: "farnellSamacsys",
      sourcePartLabel: "Farnell part",
      sourcePartNumber: "2393634",
      manufacturerPartNumber: "STM32F030C8T6",
      lookup: {
        manufacturerName: "STMICROELECTRONICS",
        entryUrl:
          "https://farnell.componentsearchengine.com/entry_u_newDesign.php?mna=STMICROELECTRONICS&mpn=STM32F030C8T6&pna=farnell&vrq=multi&fmt=zip",
        partnerName: "farnell",
        samacsysBaseUrl: "https://farnell.componentsearchengine.com"
      }
    });
  });

  it("does not mis-detect a Farnell page as an LCSC part when body text contains C0004-style values", () => {
    const { hooks } = loadContentScript(
      `
      <section>
        <div>Manufacturer Part No: FQP27P06</div>
        <div>Order Code: 1848693</div>
        <div>Internal code: C0004</div>
      </section>
      `,
      { url: "https://uk.farnell.com/webapp/wcs/stores/servlet/ProductDisplay?partNumber=1848693" }
    );

    expect(hooks.findEasyedaPartContext()).toBeNull();
    expect(hooks.findPartContext()).toEqual({
      provider: null,
      sourcePartLabel: null,
      sourcePartNumber: null,
      manufacturerPartNumber: null,
      lookup: null
    });
  });
});

// Issue #13 report values provide deterministic fixtures; live-browser acceptance
// requires separate acquisition evidence.
describe("EasyEDA current-product identity", () => {
  it.each(cases)("resolves $case from URL-only, multiple-pair and wrapped-pair evidence", row => {
    for (const source of ["url", "pairs", "wrapped"]) {
      const mpn = `<dt>MFR.Part #</dt><dd>${row.mpn}</dd>`;
      const id = `<dt>LCSC Part #</dt><dd>${row.id}</dd>`;
      const fields = source === "url" ? mpn : source === "pairs" ? mpn + id :
        `<div>${mpn}</div><div>${id}</div>`;
      const page = loadContentScript(`<main><p>${row.wrong} C999999</p><dl>${fields}</dl></main>`,
        { url: source === "url" ? row.url : "https://lcsc.com/" });
      expect(page.requestContext()).toEqual({ provider: "easyedaLcsc", sourcePartLabel: "LCSC part",
        sourcePartNumber: row.id, manufacturerPartNumber: source === "url" ? null : row.mpn,
        lookup: { lcscId: row.id } });
    }
  });

  it.each([
    ["https://jlcpcb.com/partdetail/C999999-RC0201/C106225?part=C777777#C888888", "C106225"],
    ["http://www.JLCPCB.com/PARTDETAIL/test/c000123/", "C000123"],
    ["https://LCSC.com/PRODUCT-DETAIL/c132649.HTML/?id=C999999#C777777", "C132649"]
  ])("reads only the supported product-route ID: %s", (url, id) => {
    expect(loadContentScript("", { url }).requestContext().lookup).toEqual({ lcscId: id });
  });

  it.each([
    "not a URL", "https://jlcpcb.com.evil.test/partdetail/x/C106225",
    "https://eviljlcpcb.com/partdetail/x/C106225", "https://lcsc.com.evil.test/product-detail/C132649.html",
    "https://api.jlcpcb.com/partdetail/x/C106225", "https://jlcpcb.com:444/partdetail/x/C106225",
    "ftp://jlcpcb.com/partdetail/x/C106225", "https://jlcpcb.com/search/C106225",
    "https://jlcpcb.com/partdetail/C106225", "https://jlcpcb.com/partdetail/x/RC0201FR",
    "https://jlcpcb.com/partdetail/x/C106225/extra", "https://jlcpcb.com/partdetail/x/%43106225",
    "https://jlcpcb.com/?part=C106225#C106225", "https://lcsc.com/product-detail/C132649",
    "https://lcsc.com/product-detail/x/C132649.html", "https://lcsc.com/product-detail/C132649.html/extra",
    "https://lcsc.com/search?q=C132649", "https://lcsc.com/product-detail/C12.html"
  ])("rejects unsupported URL evidence: %s", url => {
    const page = loadContentScript("<p>RC0201FR C106225</p>");
    expect(page.hooks.parseEasyedaProductUrl(url)).toBeNull();
    if (url !== "not a URL") page.dom.reconfigure({ url });
    expect(page.requestContext().provider).toBeNull();
  });

  it.each(["https://jlcpcb.com.evil.test/", "https://eviljlcpcb.com/", "ftp://lcsc.com/",
    "https://api.lcsc.com/"])("rejects labelled evidence on unsupported origins: %s", url => {
    const page = loadContentScript("<dl><dt>LCSC Part #</dt><dd>C106225</dd></dl>", { url });
    expect(page.requestContext().provider).toBeNull();
  });

  it("rejects URL credentials", () => {
    const url = new URL(cases[0].url);
    url.username = "user";
    const page = loadContentScript("", { url: url.href });
    expect(page.hooks.parseEasyedaProductUrl(url.href)).toBeNull();
    expect(page.requestContext().provider).toBeNull();
  });

  it.each(["", "RC0201FR-0710KL", "C12", "prefix C106225", "C106225 suffix", "C106225 C60490"])(
    "skips invalid whole-field values and accepts later agreeing evidence: %s", value => {
      const page = loadContentScript(`<main><dl><dt>Mfr. Part #</dt><dd>RC0201FR-0710KL/TR</dd>
        <dt>LCSC Part #</dt><dd>${value}</dd><dt>LCSC Part #</dt><dd> c106225 </dd></dl>
        <table class="tableInfoWrap"><tr><th>JLCPCB Part #</th><td>C106225</td></tr></table></main>`,
        { url: cases[0].url });
      expect(page.requestContext()).toMatchObject({ sourcePartNumber: "C106225",
        manufacturerPartNumber: "RC0201FR-0710KL/TR", lookup: { lcscId: "C106225" } });
    });

  it.each([
    '<aside><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></aside>',
    '<section class="recommendations"><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></section>',
    '<section id="related-products"><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></section>',
    '<section aria-label="Related products"><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></section>',
    ...["hidden", 'aria-hidden="true"', "inert", 'style="display:none"', 'style="visibility:hidden"']
      .map(attr => `<div ${attr}><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></div>`),
    '<dl><dt>LCSC Part #</dt><dd><span style="display:none">C999999</span></dd></dl>',
    '<dl><dt><span hidden>LCSC Part #</span></dt><dd>C999999</dd></dl>',
    '<dl><dt>LCSC Part #</dt><dd><script>C999999</script></dd></dl>',
    '<a href="https://jlcpcb.com/partdetail/other/C999999"><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></a>',
    '<script type="application/ld+json">{"sku":"C999999"}</script><p>C999999</p>',
    '<dl><dt>LCSC Part #</dt><dt>Package</dt><dd>C999999</dd></dl>',
    '<dl><dt>Other</dt><dd><dl><dt>LCSC Part #</dt><dd>C999999</dd></dl></dd></dl>',
    '<dl><dt>LCSC Part #</dt><dd><dl><dt>Other</dt><dd>C999999</dd></dl></dd></dl>',
    '<dl><div><dt>LCSC Part #</dt></div><div><dd>C999999</dd></div></dl>',
    '<table><tr><td>LCSC Part #</td><td>C999999</td></tr></table>',
    '<table class="tableInfoWrap"><tr><td>Other</td><td><table><tr><td>LCSC Part #</td><td>C999999</td></tr></table></td></tr></table>'
  ])("ignores unrelated, hidden or mispaired evidence: %s", markup => {
    const page = loadContentScript(`<main>${markup}<dl><dt>LCSC Part #</dt><dd>C106225</dd></dl></main>`,
      { url: cases[0].url });
    expect(page.requestContext().lookup).toEqual({ lcscId: "C106225" });
    page.dom.window.document.querySelector("main > dl:last-child").remove();
    page.dom.reconfigure({ url: "https://jlcpcb.com/" });
    expect(page.requestContext().provider).toBeNull();
  });

  it.each(["", "<p>RC0201FR-0710KL</p>", "<p>C106225</p>",
    "<dl><dt>Some LCSC Part # suggestion</dt><dd>C106225</dd></dl>",
    "<dl><dt>LCSC Part #</dt><dd>RC0201FR-0710KL</dd></dl>"])("returns unavailable for absent product evidence: %s", markup => {
    expect(loadContentScript(markup).requestContext().provider).toBeNull();
  });

  it.each([[cases[0].url, "<dl><dt>LCSC Part #</dt><dd>C60490</dd></dl>"],
    ["https://lcsc.com/", "<dl><dt>LCSC Part #</dt><dd>C106225</dd><dt>JLCPCB Part #</dt><dd>C60490</dd></dl>"]])(
    "returns unavailable for ambiguous product evidence: %s", (url, markup) => {
      expect(loadContentScript(markup, { url }).requestContext().provider).toBeNull();
    });

  it("recomputes after navigation without mixing stale product fields with a new URL", () => {
    const page = loadContentScript("<dl><dt>Mfr. Part #</dt><dd>RC0201FR-0710KL</dd><dt>LCSC Part #</dt><dd>C106225</dd></dl>",
      { url: cases[0].url });
    expect(page.requestContext().lookup).toEqual({ lcscId: "C106225" });
    page.dom.reconfigure({ url: cases[1].url });
    expect(page.requestContext().provider).toBeNull();
    page.dom.window.document.querySelector("dl").innerHTML = "<dt>Mfr. Part #</dt><dd>RC0201FR-0710KL</dd>";
    expect(page.requestContext()).toMatchObject({ sourcePartNumber: "C60490", manufacturerPartNumber: null });
    page.dom.window.document.querySelector("dl").innerHTML = "<dt>Mfr. Part #</dt><dd>RC0402FR-0710KL</dd><dt>LCSC Part #</dt><dd>C60490</dd>";
    expect(page.requestContext()).toMatchObject({ manufacturerPartNumber: "RC0402FR-0710KL", lookup: { lcscId: "C60490" } });
    page.dom.reconfigure({ url: "https://jlcpcb.com/" });
    page.dom.window.document.body.innerHTML = "<p>C777777 RC0805FR-0710KL</p>";
    expect(page.requestContext().provider).toBeNull();
  });

  it("scopes fields to main, ignores canonical metadata and omits conflicting MPNs", () => {
    const page = loadContentScript(`<dl><dt>LCSC Part #</dt><dd>C999999</dd></dl><main><dl>
      <dt>LCSC Part #</dt><dd>C106225</dd><dt>Mfr. Part #</dt><dd>RC0201FR-0710KL</dd>
      <dt>Mfr. Part #</dt><dd>Other-MPN</dd></dl></main>`, { url: cases[0].url,
      headMarkup: '<link rel="canonical" href="https://lcsc.com/product-detail/C999999.html">' +
        '<meta property="og:url" content="https://lcsc.com/product-detail/C888888.html">' +
        '<script type="application/ld+json">{"@type":"Product","sku":"C777777"}</script>' });
    expect(page.requestContext()).toMatchObject({ sourcePartNumber: "C106225", manufacturerPartNumber: null });
    page.dom.window.document.body.innerHTML = "";
    page.dom.reconfigure({ url: "https://lcsc.com/" });
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
