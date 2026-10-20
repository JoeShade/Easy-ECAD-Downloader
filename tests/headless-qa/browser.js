/*
 * Operate the real unpacked extension through Chrome for Testing. Chrome's
 * action API opens its real popup; temporary profiles and downloads are isolated.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import { containsProtectedSecret, issue, repoRoot, redact, retryObservation } from "./common.js";
import { attachDiagnostics } from "./diagnostics.js";
import { symbolDownloadEvidence } from "./download_accounting.js";
import { downloadCleanupInventory } from "./download_preservation.js";
import { provisionSamacsysCredentials } from "./credentials.js";

// Install into a fresh short profile, observe diagnostics before installation,
// and provision session settings before returning a usable worker context.
export async function launchExtension(run, timeout, credentials = null, controlledSignals = false) {
  let profile, downloadRoot, browser, diagnostics;
  try {
    // Chrome's extension storage can hit Windows path limits beneath nested
    // evidence folders. Keep disposable profiles independent of the run path.
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "easy-ecad-qa-"));
    await run.log("browser-profile-created", { profile, temporary: true });
    // Chrome shortens filenames to fit the absolute Windows download path.
    // Acquire outside deep evidence trees, then preserve the delivered bytes.
    downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ecad-dl-"));
    await run.log("browser-download-directory-created", { downloadRoot, temporary: true,
      evidenceDirectory: path.join(run.dir, "downloads") });
    await fs.mkdir(path.join(profile, "Default"), { recursive: true });
    await fs.writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({ download: {
      default_directory: downloadRoot, prompt_for_download: false, directory_upgrade: true
    } }));
    browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: true,
      handleSIGINT: !controlledSignals, handleSIGTERM: !controlledSignals, handleSIGHUP: !controlledSignals,
      userDataDir: profile, timeout, protocolTimeout: Math.max(timeout, 180000),
      defaultViewport: { width: 1280, height: 900 } });
    diagnostics = await attachDiagnostics(browser, run);
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
    const authentication = await provisionSamacsysCredentials(worker, credentials);
    // CDP 'allow' overrides chrome.downloads filenames for data URLs. Profile
    // preferences retain the extension's grouped paths and conflict semantics.
    await run.log("browser-launched", { chrome: await browser.version(), id, api, settings,
      headless: true, pipe: true, executable: await puppeteer.executablePath(), args: browser.process()?.spawnargs.slice(1) });
    return { browser, worker, id, settings, profile, downloadRoot, diagnostics, authentication };
  } catch (error) {
    if (browser) await closeBrowser({ browser, profile, downloadRoot, diagnostics }, run);
    else {
      if (profile) await removeTemporaryDirectory(profile);
      if (downloadRoot) await removeTemporaryDirectory(downloadRoot);
    }
    throw issue(`Browser/extension preflight failed: ${redact(error.message)}`, "environment");
  }
}

// Recursive cleanup is restricted to one direct child of the system temp root.
async function removeTemporaryDirectory(directory) {
  const target = path.resolve(directory), temporary = path.resolve(os.tmpdir());
  if (path.dirname(target) !== temporary || target === temporary) {
    throw new Error("Refusing to remove a directory outside the temporary root");
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// A kill request is asynchronous. Confirm process exit before recursively removing
// directories that Chrome could still be using, and retain them after the budget.
async function waitForBrowserExit(processHandle) {
  if (processHandle.exitCode != null || processHandle.signalCode != null) return true;
  return new Promise(resolve => {
    const finished = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { processHandle.off("exit", finished); resolve(false); }, 5000);
    processHandle.once("exit", finished);
  });
}

// Clear session secrets and flush diagnostics before closing Chrome. Cleanup
// rechecks preservation after exit so late files and changed copies survive.
export async function closeBrowser(context, run) {
  if (!context) return;
  const processHandle = context.browser.process();
  let timer;
  try {
    if (context.worker) {
      await Promise.race([context.worker.evaluate(() => chrome.storage.session.clear()), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Session cleanup timed out")), 5000);
      })]).catch(error => run.log("session-cleanup-error", { message: error.message }));
      clearTimeout(timer);
    }
    await context.diagnostics?.close().catch(async error => {
      await run.log("diagnostic-cleanup-error", { message: error.message });
      await run.check?.("environment", "BLOCKED", "Runtime diagnostic persistence or cleanup failed",
        { category: "harness", cause: "diagnostic evidence", message: error.message });
    });
    if (context.diagnostics) {
      run.result.diagnostics = context.diagnostics.summary();
      await run.save();
    }
  } finally {
    clearTimeout(timer);
    let closed = false;
    try {
      await Promise.race([context.browser.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser close timed out")), 10000);
      })]);
      closed = true;
    } catch (error) {
      processHandle?.kill();
      await run.log("browser-close-error", { message: error.message });
    } finally {
      clearTimeout(timer);
      const stopped = processHandle ? await waitForBrowserExit(processHandle) : closed;
      if (stopped) {
        await removeTemporaryDirectory(context.profile)
          .catch(error => run.log("profile-cleanup-error", { message: error.message }));
        if (context.downloadRoot) {
          const entries = await fs.readdir(context.downloadRoot).catch(() => null);
          const inventory = context.downloadsPreserved ? await downloadCleanupInventory(context.downloadRoot,
            path.join(run.dir, "downloads"), run.result.stages?.downloads.assets) : null;
          if (inventory?.cleanupSafe || entries?.length === 0) {
            await removeTemporaryDirectory(context.downloadRoot)
              .catch(error => run.log("download-directory-cleanup-error", { message: error.message }));
          } else if (entries !== null) {
            await run.log("browser-download-directory-retained", { downloadRoot: context.downloadRoot, inventory,
              reason: "Downloaded files require recovery because preservation is incomplete or changed" });
            if (inventory && !inventory.cleanupSafe) await run.check?.("downloads", "BLOCKED",
              "Acquisition or evidence contents changed after preservation; acquisition directory retained",
              { category: "harness", cause: "download preservation", inventory });
          }
        }
      } else {
        await run.log("browser-cleanup-retained", { profile: context.profile, downloadRoot: context.downloadRoot,
          reason: "Chrome process exit remains unconfirmed; temporary directories require recovery" });
        await run.check?.("environment", "BLOCKED", "Chrome process exit remains unconfirmed; temporary directories retained",
          { category: "harness", cause: "browser cleanup" });
      }
    }
  }
}

// Bring the distributor tab forward and confirm the same tab through extension
// APIs because the action popup reads the currently active browser tab.
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

// Ask Chrome to create its action popup and verify its popup view membership.
export async function openPopup(context, page, timeout) {
  const tab = await activateProduct(context, page);
  // Chrome's action API owns creation of the UI target.
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

// Observe the real content-script response through bounded retries; runtime API
// callback errors are retained as observations alongside later successful replies.
export async function partContext(context, tabId, timeout, retries) {
  return retryObservation(() => context.worker.evaluate(id => new Promise(resolve => {
    chrome.tabs.sendMessage(id, { type: "GET_PART_CONTEXT" }, response =>
      resolve({ response: response || null, error: chrome.runtime.lastError?.message || null }));
  }), tabId), timeout, retries);
}

// Collect page-authored identifiers independently of the extension and classify
// access/login/search screens before the runner captures product screenshots.
export async function productEvidence(page, httpStatus) {
  const evidence = await page.evaluate(() => {
    const products = [];
    // JSON-LD can nest Product records inside arrays and graph wrapper objects.
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
      try { visit(JSON.parse(script.textContent)); } catch { /* Other page fields remain available after malformed JSON-LD. */ }
    }
    const fields = [];
    for (const node of document.querySelectorAll("dt,tr")) {
      const label = (node.matches("dt") ? node.textContent : node.querySelector("th,td")?.textContent)?.trim();
      if (!label || !/^(?:mfr\.?|manufacturer|brand|mpn|sku|lcsc|jlcpcb|mouser|farnell|element14|newark|order code|part number)/i.test(label)) continue;
      const value = node.matches("dt") ? node.nextElementSibling?.textContent :
        [...node.querySelectorAll("td")].slice(node.querySelector("th") ? 0 : 1).map(x => x.textContent).join(" ");
      fields.push({ label: label.slice(0, 120), value: value?.trim().slice(0, 300) });
    }
    const body = document.body?.innerText || "";
    // Hidden login dialogs can keep full layout boxes. Computed visibility
    // follows CSS inheritance, while opacity on any ancestor hides its contents.
    const visiblePassword = input => {
      const box = input.getBoundingClientRect();
      if (box.height <= 0 || box.width <= 0 || ["hidden", "collapse"].includes(window.getComputedStyle(input).visibility)) return false;
      for (let node = input; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || Number(style.opacity || 1) === 0) return false;
      }
      return true;
    };
    return { title: document.title, headings: [...document.querySelectorAll("h1")].map(x => x.textContent.trim()),
      products, fields: fields.slice(0, 60),
      blocked: /access denied|verify you are human|captcha|unusual traffic|security check|just a moment/i.test(body.slice(0, 6000)),
      login: [...document.querySelectorAll('input[type="password"]')].some(visiblePassword),
      readyState: document.readyState,
      search: /\/search|\/w\/search|\/c\//i.test(window.location.pathname) || /search results/i.test(document.title) };
  });
  const classification = evidence.blocked || [401, 403, 429].includes(httpStatus) ? "ACCESS_BLOCKED" :
    evidence.login ? "LOGIN" : evidence.search ? "SEARCH" : evidence.products.length || evidence.fields.length ? "PRODUCT" : "UNKNOWN";
  return { ...evidence, httpStatus, classification, source: "product-page DOM, independent of extension" };
}

// Snapshot the displayed identifiers and option availability from the real popup.
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

// Inspect visible-context text and form values for entered secrets before saving
// bitmap evidence, complementing structural redaction of text evidence.
export async function safeScreenshot(surface, run, filename, stage, options = {}) {
  const text = await surface.evaluate(element => {
    const root = element || document.body;
    return [root?.textContent || "", ...[...(root?.querySelectorAll("input,textarea") || [])]
      .map(input => input.value)].join("\n");
  });
  if (containsProtectedSecret(text)) {
    await run.check(stage, "REVIEW", "Screenshot omitted because its DOM contains an entered session secret",
      { name: "evidence.screenshotPrivacy", evidence: filename, produced: false });
    return false;
  }
  await surface.screenshot({ path: path.join(run.dir, filename), ...options });
  return true;
}

// Observe each image until decode or fallback, preserve its displayed state, and
// keep image decoding separate from the later human assessment of CAD correctness.
export async function capturePreviews(popup, run, timeout) {
  for (const id of ["symbolPreview", "footprintPreview"]) {
    let timedOut = false, timeoutError = null;
    try {
      await popup.waitForFunction(id => {
        const image = document.getElementById(id), fallback = document.getElementById(`${id}Fallback`);
        return (image?.getAttribute("src") && image.complete) || (fallback && fallback.textContent !== "Loading...");
      }, { timeout }, id);
    } catch (error) { timedOut = true; timeoutError = redact(error.message); }
    const state = await popup.evaluate(async id => {
      const image = document.getElementById(id), fallback = document.getElementById(`${id}Fallback`);
      let decoded = false;
      if (image?.getAttribute("src") && image.complete) {
        try { await image.decode(); decoded = image.naturalWidth > 0 && image.naturalHeight > 0; } catch { /* The decoded flag retains its failure state. */ }
      }
      return { decoded, width: image?.naturalWidth, height: image?.naturalHeight,
        visible: image && !image.classList.contains("hidden"), fallback: fallback?.textContent,
        fallbackVisible: fallback && !fallback.classList.contains("hidden") };
    }, id);
    const filename = `browser/${id}.png`;
    const element = await popup.$(`#${id}`);
    const box = state.visible ? element : await popup.$(`#${id}Fallback`);
    await safeScreenshot(box, run, filename, "previews");
    await run.check("previews", state.decoded ? "PASS" : timedOut ? "BLOCKED" : "REVIEW",
      state.decoded ? "Preview image decoded with nonzero dimensions" : "Preview unavailable or still loading",
      { id, ...state, timedOut, error: timeoutError, category: timedOut ? "harness" : "preview-observation",
        cause: timedOut ? "harness timeout" : "unknown", evidence: filename });
  }
  await safeScreenshot(popup, run, "browser/popup.png", "previews", { fullPage: true });
  await run.check("previews", "REVIEW", "Visual correctness requires inspection of saved preview images");
}

// Keep browser download history and generated symbol expectations while dropping
// the payload URL before ordinary diagnostic/evidence serialization.
export async function downloadItems(context) {
  const items = await context.worker.evaluate(async () => (await chrome.downloads.search({})).map(item => ({
    id: item.id, filename: item.filename, state: item.state, error: item.error,
    bytesReceived: item.bytesReceived, totalBytes: item.totalBytes,
    startTime: item.startTime, endTime: item.endTime,
    byExtensionId: item.byExtensionId,
    symbolDataUrl: /\.kicad_sym$/i.test(item.filename) && item.url?.startsWith("data:") ? item.url : null
  })));
  return items.map(item => {
    const evidence = symbolDownloadEvidence(item);
    delete item.symbolDataUrl;
    return { ...item, ...evidence };
  });
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
