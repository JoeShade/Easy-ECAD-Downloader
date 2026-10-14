/*
 * Visible terminal input and memory-only SamacSys provisioning for QA runs.
 * No credentials are accepted through arguments, environment, or files.
 */
import { clearLine, cursorTo, emitKeypressEvents } from "node:readline";
import { protectSecrets, redact } from "./common.js";
import { windowsCredentialCache } from "./credential_cache.js";

export function readTerminalLine(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("SamacSys login requires an interactive terminal; redirected input is not accepted");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const prompt = `${label}: `;
    const redraw = () => { cursorTo(output, 0); clearLine(output, 0); output.write(prompt + value); };
    const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
    const finish = error => {
      input.off("keypress", keypress);
      input.off("end", ended);
      input.off("error", failed);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      output.write("\n");
      const result = value;
      value = "";
      if (error) reject(error); else resolve(result);
    };
    const ended = () => finish(new Error("Terminal closed before SamacSys login completed"));
    const failed = () => finish(new Error("Terminal input failed"));
    const keypress = (text, key = {}) => {
      if ((key.ctrl && ["c", "d"].includes(key.name)) || key.name === "escape") {
        finish(new Error("SamacSys login cancelled"));
      } else if (["return", "enter"].includes(key.name)) {
        finish();
      } else if (key.name === "backspace") {
        value = [...value].slice(0, -1).join("");
        redraw();
      } else if (key.ctrl && key.name === "u") {
        value = "";
        redraw();
      } else if (text && !key.ctrl && !key.meta && ![...text].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) {
        if (value.length + text.length > 4096) finish(new Error("SamacSys input is too long"));
        else { value += text; output.write(text); }
      }
    };
    emitKeypressEvents(input);
    input.on("keypress", keypress);
    input.once("end", ended);
    input.once("error", failed);
    input.setRawMode(true);
    output.write(prompt);
    input.resume();
  });
}

export async function withSamacsysCredentials(enabled, action, io, cache = windowsCredentialCache()) {
  if (!enabled) return action(null);
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE"].some(key => process.env[key])) {
    throw new Error("Disable Node/Puppeteer debug tracing before entering SamacSys credentials");
  }
  let credentials = { username: "", password: "" };
  let release = () => {};
  try {
    const cached = await cache.read();
    if (cached) credentials = cached;
    else {
      credentials.username = (await readTerminalLine("SamacSys username", io)).trim();
      credentials.password = (await readTerminalLine("SamacSys password", io)).trim();
    }
    if (!credentials.username || !credentials.password || credentials.username.includes(":")) {
      throw new Error("Supply a nonempty SamacSys username (without a colon) and password");
    }
    release = protectSecrets([credentials.username, credentials.password,
      Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")]);
    if (!cached) await cache.write(credentials);
    (io?.output || process.stdout).write(cached ? "Reusing SamacSys credentials from the Windows memory cache.\n" :
      "SamacSys credentials cached in memory for reuse until Windows restarts.\n");
    return await action(credentials);
  } catch (error) {
    // Sanitize before removing exact-value protection, including launch errors.
    // eslint-disable-next-line preserve-caught-error -- The original cause can contain unredacted credentials.
    throw new Error(redact(error.message));
  } finally {
    credentials.username = "";
    credentials.password = "";
    release();
  }
}

export async function provisionSamacsysCredentials(worker, credentials) {
  if (!credentials) return { mode: "unauthenticated", configured: false };
  return worker.evaluate(async ({ username, password }) => {
    const keys = ["samacsysFirefoxUsername", "samacsysFirefoxPassword"];
    await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ rememberSamacsysCredentials: false });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.set({ samacsysFirefoxUsername: username, samacsysFirefoxPassword: password });
    const session = await chrome.storage.session.get(keys);
    const local = await chrome.storage.local.get(keys);
    if (session.samacsysFirefoxUsername !== username || session.samacsysFirefoxPassword !== password ||
        keys.some(key => Object.hasOwn(local, key))) throw new Error("Session-only SamacSys provisioning failed");
    return { mode: "samacsys-session", configured: true, persisted: false };
  }, credentials);
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
