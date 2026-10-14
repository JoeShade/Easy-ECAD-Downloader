/*
 * Compare independent page fields, real detection and popup display separately.
 * Identifier punctuation/case are preserved; manufacturer names and labels
 * only collapse whitespace and case. Ambiguous references remain REVIEW.
 */
export function normalizeIdentifier(value, kind = "identifier") {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  return kind === "identifier" ? trimmed : trimmed.replace(/\s+/g, " ").toLowerCase();
}

function label(value) {
  return String(value || "").replace(/[.:#]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function referenceIdentifiers(reference, provider) {
  const fields = reference?.fields || [], products = reference?.products || [];
  const source = fields.filter(field => /^(?:(?:lcsc|jlcpcb|mouser|farnell|element14|newark) (?:part|no)|order code)/.test(label(field.label))).map(field => field.value);
  if (provider === "easyedaLcsc") source.push(...products.map(product => product.sku).filter(value => /^C\d+$/.test(value || "")));
  const values = {
    mpn: [...products.map(product => product.mpn), ...fields.filter(field => /^(?:mfr (?:part|no)|manufacturer part|mpn)/.test(label(field.label))).map(field => field.value)],
    distributor: source,
    manufacturer: [...products.flatMap(product => [product.manufacturer, product.brand]),
      ...fields.filter(field => /^(?:manufacturer|mfr|brand)$/.test(label(field.label))).map(field => field.value)]
  };
  return Object.fromEntries(Object.entries(values).map(([key, candidates]) => {
    const normalized = new Map();
    for (const candidate of candidates) {
      const value = normalizeIdentifier(candidate, key === "manufacturer" ? "manufacturer" : "identifier");
      if (value) normalized.set(value, candidate.trim());
    }
    return [key, [...normalized.values()]];
  }));
}

export function sourceLabelConvention(context, website = "") {
  if (context?.provider === "easyedaLcsc") return "LCSC part";
  if (context?.provider === "mouserSamacsys") return "Mouser part";
  if (context?.provider === "farnellSamacsys") {
    if (/(^|\.)element14\.com$/i.test(website)) return "element14 part";
    if (/(^|\.)newark\.com$/i.test(website)) return "Newark part";
    return "Farnell part";
  }
  return null;
}

export function identifierChecks(context, reference, popup = null, website = "") {
  const checks = [], refs = referenceIdentifiers(reference, context?.provider);
  const compare = (name, actual, candidates, kind = "identifier", unavailable = null) => {
    const expected = candidates.length === 1 ? candidates[0] : null;
    const available = !unavailable && Boolean(expected);
    const matches = normalizeIdentifier(actual, kind) === normalizeIdentifier(expected, kind);
    checks.push({ name, outcome: available ? matches ? "PASS" : "FAIL" : "REVIEW",
      establishes: available ? "Named identifier comparison agrees" : unavailable || "Independent reference missing or conflicting",
      actual: actual || null, expected, candidates, category: "extension-observation", cause: "unknown" });
  };
  compare("detected.mpn.page", context?.manufacturerPartNumber, refs.mpn);
  compare("detected.distributor.page", context?.sourcePartNumber, refs.distributor);
  const manufacturer = context?.lookup?.manufacturerName || context?.manufacturerName;
  const supportsManufacturer = ["mouserSamacsys", "farnellSamacsys"].includes(context?.provider) || Boolean(manufacturer);
  compare("detected.manufacturer.page", manufacturer, refs.manufacturer, "manufacturer",
    supportsManufacturer ? null : "Detected provider does not expose a manufacturer name");
  if (popup) {
    compare("popup.mpn.detected", popup.manufacturerPartNumber, context?.manufacturerPartNumber ? [context.manufacturerPartNumber] : [],
      "identifier", context?.manufacturerPartNumber ? null : "Detected MPN unavailable for comparison");
    compare("popup.distributor.detected", popup.partNumber, context?.sourcePartNumber ? [context.sourcePartNumber] : []);
    compare("popup.sourceLabel.detected", popup.sourcePartLabel, context?.sourcePartLabel ? [context.sourcePartLabel] : [], "label");
    compare("popup.mpn.page", popup.manufacturerPartNumber, refs.mpn);
    compare("popup.distributor.page", popup.partNumber, refs.distributor);
    const convention = sourceLabelConvention(context, website);
    compare("popup.sourceLabel.convention", popup.sourcePartLabel, convention ? [convention] : [], "label");
  }
  return checks;
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
