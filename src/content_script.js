/*
 * This content script inspects supported product pages and returns a provider-
 * aware part context for the popup. EasyEDA/LCSC pages expose an LCSC part id,
 * while SamacSys distributor pages expose lookup metadata through page-specific
 * ECAD entry points.
 */

const EASYEDA_PROVIDER = "easyedaLcsc";
const MOUSER_PROVIDER = "mouserSamacsys";
const FARNELL_PROVIDER = "farnellSamacsys";
const EASYEDA_SOURCE_LABEL = "LCSC part";
const DISTRIBUTORS = {
  mouser: {
    provider: MOUSER_PROVIDER,
    sourcePartLabel: "Mouser part",
    partnerName: "mouser",
    baseUrl: "https://ms.componentsearchengine.com"
  },
  farnell: {
    provider: FARNELL_PROVIDER,
    sourcePartLabel: "Farnell part",
    partnerName: "farnell",
    baseUrl: "https://farnell.componentsearchengine.com"
  }
};
const EMPTY_PART_CONTEXT = {
  provider: null,
  sourcePartLabel: null,
  sourcePartNumber: null,
  manufacturerPartNumber: null,
  lookup: null
};

function isEasyedaHost() {
  const url = new URL(window.location.href);
  return /^https?:$/.test(url.protocol) && !url.username && !url.password &&
    !url.port && /^(www\.)?(lcsc|jlcpcb)\.com$/i.test(url.hostname);
}

function isElement14Host() {
  return /(^|\.)element14\.com$/i.test(window.location.hostname);
}

function isNewarkHost() {
  return /(^|\.)newark\.com$/i.test(window.location.hostname);
}

// Normalize a label so we can compare it reliably.
function normalizeLabel(text) {
  return text.replace(/[.:]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeDetectedValue(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value || null;
}

function buildQueryString(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
    .join("&");
}

function findLabeledTextInPairs(pairs, expectedLabels) {
  const normalizedExpectedLabels = expectedLabels.map((label) => normalizeLabel(label));
  for (const [labelNode, valueNode] of pairs) {
    if (!labelNode || !valueNode) {
      continue;
    }
    const label = normalizeLabel(labelNode.textContent || "");
    if (normalizedExpectedLabels.includes(label)) {
      // Newark places a Copy button inside the MPN value cell.
      const value = valueNode.cloneNode(true);
      for (const button of value.querySelectorAll('button, [role="button"]')) {
        if (button.textContent.trim().toLowerCase() === "copy") button.remove();
      }
      const text = normalizeDetectedValue(value.textContent);
      if (text) return text;
    }
  }
  return null;
}

function findDefinitionListText(expectedLabels) {
  return findLabeledTextInPairs(
    Array.from(document.querySelectorAll("dl dt"), label => [
      label, label.nextElementSibling?.matches("dd") ? label.nextElementSibling : null
    ]),
    expectedLabels
  );
}

function findTableText(expectedLabels) {
  return findLabeledTextInPairs(
    Array.from(document.querySelectorAll("table.tableInfoWrap tr"), (row) => {
      const cells = row.querySelectorAll("td");
      return [cells[0], cells[1]];
    }),
    expectedLabels
  );
}

function findLabeledText(expectedLabels) {
  return (
    findDefinitionListText(expectedLabels) ||
    findTableText(expectedLabels)
  );
}

// Match the supported product route on an approved host. Only the catalogue ID
// in the route identifies the part; URL metadata remains separate evidence.
function parseEasyedaProductUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const route = /^(www\.)?jlcpcb\.com$/.test(host)
    ? /^\/partdetail\/[^/]+\/(C\d{3,})\/?$/i
    : /^(www\.)?lcsc\.com$/.test(host)
      ? /^\/product-detail\/(C\d{3,})\.html\/?$/i : null;
  return route?.exec(url.pathname)?.[1].toUpperCase() || null;
}

// A field belongs to the current product only when its whole ancestry and its
// linked product identity qualify. Callers apply the same checks to descendants.
function isCurrentEasyedaField(node) {
  if (node.closest("aside, nav, footer, script, style, template")) return false;
  for (let element = node; element; element = element.parentElement) {
    if (element.hidden || element.hasAttribute("inert") ||
        element.getAttribute("aria-hidden") === "true" ||
        /recommend|related/i.test(`${element.id} ${element.className} ${element.getAttribute("aria-label") || ""}`)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse") return false;
    if (element.matches("a[href]")) {
      const linkedId = parseEasyedaProductUrl(element.href);
      if (linkedId && linkedId !== parseEasyedaProductUrl(window.location.href)) return false;
    }
  }
  return true;
}

// Collect adjacent label/value pairs, then qualify each table using its own
// visible catalogue anchor. This keeps recommendations and nested data separate.
function findEasyedaFieldPairs() {
  const isCurrentPair = ([label, value]) => value &&
    !label.parentElement.closest("dd, td, th") &&
    !value.querySelector("dt, dd, tr, script, style, template") &&
    [label, value].every(node => isCurrentEasyedaField(node) &&
      Array.from(node.querySelectorAll("*")).every(isCurrentEasyedaField));
  // Modern JLCPCB wraps each dt/dd pair in a div. Adjacent siblings preserve
  // the label/value association within each group.
  const root = document.querySelector("main") || document.body;
  const pairs = Array.from(root.querySelectorAll("dl dt"), label => [
    label, label.nextElementSibling?.matches("dd") ? label.nextElementSibling : null
  ]).filter(isCurrentPair);
  for (const table of root.querySelectorAll("table")) {
    const rows = Array.from(table.querySelectorAll("tr"))
      .filter(row => row.closest("table") === table)
      .map(row => Array.from(row.children).filter(cell => cell.matches("th, td")))
      .filter(cells => cells.length === 2 && isCurrentPair(cells));
    // Current LCSC summaries use plain tables. Their own visible,
    // complete catalogue field must qualify the table before reading its MPN.
    const isLcscSummary = /^(www\.)?lcsc\.com$/i.test(window.location.hostname) &&
      rows.some(([label, value]) => normalizeLabel(label.textContent || "") === "lcsc part #" &&
        /^C\d{3,}$/i.test(normalizeDetectedValue(value.textContent) || ""));
    if (table.matches(".tableInfoWrap") || isLcscSummary) pairs.push(...rows);
  }
  return pairs;
}

function getInputValue(id) {
  const input = document.getElementById(id);
  return normalizeDetectedValue(input?.value);
}

function getTextContent(selector) {
  const element = document.querySelector(selector);
  return normalizeDetectedValue(element?.textContent);
}

function getMetaContent(attribute, value) {
  const element = document.querySelector(`meta[${attribute}="${value}"]`);
  return normalizeDetectedValue(element?.getAttribute("content"));
}

function getLinkHref(rel) {
  const element = document.querySelector(`link[rel="${rel}"]`);
  return normalizeDetectedValue(element?.getAttribute("href"));
}

function getQueryParamValue(...keys) {
  const url = new URL(window.location.href);
  for (const key of keys) {
    const value = normalizeDetectedValue(url.searchParams.get(key));
    if (value) {
      return value;
    }
  }
  return null;
}

function parseFarnellDescriptionProductData() {
  const description =
    getMetaContent("property", "og:description") || getMetaContent("name", "description");
  // Spaced hyphens delimit fields; internal MPN and manufacturer hyphens stay intact.
  const match = description?.match(/Buy\s+(.+?)\s+-\s+(.+?)\s+-\s+/i);
  if (!match) {
    return null;
  }

  return {
    manufacturerPartNumber: normalizeDetectedValue(match[1]),
    manufacturerName: normalizeDetectedValue(match[2])
  };
}

function parseFarnellImageAltProductData(pathData) {
  const imageAlt = getMetaContent("property", "og:image:alt");
  const match = imageAlt?.match(/^(.+?)\s+([A-Z0-9][A-Z0-9./_+-]*)$/i);
  if (!match) {
    return null;
  }

  // Some captions append the entire description after the MPN. Only the
  // short manufacturer/MPN form can refine the identity on a product route.
  if (pathData && match[1].toUpperCase() !== pathData.manufacturerName &&
      match[2].toUpperCase() !== pathData.manufacturerPartNumber) {
    return null;
  }
  return {
    manufacturerName: normalizeDetectedValue(match[1]),
    manufacturerPartNumber: normalizeDetectedValue(match[2])
  };
}

function parseFarnellPathProductData() {
  let url;
  try {
    url = new URL(
      getLinkHref("canonical") ||
        getMetaContent("property", "og:url") ||
        window.location.href,
      window.location.href
    );
  } catch (error) {
    return null;
  }

  const pathnameMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/.+\/dp\/([^/?#]+)/i);
  if (!pathnameMatch) {
    return null;
  }

  const [, manufacturerSlug, manufacturerPartSlug, sourcePartNumber] = pathnameMatch;
  // URL parsing preserves malformed percent escapes. Decode inside the guard
  // so valid page fields and ECAD metadata remain available as fallbacks.
  try {
    return {
      manufacturerName: normalizeDetectedValue(
        decodeURIComponent(manufacturerSlug).replace(/-/g, " ").toUpperCase()
      ),
      manufacturerPartNumber: normalizeDetectedValue(
        decodeURIComponent(manufacturerPartSlug).toUpperCase()
      ),
      sourcePartNumber: normalizeDetectedValue(decodeURIComponent(sourcePartNumber))
    };
  } catch {
    return null;
  }
}

function findFarnellStructuredProduct(orderCode) {
  if (!orderCode) return null;
  // The order code identifies the current Product among recommendations and
  // graph entries. Dedicated MPN and organization fields retain punctuation.
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(script.textContent); } catch { continue; }
    const records = [data].flat().flatMap(node => [node].concat(node?.["@graph"] || []));
    for (const record of records) {
      if (![record?.["@type"]].flat().includes("Product") ||
          String(record.sku).toUpperCase() !== orderCode.toUpperCase() ||
          typeof record.mpn !== "string" || !record.mpn.trim()) continue;
      const manufacturer = [record.manufacturer, record.brand]
        .map(org => typeof org === "string" ? org : org?.name)
        .find(name => typeof name === "string" && name.trim());
      return {
        manufacturerPartNumber: normalizeDetectedValue(record.mpn),
        manufacturerName: normalizeDetectedValue(manufacturer)
      };
    }
  }
  return null;
}

function findFarnellProductData() {
  const descriptionData = parseFarnellDescriptionProductData();
  const pathData = parseFarnellPathProductData();
  const imageAltData = parseFarnellImageAltProductData(pathData);
  const sourcePartNumber = findLabeledText(
    isNewarkHost()
      ? ["Newark Part No", "Newark No", "Order Code"]
      : ["Order Code", "Farnell Part No", "Farnell No"]
  ) || pathData?.sourcePartNumber || getQueryParamValue("partNumber", "productId");
  const product = findFarnellStructuredProduct(sourcePartNumber);

  return {
    manufacturerName:
      product?.manufacturerName ||
      descriptionData?.manufacturerName ||
      findLabeledText(["Manufacturer"]) ||
      imageAltData?.manufacturerName ||
      pathData?.manufacturerName ||
      null,
    manufacturerPartNumber:
      product?.manufacturerPartNumber ||
      descriptionData?.manufacturerPartNumber ||
      findLabeledText(["Manufacturer Part No", "Mfr. Part #"]) ||
      imageAltData?.manufacturerPartNumber ||
      pathData?.manufacturerPartNumber ||
      null,
    sourcePartNumber
  };
}

function getFarnellBrandConfig() {
  if (isNewarkHost()) {
    return {
      partnerName: "newark",
      sourcePartLabel: "Newark part",
      baseUrl: "https://newark.componentsearchengine.com"
    };
  }
  if (isElement14Host()) {
    return {
      partnerName: "element14",
      sourcePartLabel: "element14 part",
      baseUrl: "https://element14.componentsearchengine.com"
    };
  }
  return {
    partnerName: "farnell",
    sourcePartLabel: "Farnell part",
    baseUrl: DISTRIBUTORS.farnell.baseUrl
  };
}

function extractEventValueFromOnclick(onclickText, key) {
  const text = String(onclickText || "");
  const match = text.match(new RegExp(`"${key}":"([^"]*)"`, "i"));
  return normalizeDetectedValue(match?.[1] || "");
}

// Read the fixed quoted arguments of Mouser's ECAD callback as inert text. The
// selected fields become encoded query values for the SamacSys entry request.
function parseLoadPartDivCall(onclickText) {
  const text = String(onclickText || "");
  const match = text.match(
    /loadPartDiv\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*[^,]+,\s*"([^"]*)"\s*,\s*[^,]+,\s*"([^"]*)"\s*,\s*"([^"]*)"/i
  );
  if (!match) {
    return null;
  }
  return {
    manufacturerName: normalizeDetectedValue(match[1]),
    manufacturerPartNumber: normalizeDetectedValue(match[2]),
    partnerName: normalizeDetectedValue(match[3]),
    format: normalizeDetectedValue(match[4]),
    logo: normalizeDetectedValue(match[5]),
    lang: normalizeDetectedValue(match[6])
  };
}

function buildSamacsysEntryUrl({
  baseUrl = DISTRIBUTORS.mouser.baseUrl,
  manufacturerName,
  manufacturerPartNumber,
  partnerName,
  logo,
  lang
}) {
  if (!manufacturerName || !manufacturerPartNumber || !partnerName) {
    return null;
  }

  const queryString = buildQueryString({
    mna: manufacturerName,
    mpn: manufacturerPartNumber,
    pna: partnerName,
    vrq: "multi",
    fmt: "zip",
    logo,
    lang
  });
  return `${baseUrl}/entry_u_newDesign.php?${queryString}`;
}

function buildSamacsysPartContext({
  distributor,
  sourcePartNumber,
  manufacturerPartNumber,
  manufacturerName,
  sourcePartLabel,
  partnerName,
  baseUrl,
  authRefreshUrl,
  logo,
  lang
}) {
  const config = DISTRIBUTORS[distributor];
  const resolvedPartnerName = partnerName || config.partnerName || distributor;
  const entryUrl = buildSamacsysEntryUrl({
    baseUrl: baseUrl || config.baseUrl,
    manufacturerName,
    manufacturerPartNumber,
    partnerName: resolvedPartnerName,
    logo,
    lang
  });
  if (!sourcePartNumber || !manufacturerPartNumber || !entryUrl) {
    return null;
  }

  return {
    provider: config.provider,
    sourcePartLabel: sourcePartLabel || config.sourcePartLabel,
    sourcePartNumber,
    manufacturerPartNumber,
    lookup: {
      manufacturerName,
      entryUrl,
      ...(authRefreshUrl ? { authRefreshUrl } : {}),
      partnerName: resolvedPartnerName,
      samacsysBaseUrl: baseUrl || config.baseUrl
    }
  };
}

function parseSamacsysLinkUrl(url, fallbackPartnerName = null) {
  if (!url) {
    return null;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url, window.location.href);
  } catch (error) {
    return null;
  }
  if (!/(^|\.)componentsearchengine\.com$/i.test(parsedUrl.hostname)) {
    return null;
  }

  return {
    baseUrl: parsedUrl.origin,
    manufacturerName: normalizeDetectedValue(parsedUrl.searchParams.get("mna")),
    manufacturerPartNumber: normalizeDetectedValue(parsedUrl.searchParams.get("mpn")),
    partnerName:
      normalizeDetectedValue(parsedUrl.searchParams.get("pna")) || fallbackPartnerName,
    logo: normalizeDetectedValue(parsedUrl.searchParams.get("logo")),
    lang: normalizeDetectedValue(parsedUrl.searchParams.get("lang"))
  };
}

function findSamacsysLinkElement() {
  return (
    document.querySelector('a[href*="componentsearchengine.com/"]') ||
    document.querySelector('a img[alt*="Supply Frame Models Link" i]')?.closest("a") ||
    null
  );
}

function findMouserPartNumber(ecadButton) {
  return (
    getInputValue("MouserPartNumFormattedForProdInfo") ||
    getTextContent("#spnMouserPartNumFormattedForProdInfo") ||
    normalizeDetectedValue(
      extractEventValueFromOnclick(ecadButton?.getAttribute("onclick"), "event_mouserpn")
    )?.toUpperCase() ||
    null
  );
}

function findMouserManufacturerPartNumber(ecadButton) {
  return (
    getInputValue("ManufacturerPartNumber") ||
    getTextContent("#spnManufacturerPartNumber") ||
    normalizeDetectedValue(
      extractEventValueFromOnclick(
        ecadButton?.getAttribute("onclick"),
        "event_manufacturerpn"
      )
    )?.toUpperCase() ||
    null
  );
}

function findMouserPartContext() {
  const ecadButton = document.querySelector(
    '#lnk_CadModel[data-testid="ProductInfoECAD"]'
  );
  if (!ecadButton) {
    return null;
  }

  const onclickText = ecadButton.getAttribute("onclick") || "";
  const loadPartDivData = parseLoadPartDivCall(onclickText);
  const sourcePartNumber = findMouserPartNumber(ecadButton);
  const manufacturerPartNumber =
    findMouserManufacturerPartNumber(ecadButton) ||
    loadPartDivData?.manufacturerPartNumber ||
    null;
  const manufacturerName =
    loadPartDivData?.manufacturerName ||
    extractEventValueFromOnclick(onclickText, "event_manufacturer") ||
    null;
  return buildSamacsysPartContext({
    distributor: "mouser",
    sourcePartNumber,
    manufacturerPartNumber,
    manufacturerName,
    baseUrl: DISTRIBUTORS.mouser.baseUrl,
    logo: loadPartDivData?.logo,
    lang: loadPartDivData?.lang
  });
}

function findFarnellPartContext() {
  const brandConfig = getFarnellBrandConfig();
  const samacsysLink = findSamacsysLinkElement();
  const linkMetadata = parseSamacsysLinkUrl(
    samacsysLink?.href,
    brandConfig.partnerName
  );
  const farnellProductData = findFarnellProductData();
  const manufacturerName = linkMetadata?.manufacturerName || farnellProductData.manufacturerName;
  const manufacturerPartNumber =
    linkMetadata?.manufacturerPartNumber || farnellProductData.manufacturerPartNumber;
  return buildSamacsysPartContext({
    distributor: "farnell",
    sourcePartLabel: brandConfig.sourcePartLabel,
    sourcePartNumber: farnellProductData.sourcePartNumber,
    manufacturerPartNumber,
    manufacturerName,
    partnerName: linkMetadata?.partnerName || brandConfig.partnerName,
    baseUrl: linkMetadata?.baseUrl || brandConfig.baseUrl,
    authRefreshUrl: linkMetadata ? samacsysLink.href : null,
    logo: linkMetadata?.logo,
    lang: linkMetadata?.lang
  });
}

function findEasyedaPartContext() {
  if (!isEasyedaHost()) {
    return null;
  }

  // Use one snapshot of the visible product fields for both identifiers. A
  // labelled catalogue ID ties the MPN to the part. The route can identify a
  // product on its own, and conflicting catalogue IDs leave it unidentified.
  const ids = new Set();
  const mpns = new Set();
  for (const [labelNode, valueNode] of findEasyedaFieldPairs()) {
    const label = normalizeLabel(labelNode.textContent);
    const value = normalizeDetectedValue(valueNode.textContent);
    if (!value) continue;
    if (["jlcpcb part #", "lcsc part #"].includes(label) && /^C\d{3,}$/i.test(value)) {
      ids.add(value.toUpperCase());
    } else if (["mfr part #", "mpn"].includes(label)) {
      mpns.add(value);
    }
  }
  const hasLabelledId = ids.size > 0;
  const routeId = parseEasyedaProductUrl(window.location.href);
  if (routeId) ids.add(routeId);
  if (ids.size !== 1) return null;
  const [lcscId] = ids;
  return {
    provider: EASYEDA_PROVIDER,
    sourcePartLabel: EASYEDA_SOURCE_LABEL,
    sourcePartNumber: lcscId,
    manufacturerPartNumber: hasLabelledId && mpns.size === 1 ? [...mpns][0] : null,
    lookup: {
      lcscId
    }
  };
}

function findPartContext() {
  const host = window.location.hostname;
  if (/(^|\.)mouser\.(com|co\.uk)$/i.test(host)) return findMouserPartContext() || EMPTY_PART_CONTEXT;
  if (/(^|\.)(farnell|element14|newark)\.com$/i.test(host)) return findFarnellPartContext() || EMPTY_PART_CONTEXT;
  return findEasyedaPartContext() || EMPTY_PART_CONTEXT;
}

// Listen for extension messages and reply with the detected part context.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_PART_CONTEXT") {
    sendResponse(findPartContext());
    return true;
  }

  return false;
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
