/*
 * Single-product integration runner. Each stage saves execution separately
 * from check outcomes, and partial completed downloads can still be rendered.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, accountDownloads, command, createRun, issue, now, options, poll, redact, repoRoot } from "./common.js";
import { activateProduct, capturePreviews, closeBrowser, downloadItems, launchExtension,
  openPopup, partContext, popupState, productEvidence } from "./browser.js";

export async function metadata(run, requestedUrl = null) {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "manifest.json"), "utf8"));
  const puppeteer = JSON.parse(await fs.readFile(path.join(repoRoot, "node_modules/puppeteer/package.json"), "utf8"));
  const commit = await command("git", ["rev-parse", "HEAD"], { log: run.log });
  const dirty = await command("git", ["status", "--porcelain"], { log: run.log });
  const data = { schemaVersion: 1, id: run.result.id, kind: run.result.kind, requestedUrl,
    startedAt: run.result.startedAt, node: process.version, platform: process.platform,
    extension: { version: manifest.version, directory: repoRoot }, puppeteer: puppeteer.version,
    repository: { commit: commit.stdout.trim(), dirty: Boolean(dirty.stdout.trim()) } };
  await atomicJson(path.join(run.dir, "metadata.json"), data);
  return data;
}

export async function pythonPreflight(run, opts, meta) {
  const args = ["tests/headless-qa/render.py", "--preflight", "--output", path.join(run.dir, "renders/environment"),
    "--timeout", String(opts["render-timeout"] / 1000)];
  if (opts["kicad-cli"]) args.push("--kicad-cli", opts["kicad-cli"]);
  const record = await command(opts.python, args, { timeout: opts["render-timeout"], log: run.log });
  const report = await fs.readFile(path.join(run.dir, "renders/environment/render-result.json"), "utf8")
    .then(JSON.parse).catch(() => null);
  if (report) Object.assign(meta, { python: report.python, pillow: report.pillow, kicad: report.kicad });
  await atomicJson(path.join(run.dir, "metadata.json"), meta);
  await run.check("environment", record.code === 0 ? "PASS" : "BLOCKED",
    record.code === 0 ? "Python image support and installed KiCad 10 rendering help verified" :
      "Python/KiCad preflight unavailable; browser stages can still run", { category: "environment", evidence: "renders/environment/render-result.json" });
  return record.code === 0;
}

async function compareIdentifiers(run, detected, reference) {
  const candidates = [...reference.products.map(value => value.mpn).filter(Boolean),
    ...reference.fields.filter(value => /^(mfr\.? (part|no)|manufacturer part|mpn)/i.test(value.label)).map(value => value.value)].filter(Boolean);
  const unique = [...new Set(candidates.map(value => value.trim()))];
  if (unique.length === 1) {
    await run.check("detection", detected?.manufacturerPartNumber === unique[0] ? "PASS" : "FAIL",
      "Extension manufacturer part number agrees with independent page field",
      { expected: unique[0], actual: detected?.manufacturerPartNumber || null, category: "extension-observation" });
  } else await run.check("detection", "REVIEW", "Independent manufacturer part number missing or ambiguous", { candidates: unique });
  const sources = reference.fields.filter(value => /^(lcsc|jlcpcb|mouser|farnell|newark).*(part|no)|^order code/i.test(value.label));
  if (detected?.provider === "easyedaLcsc") {
    for (const product of reference.products) if (/^C\d+$/.test(product.sku || "")) sources.push({ label: "Product JSON-LD sku", value: product.sku });
  }
  const sourceValues = [...new Set(sources.map(field => field.value).filter(Boolean))];
  if (sourceValues.length === 1) {
    await run.check("detection", sourceValues[0] === detected?.sourcePartNumber ? "PASS" : "FAIL",
      "Extension distributor identifier agrees with independent page field",
      { expected: sourceValues[0], actual: detected?.sourcePartNumber, category: "extension-observation" });
  } else await run.check("detection", "REVIEW", "Distributor identifier needs independent page-field review", { fields: sources });
}

async function collectDownloads(context, popup, run, opts) {
  const selected = await popup.evaluate(() => {
    const result = [];
    for (const id of ["downloadSymbol", "downloadFootprint", "downloadModel", "downloadDatasheet"]) {
      const input = document.getElementById(id);
      if (input && !input.disabled) {
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        result.push(id);
      }
    }
    // Observe the real UI request and delegate it unchanged to the extension runtime.
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__qaExport = null;
    chrome.runtime.sendMessage = (...args) => {
      if (args[0]?.type === "EXPORT_PART" && typeof args[1] === "function") {
        const callback = args[1];
        args[1] = response => {
          window.__qaExport = { ok: response?.ok, downloadCount: response?.downloadCount || 0,
            warnings: response?.warnings || [], error: response?.error || chrome.runtime.lastError?.message || null };
          callback(response);
        };
      }
      return send(...args);
    };
    return result;
  });
  run.result.stages.downloads.selected = selected;
  run.result.stages.downloads.settings = context.settings;
  await run.save();
  if ((await popupState(popup)).downloadDisabled) throw issue("Popup download button is disabled", "extension-observation");
  let response = null;
  try {
    await popup.click("#downloadButton");
    await poll(async () => {
      response = await popup.evaluate(() => window.__qaExport);
      const items = await downloadItems(context);
      return { response, items };
    }, ({ response, items }) => response && items.length >= response.downloadCount &&
      items.every(item => ["complete", "interrupted"].includes(item.state)), opts["download-timeout"]);
  } finally {
    const items = await downloadItems(context);
    const rows = await accountDownloads(items, path.join(run.dir, "downloads"));
    Object.assign(run.result.stages.downloads, { response: response ? JSON.parse(redact(JSON.stringify(response))) : null,
      files: rows, popup: await popupState(popup) });
    await run.save();
    await popup.screenshot({ path: path.join(run.dir, "browser/popup-after-download.png"), fullPage: true });
    for (const row of rows) await run.check("downloads", row.verified ? "PASS" : "FAIL",
      row.verified ? "Browser download completed and nonempty file exists inside this run" : "Download interrupted, absent, empty or outside run", row);
  }
  const state = run.result.stages.downloads;
  if (!response?.ok) {
    const error = response?.error || state.popup.status || "Export did not succeed";
    const blocked = /sign.in|unauthor|401|403|429|captcha|fetch|network/i.test(error);
    await run.check("downloads", blocked ? "BLOCKED" : "FAIL", redact(error),
      { category: blocked ? "external-service" : "extension-observation" });
  }
  for (const warning of response?.warnings || []) await run.check("downloads", "REVIEW", redact(warning), { category: "extension-observation" });
  const types = { downloadSymbol: /\.kicad_sym$/i, downloadFootprint: /\.kicad_mod$/i,
    downloadModel: /\.(?:step|stp|wrl)$/i, downloadDatasheet: /\.(?:pdf|html)$/i };
  for (const id of selected) {
    const found = state.files.some(file => file.verified && types[id].test(file.filename));
    await run.check("downloads", found ? "PASS" : "REVIEW", found ? "Selected asset category has a completed file" :
      "No completed file for selected asset category; upstream availability needs review", { option: id });
  }
}

export async function finish(run) {
  run.result.finishedAt = now();
  const outcomes = Object.values(run.result.stages).flatMap(stage => stage.checks.map(check => check.outcome));
  run.result.outcomes = [...new Set(outcomes)];
  await run.save();
  console.log(JSON.stringify({ execution: run.result.execution, outcomes: run.result.outcomes, evidence: run.dir }));
  process.exitCode = outcomes.includes("FAIL") ? 1 : outcomes.includes("BLOCKED") ? 2 : 0;
}

async function main() {
  const opts = options({ url: { type: "string" } });
  if (!opts.url) throw new Error("--url is required");
  const url = new URL(opts.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
    [...url.searchParams.keys()].some(key => /token|password|auth|session|signature/i.test(key))) {
    throw new Error("Supply a public product URL without session credentials");
  }
  const run = await createRun(opts.out, opts.id);
  const meta = await metadata(run, opts.url);
  let context, popup, renderReady = false;
  try {
    await run.stage("environment", async () => {
      renderReady = await pythonPreflight(run, opts, meta);
      context = await launchExtension(run, opts.timeout);
      Object.assign(meta, { chrome: await context.browser.version(), extensionId: context.id, effectiveSettings: context.settings });
      await atomicJson(path.join(run.dir, "metadata.json"), meta);
      await run.check("environment", "PASS", "Headless Chrome loaded actual extension and live service worker in isolated profile");
    });
    const page = await context.browser.newPage();
    let reference;
    await run.stage("navigation", async () => {
      let response;
      try { response = await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: opts.timeout }); }
      catch (error) {
        Object.assign(run.result.stages.navigation, { requestedUrl: opts.url, finalUrl: redact(page.url()) });
        throw issue(`Navigation failed: ${redact(error.message)}`, "external-service");
      }
      let fingerprint, stableSince = Date.now();
      reference = await poll(async () => {
        const value = await productEvidence(page, response?.status());
        const current = JSON.stringify(value);
        if (current !== fingerprint) { fingerprint = current; stableSince = Date.now(); }
        return value;
      }, value => ["ACCESS_BLOCKED", "LOGIN", "SEARCH"].includes(value.classification) ||
        (value.readyState === "complete" && Date.now() - stableSince >= 2000), opts.timeout)
        .catch(async () => productEvidence(page, response?.status()));
      reference = JSON.parse(redact(JSON.stringify(reference)));
      Object.assign(run.result.stages.navigation, { requestedUrl: opts.url, finalUrl: redact(page.url()), reference });
      Object.assign(meta, { finalUrl: redact(page.url()) });
      await atomicJson(path.join(run.dir, "metadata.json"), meta);
      await atomicJson(path.join(run.dir, "browser/product-reference.json"), reference);
      if (["ACCESS_BLOCKED", "LOGIN", "SEARCH"].includes(reference.classification)) {
        throw issue(`Resolved page is ${reference.classification}; no authentication or access-control bypass attempted`, "external-service");
      }
      await run.check("navigation", reference.classification === "PRODUCT" ? "PASS" : "REVIEW",
        "Product-page classification from independent DOM fields", { classification: reference.classification });
      if (reference.classification === "PRODUCT") await page.screenshot({ path: path.join(run.dir, "browser/product.png"), fullPage: true });
    });
    await run.stage("detection", async () => {
      const tab = await activateProduct(context, page);
      const detected = await partContext(context, tab.id, opts.timeout, opts.retries);
      Object.assign(run.result.stages.detection, { website: new URL(page.url()).hostname,
        partContext: detected.response, error: detected.error,
        provider: detected.response?.provider, distributorPartNumber: detected.response?.sourcePartNumber,
        manufacturerPartNumber: detected.response?.manufacturerPartNumber,
        manufacturerName: detected.response?.lookup?.manufacturerName || null });
      await run.check("detection", detected.response?.provider ? "PASS" : "FAIL",
        "Real content script GET_PART_CONTEXT returned a provider", { error: detected.error, category: "extension-observation" });
      await compareIdentifiers(run, detected.response, reference);
    });
    await run.stage("popup", async () => {
      popup = await openPopup(context, page, opts.timeout);
      await popup.waitForFunction(() => document.getElementById("manufacturerPartNumber").textContent !== "Searching...", { timeout: opts.timeout });
      run.result.stages.popup.dom = await popupState(popup);
      await run.check("popup", "PASS", "Chrome created the actual action popup, verified by extension popup view type");
    });
    await run.stage("previews", () => capturePreviews(popup, run, opts.timeout));
    run.result.stages.popup.dom = await popupState(popup);
    await run.save();
    await run.stage("downloads", () => collectDownloads(context, popup, run, opts));
  } catch (error) {
    run.result.execution = "FAILED";
    await run.log("integration-stopped", { message: error.message });
  } finally { await closeBrowser(context, run); }
  const files = run.result.stages.downloads.files || [];
  if (renderReady && files.some(file => file.verified && /\.(kicad_mod|kicad_sym)$/.test(file.filename))) {
    try {
      await run.stage("rendering", async () => {
        const args = ["tests/headless-qa/render.py", "--input", path.join(run.dir, "downloads"),
          "--output", path.join(run.dir, "renders/assets"), "--project", path.join(run.dir, "inspection-project"),
          "--timeout", String(opts["render-timeout"] / 1000)];
        if (opts["kicad-cli"]) args.push("--kicad-cli", opts["kicad-cli"]);
        await command(opts.python, args, { timeout: opts["render-timeout"] * 30, log: run.log });
        const rendered = JSON.parse(await fs.readFile(path.join(run.dir, "renders/assets/render-result.json"), "utf8"));
        run.result.stages.rendering.report = "renders/assets/render-result.json";
        for (const check of rendered.checks) await run.check("rendering", check.outcome, check.establishes, check);
        if (rendered.execution !== "COMPLETED") throw issue("Renderer execution did not complete");
      });
    } catch { run.result.execution = "FAILED"; }
  }
  if (run.result.execution === "RUNNING") run.result.execution = "COMPLETED";
  if (run.result.stages.rendering.execution === "NOT_RUN") {
    await run.check("rendering", "NOT_RUN", renderReady ? "No completed CAD downloads available to render" : "KiCad/Python environment unavailable");
  }
  await finish(run);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(import.meta.dirname, "run.js")) {
  main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
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
