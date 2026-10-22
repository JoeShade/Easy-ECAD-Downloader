/*
 * These tests cover the dedicated settings page that owns persistent extension
 * preferences. They keep popup behavior focused while ensuring settings still
 * normalize, save, and hide secret values correctly.
 */

import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

import {
  flushAsyncWork,
  importRepoModule,
  normalizeNewlines,
  readRepoFile
} from "./helpers/test_harness.js";

const DEFAULT_STORED_SETTINGS = {
  downloadIndividually: false,
  libraryDownloadRoot: "easyECADDownloader",
  samacsysFirefoxProxyBaseUrl: "",
  samacsysFirefoxProxyAuthorizationHeader: "",
  samacsysFirefoxUsername: "",
  samacsysFirefoxPassword: "",
  rememberSamacsysCredentials: false,
  rememberSamacsysFirefoxProxyAuthorizationHeader: false
};

const DEFAULT_SESSION_SETTINGS = {
  samacsysFirefoxProxyAuthorizationHeader: "",
  samacsysFirefoxUsername: "",
  samacsysFirefoxPassword: ""
};

function createSettingsChrome({ sessionStorageState = {}, sessionReadError = false } = {}) {
  const state = {
    storageGetCalls: [],
    storageSetCalls: [],
    sessionGetCalls: [],
    sessionSetCalls: []
  };
  const sessionStorage = { ...sessionStorageState };

  const chrome = {
    runtime: {
      lastError: null
    },
    storage: {
      local: {
        get: vi.fn((defaults, callback) => {
          state.storageGetCalls.push({ defaults, callback });
        }),
        set: vi.fn((items, callback) => {
          state.storageSetCalls.push(items);
          callback?.();
        })
      },
      session: {
        get: vi.fn((defaults, callback) => {
          state.sessionGetCalls.push({ defaults, callback });
          if (sessionReadError) chrome.runtime.lastError = { message: "Storage unavailable." };
          callback({
            ...defaults,
            ...sessionStorage
          });
          chrome.runtime.lastError = null;
        }),
        set: vi.fn((items, callback) => {
          state.sessionSetCalls.push(items);
          Object.assign(sessionStorage, items);
          callback?.();
        })
      }
    }
  };

  return { chrome, state };
}

async function loadSettingsPage({
  userAgent = "Mozilla/5.0 Chrome/135.0.0.0",
  sessionStorageState = {},
  sessionReadError = false
} = {}) {
  const dom = new JSDOM(readRepoFile("src/settings.html"), {
    url: "https://example.test/settings.html"
  });
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: userAgent
  });
  const { chrome, state } = createSettingsChrome({ sessionStorageState, sessionReadError });
  const testApi = {};
  globalThis.chrome = chrome;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  globalThis.__settingsPageTestApi = testApi;
  await importRepoModule("src/settings_page.js");
  delete globalThis.__settingsPageTestApi;

  return {
    dom,
    chrome,
    state,
    hooks: testApi
  };
}

async function applyStoredSettings(state, settings = DEFAULT_STORED_SETTINGS) {
  state.storageGetCalls[0].callback(settings);
  await flushAsyncWork();
}

function dispatchChange(dom, element) {
  element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function dispatchInput(dom, element) {
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

async function saveChanges(hooks) {
  hooks.elements.saveSettingsEl.click();
  await flushAsyncWork();
}

describe("settings page", () => {
  it.each(["local", "session"])("preserves saved settings after a failed %s read", async (areaName) => {
    const { dom, chrome, state, hooks } = await loadSettingsPage({ sessionReadError: areaName === "session" });
    if (areaName === "local") {
      chrome.runtime.lastError = { message: "Storage unavailable." };
    }
    state.storageGetCalls[0].callback(DEFAULT_STORED_SETTINGS);
    chrome.runtime.lastError = null;
    await flushAsyncWork();
    await flushAsyncWork();
    expect(hooks.elements.statusEl.textContent).toContain("Failed to load settings");
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(true);
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    await hooks.saveSettings();
    expect(state.storageSetCalls).toHaveLength(0);
    expect(state.sessionSetCalls).toHaveLength(0);
  });

  it("preserves stored settings while the initial read is pending", async () => {
    const { dom, state, hooks } = await loadSettingsPage();
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(true);
    hooks.elements.downloadIndividuallyEl.checked = true;
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    await hooks.saveSettings();
    expect(state.storageSetCalls).toHaveLength(0);
    expect(hooks.elements.saveSettingsEl.disabled).toBe(true);

    await applyStoredSettings(state, {
      ...DEFAULT_STORED_SETTINGS,
      libraryDownloadRoot: "MyLibrary",
      rememberSamacsysCredentials: true,
      samacsysFirefoxUsername: "user@example.test",
      samacsysFirefoxPassword: "saved-password"
    });
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(false);
    expect(hooks.elements.libraryDownloadRootEl.value).toBe("MyLibrary");
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    await hooks.saveSettings();
    expect(state.storageSetCalls[0].samacsysFirefoxPassword).toBe("saved-password");
  });

  it("serializes saves and protects form edits until storage finishes", async () => {
    const { dom, chrome, state, hooks } = await loadSettingsPage();
    await applyStoredSettings(state);
    let finishLocalSave;
    chrome.storage.local.set.mockImplementation((items, callback) => {
      state.storageSetCalls.push(items);
      finishLocalSave = callback;
    });
    hooks.elements.downloadIndividuallyEl.checked = true;
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    const saving = hooks.saveSettings();
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(true);
    expect(hooks.elements.saveSettingsEl.disabled).toBe(true);
    await hooks.saveSettings();
    expect(state.storageSetCalls).toHaveLength(1);
    finishLocalSave();
    await saving;
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(false);
    expect(hooks.elements.statusEl.textContent).toBe("Settings saved.");
  });

  it("restores form interaction after a storage failure", async () => {
    const { dom, chrome, state, hooks } = await loadSettingsPage();
    await applyStoredSettings(state);
    chrome.storage.local.set.mockImplementation((_items, callback) => {
      chrome.runtime.lastError = { message: "Storage full." };
      callback();
      chrome.runtime.lastError = null;
    });
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    await hooks.saveSettings();
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(false);
    expect(hooks.elements.saveSettingsEl.disabled).toBe(false);
    expect(hooks.elements.statusEl.textContent).toBe("Storage full.");
  });

  it("restores remembered credentials if their session migration fails", async () => {
    const { dom, chrome, state, hooks } = await loadSettingsPage();
    const previous = { ...DEFAULT_STORED_SETTINGS, rememberSamacsysCredentials: true,
      samacsysFirefoxUsername: "user@example.test", samacsysFirefoxPassword: "saved-password" };
    await applyStoredSettings(state, previous);
    chrome.storage.session.set.mockImplementation((_items, callback) => {
      chrome.runtime.lastError = { message: "Session storage failed." };
      callback();
      chrome.runtime.lastError = null;
    });
    hooks.elements.rememberSamacsysCredentialsEl.checked = false;
    dispatchChange(dom, hooks.elements.rememberSamacsysCredentialsEl);
    await hooks.saveSettings();
    expect(state.storageSetCalls.at(-1)).toEqual(previous);
    expect(hooks.elements.statusEl.textContent).toBe("Session storage failed.");
    expect(hooks.elements.saveSettingsEl.disabled).toBe(false);
  });

  it("reports a partial save when restoring local settings also fails", async () => {
    const { dom, chrome, state, hooks } = await loadSettingsPage();
    await applyStoredSettings(state);
    chrome.storage.local.set.mockImplementationOnce((_items, callback) => callback())
      .mockImplementationOnce((_items, callback) => {
        chrome.runtime.lastError = { message: "Local storage unavailable." };
        callback();
        chrome.runtime.lastError = null;
      });
    chrome.storage.session.set.mockImplementation((_items, callback) => {
      chrome.runtime.lastError = { message: "Session storage unavailable." };
      callback();
      chrome.runtime.lastError = null;
    });
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    await hooks.saveSettings();
    expect(hooks.elements.statusEl.textContent).toContain("partly saved");
    expect(hooks.elements.statusEl.textContent).toContain("Reload");
    expect(hooks.elements.settingsForm.hasAttribute("inert")).toBe(false);
  });
  it("keeps hidden runtime-specific sections visually hidden", () => {
    const settingsPageCss = normalizeNewlines(
      readRepoFile("src/settings_page.css")
    );

    expect(settingsPageCss).toContain(
      "[hidden] {\n  display: none !important;\n}"
    );
    expect(settingsPageCss).toContain(".primary:not(:disabled):hover");
    expect(settingsPageCss).toContain(".danger:not(:disabled):hover");
    expect(settingsPageCss).toContain('url("assets/settings-bg.png")');
    expect(settingsPageCss).toContain(".password-toggle.is-visible");
    expect(settingsPageCss).toContain("min-height: 100vh;");
    expect(settingsPageCss).toContain("margin: auto 0 0;");
  });

  it("loads saved settings and hides Firefox-only fields outside Firefox", async () => {
    const { dom, state, hooks } = await loadSettingsPage();

    expect(state.storageGetCalls).toHaveLength(1);
    await applyStoredSettings(state, {
      ...DEFAULT_STORED_SETTINGS,
      downloadIndividually: true,
      libraryDownloadRoot: "KiCad\\easyECAD",
      samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay#frag",
      samacsysFirefoxProxyAuthorizationHeader: "Authorization: Bearer relay123",
      samacsysFirefoxUsername: " user@example.com ",
      samacsysFirefoxPassword: " secret123 ",
      rememberSamacsysCredentials: true,
      rememberSamacsysFirefoxProxyAuthorizationHeader: true
    });

    expect(hooks.elements.downloadIndividuallyEl.checked).toBe(true);
    expect(hooks.elements.libraryDownloadRootEl.value).toBe("KiCad/easyECAD");
    expect(hooks.elements.samacsysFirefoxProxyBaseUrlEl.value).toBe(
      "https://proxy.example.test/relay"
    );
    expect(hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.value).toBe("");
    expect(hooks.elements.helperSecretStatusEl.textContent).toBe(
      "Authentication token remembered on this device."
    );
    expect(hooks.elements.helperSecretStatusEl.previousElementSibling).toBe(
      hooks.elements.clearHelperSecretEl
    );
    expect(hooks.elements.samacsysFirefoxUsernameEl.value).toBe(
      "user@example.com"
    );
    expect(hooks.elements.samacsysFirefoxPasswordEl.value).toBe("");
    expect(hooks.elements.samacsysCredentialsStatusEl.textContent).toBe(
      "SamacSys password remembered on this device."
    );
    expect(hooks.elements.samacsysCredentialsStatusEl.previousElementSibling).toBe(
      hooks.elements.clearSamacsysCredentialsEl
    );
    expect(hooks.elements.firefoxAdvancedSettingsEl.hidden).toBe(true);
    expect(hooks.elements.firefoxRelaySectionEl.hidden).toBe(true);
    expect(hooks.elements.saveSettingsEl.disabled).toBe(true);
    expect(hooks.elements.discardSettingsEl.disabled).toBe(true);
    expect(hooks.elements.saveSettingsEl.textContent.trim()).toBe("Save");
    expect(hooks.elements.discardSettingsEl.textContent.trim()).toBe("Discard");
    expect(hooks.elements.discardSettingsEl.classList.contains("danger")).toBe(
      true
    );
    expect(hooks.elements.saveSettingsEl.previousElementSibling).toBe(
      hooks.elements.statusEl
    );
    expect(dom.window.document.querySelector(".footer-link")?.href).toBe(
      "https://github.com/JoeShade/Easy-ECAD-Downloader"
    );
  });

  it("shows and hides secret fields without marking settings dirty", async () => {
    const { state, hooks } = await loadSettingsPage({
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    await applyStoredSettings(state);
    hooks.elements.samacsysFirefoxPasswordEl.value = "secret123";
    hooks.elements.toggleSamacsysFirefoxPasswordEl.click();

    expect(hooks.elements.samacsysFirefoxPasswordEl.type).toBe("text");
    expect(
      hooks.elements.toggleSamacsysFirefoxPasswordEl.classList.contains(
        "is-visible"
      )
    ).toBe(true);
    expect(
      hooks.elements.toggleSamacsysFirefoxPasswordEl.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      hooks.elements.toggleSamacsysFirefoxPasswordEl.getAttribute("aria-label")
    ).toBe("Hide SamacSys password");

    hooks.elements.toggleSamacsysFirefoxPasswordEl.click();

    expect(hooks.elements.samacsysFirefoxPasswordEl.type).toBe("password");
    expect(
      hooks.elements.toggleSamacsysFirefoxPasswordEl.getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      hooks.elements.toggleSamacsysFirefoxPasswordEl.getAttribute("aria-label")
    ).toBe("Show SamacSys password");

    hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.value =
      "Bearer helper-secret";
    hooks.elements.toggleSamacsysFirefoxProxyAuthorizationHeaderEl.click();

    expect(hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.type).toBe(
      "text"
    );
    expect(
      hooks.elements.toggleSamacsysFirefoxProxyAuthorizationHeaderEl.getAttribute(
        "aria-label"
      )
    ).toBe("Hide authentication token");
    expect(hooks.elements.saveSettingsEl.disabled).toBe(true);
    expect(hooks.elements.discardSettingsEl.disabled).toBe(true);
  });

  it("saves download layout settings from the options page", async () => {
    const { dom, state, hooks } = await loadSettingsPage();

    await applyStoredSettings(state);
    hooks.elements.downloadIndividuallyEl.checked = true;
    dispatchChange(dom, hooks.elements.downloadIndividuallyEl);
    await flushAsyncWork();

    expect(state.storageSetCalls).toEqual([]);
    expect(hooks.elements.saveSettingsEl.disabled).toBe(false);
    await saveChanges(hooks);

    expect(state.storageSetCalls[0]).toEqual({
      ...DEFAULT_STORED_SETTINGS,
      downloadIndividually: true
    });

    hooks.elements.libraryDownloadRootEl.value = "  KiCad\\\\easyECAD//Parts  ";
    dispatchInput(dom, hooks.elements.libraryDownloadRootEl);
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(hooks.elements.libraryDownloadRootEl.value).toBe("KiCad/easyECAD/Parts");
    expect(state.storageSetCalls[1]).toEqual({
      ...DEFAULT_STORED_SETTINGS,
      downloadIndividually: true,
      libraryDownloadRoot: "KiCad/easyECAD/Parts"
    });
    expect(hooks.elements.statusEl.textContent).toBe("Settings saved.");
  });

  it("saves Firefox helper token and SamacSys credentials for this session by default", async () => {
    const { dom, state, hooks } = await loadSettingsPage({
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    await applyStoredSettings(state);
    expect(hooks.elements.samacsysFirefoxProxyBaseUrlEl.disabled).toBe(false);
    expect(hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.disabled).toBe(
      false
    );
    expect(hooks.elements.firefoxAdvancedSettingsEl.hidden).toBe(false);
    expect(hooks.elements.firefoxAdvancedSettingsEl.open).toBe(false);
    expect(hooks.elements.firefoxRelaySectionEl.hidden).toBe(false);

    hooks.elements.samacsysFirefoxProxyBaseUrlEl.value =
      " https://proxy.example.test/relay#frag ";
    dispatchInput(dom, hooks.elements.samacsysFirefoxProxyBaseUrlEl);
    await flushAsyncWork();
    hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.value =
      " Authorization: Bearer relay123 ";
    dispatchInput(dom, hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl);
    await flushAsyncWork();
    hooks.elements.samacsysFirefoxUsernameEl.value = "  user@example.com  ";
    dispatchInput(dom, hooks.elements.samacsysFirefoxUsernameEl);
    await flushAsyncWork();
    hooks.elements.samacsysFirefoxPasswordEl.value = "  secret123  ";
    dispatchInput(dom, hooks.elements.samacsysFirefoxPasswordEl);
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(state.storageSetCalls.at(-1)).toEqual({
      ...DEFAULT_STORED_SETTINGS,
      samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
    });
    expect(state.sessionSetCalls.at(-1)).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      samacsysFirefoxProxyAuthorizationHeader: "Bearer relay123",
      samacsysFirefoxUsername: "user@example.com",
      samacsysFirefoxPassword: "secret123"
    });
    expect(hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.value).toBe("");
    expect(hooks.elements.samacsysFirefoxPasswordEl.value).toBe("");
    expect(hooks.elements.helperSecretStatusEl.textContent).toBe(
      "Authentication token saved for this browser session."
    );
    expect(hooks.elements.samacsysCredentialsStatusEl.textContent).toBe(
      "SamacSys password saved for this browser session."
    );
  });

  it("remembers secrets on this device only when the opt-in boxes are checked", async () => {
    const { dom, state, hooks } = await loadSettingsPage({
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    await applyStoredSettings(state);
    hooks.elements.samacsysFirefoxProxyAuthorizationHeaderEl.value =
      " Authorization: Bearer relay123 ";
    hooks.elements.samacsysFirefoxUsernameEl.value = "user@example.com";
    hooks.elements.samacsysFirefoxPasswordEl.value = " secret123 ";
    hooks.elements.rememberSamacsysFirefoxProxyAuthorizationHeaderEl.checked = true;
    hooks.elements.rememberSamacsysCredentialsEl.checked = true;
    dispatchChange(
      dom,
      hooks.elements.rememberSamacsysFirefoxProxyAuthorizationHeaderEl
    );
    await flushAsyncWork();
    dispatchChange(dom, hooks.elements.rememberSamacsysCredentialsEl);
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(state.storageSetCalls.at(-1)).toEqual({
      ...DEFAULT_STORED_SETTINGS,
      samacsysFirefoxProxyAuthorizationHeader: "Bearer relay123",
      samacsysFirefoxUsername: "user@example.com",
      samacsysFirefoxPassword: "secret123",
      rememberSamacsysCredentials: true,
      rememberSamacsysFirefoxProxyAuthorizationHeader: true
    });
    expect(state.sessionSetCalls.at(-1)).toEqual(DEFAULT_SESSION_SETTINGS);
    expect(hooks.elements.helperSecretStatusEl.textContent).toBe(
      "Authentication token remembered on this device."
    );
    expect(hooks.elements.samacsysCredentialsStatusEl.textContent).toBe(
      "SamacSys password remembered on this device."
    );
  });

  it("warns and normalizes invalid setting values", async () => {
    const { dom, state, hooks } = await loadSettingsPage();

    await applyStoredSettings(state, {
      ...DEFAULT_STORED_SETTINGS,
      libraryDownloadRoot: "Projects/KiCad"
    });
    hooks.elements.libraryDownloadRootEl.value = "../outside";
    dispatchInput(dom, hooks.elements.libraryDownloadRootEl);
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(hooks.elements.libraryDownloadRootEl.value).toBe("easyECADDownloader");
    expect(hooks.elements.statusEl.textContent).toContain("inside Downloads");
    expect(hooks.elements.statusEl.classList.contains("warning")).toBe(true);
    expect(state.storageSetCalls[0]).toEqual(DEFAULT_STORED_SETTINGS);

    hooks.elements.samacsysFirefoxProxyBaseUrlEl.value = "not-a-url";
    dispatchInput(dom, hooks.elements.samacsysFirefoxProxyBaseUrlEl);
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(hooks.elements.samacsysFirefoxProxyBaseUrlEl.value).toBe("");
    expect(hooks.elements.statusEl.textContent).toContain(
      "The helper service URL must start with http:// or https://."
    );
    expect(state.storageSetCalls[1]).toEqual(DEFAULT_STORED_SETTINGS);
  });

  it("resets the library folder to the default root", async () => {
    const { state, hooks } = await loadSettingsPage();

    await applyStoredSettings(state, {
      ...DEFAULT_STORED_SETTINGS,
      libraryDownloadRoot: "Nested/Parts"
    });
    hooks.elements.resetLibraryDownloadRootEl.click();
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(hooks.elements.libraryDownloadRootEl.value).toBe("easyECADDownloader");
    expect(state.storageSetCalls[0]).toEqual(DEFAULT_STORED_SETTINGS);
  });

  it("discards unsaved changes and restores the loaded settings", async () => {
    const { dom, state, hooks } = await loadSettingsPage();

    await applyStoredSettings(state, {
      ...DEFAULT_STORED_SETTINGS,
      libraryDownloadRoot: "KiCad/Saved"
    });
    hooks.elements.libraryDownloadRootEl.value = "Changed/Folder";
    hooks.elements.downloadIndividuallyEl.checked = true;
    dispatchInput(dom, hooks.elements.libraryDownloadRootEl);
    await flushAsyncWork();

    hooks.elements.discardSettingsEl.click();
    await flushAsyncWork();

    expect(hooks.elements.libraryDownloadRootEl.value).toBe("KiCad/Saved");
    expect(hooks.elements.downloadIndividuallyEl.checked).toBe(false);
    expect(hooks.elements.statusEl.textContent).toBe("Changes discarded.");
    expect(state.storageSetCalls).toEqual([]);
    expect(hooks.elements.saveSettingsEl.disabled).toBe(true);
  });

  it("does not keep a hidden password after clearing SamacSys sign-in", async () => {
    const { dom, state, hooks } = await loadSettingsPage();

    await applyStoredSettings(state, {
      ...DEFAULT_STORED_SETTINGS,
      samacsysFirefoxUsername: "saved@example.com",
      samacsysFirefoxPassword: "stored-password",
      rememberSamacsysCredentials: true
    });
    hooks.elements.clearSamacsysCredentialsEl.click();
    hooks.elements.samacsysFirefoxUsernameEl.value = "new@example.com";
    dispatchInput(dom, hooks.elements.samacsysFirefoxUsernameEl);
    await flushAsyncWork();
    await saveChanges(hooks);

    expect(state.storageSetCalls.at(-1)).toEqual({
      ...DEFAULT_STORED_SETTINGS,
      samacsysFirefoxUsername: "new@example.com",
      rememberSamacsysCredentials: true
    });
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
