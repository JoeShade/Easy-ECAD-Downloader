/*
 * Share SamacSys credentials across QA processes using encrypted volatile
 * Windows registry keys. Private pipes carry values, and the PowerShell helper
 * owns encryption, volatile-key creation and serialized registry access.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { repoRoot } from "./common.js";

// Spawn the system PowerShell helper with public action/scope arguments. Bound
// its runtime and response size; private response text stays inside this call.
function invokeCache(action, scope, credentials) {
  if (process.platform !== "win32") throw new Error("Reusable SamacSys credentials require Windows");
  if (!process.env.SystemRoot) throw new Error("Windows SystemRoot is unavailable");
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(import.meta.dirname, "credential_cache.ps1"), "-Action", action, "-Scope", scope],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => {
      if (output.length + data.length > 65536) { failed = true; child.kill(); }
      else output += data;
    });
    // Read responses contain private values; only parsed results reach the caller.
    child.stderr.resume();
    child.stdin.on("error", () => { failed = true; });
    child.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0) { output = ""; reject(new Error("Windows memory-only SamacSys cache is unavailable")); return; }
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error("Windows SamacSys cache returned an invalid response")); }
      finally { output = ""; }
    });
    child.stdin.end(credentials ? JSON.stringify(credentials) : "");
  });
}

// Derive one stable checkout identity on Windows' case-insensitive filesystem;
// tests can supply a separate validated hash to isolate their registry records.
export function windowsCredentialCache(scope = createHash("sha256").update(repoRoot.toLowerCase()).digest("hex")) {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("Invalid Windows credential cache scope");
  return {
    async read() {
      const value = await invokeCache("Read", scope);
      if (value === null) return null;
      if (!value || typeof value.username !== "string" || typeof value.password !== "string") {
        throw new Error("Invalid Windows SamacSys cache; clear it with npm run qa:auth -- --clear");
      }
      return { username: value.username, password: value.password };
    },
    async write(credentials) { await invokeCache("Write", scope, credentials); },
    async clear() { await invokeCache("Clear", scope); }
  };
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
