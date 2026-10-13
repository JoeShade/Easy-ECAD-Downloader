/*
 * Operate the real unpacked extension through Chrome for Testing. The popup
 * is opened by chrome.action.openPopup; no extension HTML tab is created.
 */
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { issue, poll, repoRoot, redact } from "./common.js";

export async function launchExtension(run, timeout) {
  const profile = path.join(run.dir, "browser", "profile");
  let browser;
  try {
    await fs.mkdir(path.join(profile, "Default"), { recursive: true });
    await fs.writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({ download: {
      default_directory: path.join(run.dir, "downloads"), prompt_for_download: false, directory_upgrade: true
    } }));
    browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: true,
      userDataDir: profile, timeout, protocolTimeout: Math.max(timeout, 180000),
      defaultViewport: { width: 1280, height: 900 } });
    if (typeof browser.installExtension !== "function") throw issue("Installed Puppeteer lacks installExtension");
    const id = await browser.installExtension(repoRoot);
    const target = await browser.waitForTarget(target => target.type() === "service_worker" &&
      target.url() === `chrome-extension://${id}/src/service_worker.js`, { timeout });
    const worker = await target.worker();
    if (!worker) throw issue("Extension service worker unavailable");
    const api = await worker.evaluate(() => ({ openPopup: typeof chrome.action?.openPopup,
      runtimeId: chrome.runtime.id, version: chrome.runtime.getManifest().version }));
    if (api.openPopup !== "function") throw issue("Chrome action.openPopup API unavailable");
    const settings = await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.storage.local.set({ downloadIndividually: false, libraryDownloadRoot: "easyECADDownloader" });
      return chrome.storage.local.get(["downloadIndividually", "libraryDownloadRoot"]);
    });
    // CDP 'allow' overrides chrome.downloads filenames for data URLs. Profile
    // preferences retain the extension's grouped paths and conflict semantics.
    await run.log("browser-launched", { chrome: await browser.version(), id, api, settings,
      headless: true, pipe: true, executable: await puppeteer.executablePath(), args: browser.process()?.spawnargs.slice(1) });
    return { browser, worker, id, settings, profile };
  } catch (error) {
    if (browser) await closeBrowser({ browser, profile }, run);
    else await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw issue(`Browser/extension preflight failed: ${redact(error.message)}`, "environment");
  }
}

export async function closeBrowser(context, run) {
  if (!context) return;
  const processHandle = context.browser.process();
  let timer;
  try {
    await Promise.race([context.browser.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser close timed out")), 10000);
    })]);
  } catch (error) {
    processHandle?.kill();
    await run.log("browser-close-error", { message: error.message });
  } finally {
    clearTimeout(timer);
    await fs.rm(context.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(error => run.log("profile-cleanup-error", { message: error.message }));
  }
}

export async function activateProduct(context, page) {
  await page.bringToFront();
  const tab = await context.worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length !== 1 || (tabs[0].url !== url && !(url === "about:blank" && !tabs[0].url))) {
      throw new Error("Product tab is not active");
    }
    return { id: tabs[0].id, windowId: tabs[0].windowId, url: tabs[0].url };
  }, page.url());
  return tab;
}

export async function openPopup(context, page, timeout) {
  const tab = await activateProduct(context, page);
  // The UI target is created by Chrome's action API, never by page.goto().
  try { await context.worker.evaluate(windowId => chrome.action.openPopup({ windowId }), tab.windowId); }
  catch (error) { throw issue(`Actual headless popup activation blocked: ${redact(error.message)}`); }
  const target = await context.browser.waitForTarget(target =>
    target.url() === `chrome-extension://${context.id}/src/popup.html`, { timeout })
    .catch(error => { throw issue(`Actual popup target unavailable: ${error.message}`); });
  const popup = await target.asPage();
  await popup.waitForSelector("#manufacturerPartNumber", { timeout });
  const viewType = await popup.evaluate(() => chrome.extension.getViews({ type: "popup" }).includes(window));
  if (!viewType) throw issue("Created target is not a real extension popup");
  return popup;
}

export async function partContext(context, tabId, timeout, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await poll(() => context.worker.evaluate(id => new Promise(resolve => {
        chrome.tabs.sendMessage(id, { type: "GET_PART_CONTEXT" }, response =>
          resolve({ response: response || null, error: chrome.runtime.lastError?.message || null }));
      }), tabId), value => !value.error, Math.max(1, Math.floor(timeout / (retries + 1))));
    } catch (error) { if (attempt === retries) return error.last || { response: null, error: error.message }; }
  }
}

export async function productEvidence(page, httpStatus) {
  const evidence = await page.evaluate(() => {
    const products = [];
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if ([value["@type"]].flat().includes("Product")) {
        products.push({ name: value.name, sku: value.sku, mpn: value.mpn,
          brand: typeof value.brand === "object" ? value.brand?.name : value.brand,
          manufacturer: typeof value.manufacturer === "object" ? value.manufacturer?.name : value.manufacturer });
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (typeof child === "object") visit(child);
      }
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch { /* Malformed page data is not extension output. */ }
    }
    const fields = [];
    for (const node of document.querySelectorAll("dt,tr")) {
      const label = (node.matches("dt") ? node.textContent : node.querySelector("th,td")?.textContent)?.trim();
      if (!label || !/^(?:mfr\.?|manufacturer|brand|mpn|sku|lcsc|jlcpcb|mouser|farnell|newark|order code|part number)/i.test(label)) continue;
      const value = node.matches("dt") ? node.nextElementSibling?.textContent :
        [...node.querySelectorAll("td")].slice(node.querySelector("th") ? 0 : 1).map(x => x.textContent).join(" ");
      fields.push({ label: label.slice(0, 120), value: value?.trim().slice(0, 300) });
    }
    const body = document.body?.innerText || "";
    return { title: document.title, headings: [...document.querySelectorAll("h1")].map(x => x.textContent.trim()),
      products, fields: fields.slice(0, 60),
      blocked: /access denied|verify you are human|captcha|unusual traffic|security check|just a moment/i.test(body.slice(0, 6000)),
      login: [...document.querySelectorAll('input[type="password"]')].some(input => input.getBoundingClientRect().height > 0),
      readyState: document.readyState,
      search: /\/search|\/w\/search|\/c\//i.test(window.location.pathname) || /search results/i.test(document.title) };
  });
  const classification = evidence.blocked || [401, 403, 429].includes(httpStatus) ? "ACCESS_BLOCKED" :
    evidence.login ? "LOGIN" : evidence.search ? "SEARCH" : evidence.products.length || evidence.fields.length ? "PRODUCT" : "UNKNOWN";
  return { ...evidence, httpStatus, classification, source: "product-page DOM, independent of extension" };
}

export async function popupState(popup) {
  return popup.evaluate(() => {
    const text = id => document.getElementById(id)?.textContent.trim();
    return { manufacturerPartNumber: text("manufacturerPartNumber"), sourcePartLabel: text("sourcePartLabel"),
      partNumber: text("partNumber"), status: text("status"),
      statusTone: document.getElementById("status")?.className,
      downloadDisabled: document.getElementById("downloadButton")?.disabled,
      options: ["downloadSymbol", "downloadFootprint", "downloadModel", "downloadDatasheet"].map(id => {
        const element = document.getElementById(id);
        return { id, checked: element?.checked, disabled: element?.disabled, label: element?.parentElement.textContent.trim() };
      }) };
  });
}

export async function capturePreviews(popup, run, timeout) {
  for (const id of ["symbolPreview", "footprintPreview"]) {
    let timedOut = false;
    try {
      await popup.waitForFunction(id => {
        const image = document.getElementById(id), fallback = document.getElementById(`${id}Fallback`);
        return (image?.getAttribute("src") && image.complete) || (fallback && fallback.textContent !== "Loading...");
      }, { timeout }, id);
    } catch { timedOut = true; }
    const state = await popup.evaluate(async id => {
      const image = document.getElementById(id), fallback = document.getElementById(`${id}Fallback`);
      let decoded = false;
      if (image?.getAttribute("src") && image.complete) {
        try { await image.decode(); decoded = image.naturalWidth > 0 && image.naturalHeight > 0; } catch { /* decoding failed */ }
      }
      return { decoded, width: image?.naturalWidth, height: image?.naturalHeight,
        visible: image && !image.classList.contains("hidden"), fallback: fallback?.textContent,
        fallbackVisible: fallback && !fallback.classList.contains("hidden") };
    }, id);
    const filename = `browser/${id}.png`;
    const element = await popup.$(`#${id}`);
    const box = state.visible ? element : await popup.$(`#${id}Fallback`);
    await box.screenshot({ path: path.join(run.dir, filename) });
    await run.check("previews", state.decoded ? "PASS" : timedOut ? "BLOCKED" : "REVIEW",
      state.decoded ? "Preview image decoded with nonzero dimensions" : "Preview unavailable or still loading",
      { id, ...state, timedOut, evidence: filename });
  }
  await popup.screenshot({ path: path.join(run.dir, "browser/popup.png"), fullPage: true });
  await run.check("previews", "REVIEW", "Visual correctness requires inspection of saved preview images");
}

export async function downloadItems(context) {
  return context.worker.evaluate(async () => (await chrome.downloads.search({})).map(item => ({
    id: item.id, filename: item.filename, state: item.state, error: item.error,
    bytesReceived: item.bytesReceived, totalBytes: item.totalBytes
  })));
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
