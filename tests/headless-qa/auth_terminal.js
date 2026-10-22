/*
 * Open a dedicated user-owned credential console before matrix execution.
 * The console has its own keyboard/output handles; the parent receives only
 * completion status; entered values stay in the user-owned console.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "./common.js";

// A private control pipe carries cancellation and parent exit to PowerShell.
// Only the console's successful exit releases the caller's startup gate.
export function openCredentialTerminal({ timeout = 900000, spawnProcess = spawn } = {}) {
  if (process.platform !== "win32" || !process.env.SystemRoot) {
    throw new Error("The QA credential terminal requires Windows");
  }
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE"].some(key => process.env[key])) {
    throw new Error("Disable Node/Puppeteer debug tracing before entering SamacSys credentials");
  }
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const child = spawnProcess(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(import.meta.dirname, "auth_terminal.ps1"), "-NodePath", process.execPath,
      "-AuthScript", path.join(import.meta.dirname, "auth.js"), "-WorkingDirectory", repoRoot],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let failure = null, killTimer;
    const stop = message => {
      failure ||= new Error(message);
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end("stop\n");
      killTimer ||= setTimeout(() => child.kill(), 5000);
    };
    const interrupt = () => stop("QA credential setup cancelled; matrix startup must stop");
    const timer = setTimeout(() => stop("QA credential terminal timed out; matrix startup must stop"), timeout);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, interrupt);
    // The visible console owns its input/output handles. Drain the helper's
    // separate streams so the parent retains completion status alone.
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => { failure ||= new Error("QA credential terminal control channel closed"); });
    child.on("error", () => { failure ||= new Error("QA credential terminal could not be opened"); });
    child.on("close", code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, interrupt);
      if (failure || code !== 0) {
        reject(failure || new Error("QA credential entry was cancelled or failed; matrix startup must stop"));
      } else resolve();
    });
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
