/*
 * Exercise the deployable Worker example from the relay guide with mocked
 * upstream fetches. URL, redirect and credential boundaries stay covered in
 * the same code readers copy into their own Cloudflare Worker.
 */
// @vitest-environment node

import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { normalizeNewlines, readRepoFile } from "./helpers/test_harness.js";

function loadRelay(fetchImpl) {
  const guide = normalizeNewlines(readRepoFile("docs/firefox-samacsys-proxy.md"));
  const source = guide.match(/```js\n([\s\S]*?)```/)[1];
  const context = vm.createContext({ Headers, Request, Response, URL, Uint8Array,
    atob, fetch: fetchImpl });
  new vm.Script(source.replace("export default", "globalThis.worker =")).runInContext(context);
  return context.worker;
}

function relayRequest(url) {
  return new Request("https://relay.example.test/", {
    method: "POST", headers: { Authorization: "Bearer placeholder" },
    body: JSON.stringify({ url, method: "POST", bodyText: "partID=1",
      headers: { Cookie: "session=placeholder", Authorization: "Basic placeholder",
        "Content-Type": "application/x-www-form-urlencoded" } })
  });
}

describe("deployable relay example", () => {
  it.each(["http://ms.componentsearchengine.com/entry.php",
    "https://ms.componentsearchengine.com:8443/entry.php"])("rejects unsafe transport: %s", async url => {
    const fetchImpl = vi.fn(async () => new Response("upstream"));
    const response = await loadRelay(fetchImpl).fetch(relayRequest(url), { RELAY_BEARER_TOKEN: "placeholder" });
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates redirect destinations before requesting another host", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302, headers: { Location: "https://other.example.test/" }
    }));
    const response = await loadRelay(fetchImpl).fetch(
      relayRequest("https://ms.componentsearchengine.com/entry.php"), { RELAY_BEARER_TOKEN: "placeholder" });
    expect(response.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
  });

  it("drops origin-bound credentials and rewrites POST on a 302", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302,
        headers: { Location: "https://componentsearchengine.com/part.php" } }))
      .mockResolvedValueOnce(new Response("part"));
    const response = await loadRelay(fetchImpl).fetch(
      relayRequest("https://ms.componentsearchengine.com/entry.php"), { RELAY_BEARER_TOKEN: "placeholder" });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const next = fetchImpl.mock.calls[1][1];
    expect(next.headers.get("Cookie")).toBeNull();
    expect(next.headers.get("Authorization")).toBeNull();
    expect(next.method).toBe("GET");
    expect(next.body).toBeUndefined();
    expect(next.headers.get("Content-Type")).toBeNull();
    expect(response.headers.get("x-upstream-url")).toBe("https://componentsearchengine.com/part.php");
  });

  it("preserves the request through a same-origin 307 and bounds redirect loops", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 307, headers: { Location: "/again" }
    }));
    const response = await loadRelay(fetchImpl).fetch(
      relayRequest("https://ms.componentsearchengine.com/entry.php"), { RELAY_BEARER_TOKEN: "placeholder" });
    expect(response.status).toBe(502);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(11);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    const next = fetchImpl.mock.calls[1][1];
    expect(next.method).toBe("POST");
    expect(next.body).toBe("partID=1");
    expect(next.headers.get("Cookie")).toBe("session=placeholder");
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
