# Firefox SamacSys Reverse Proxy

This document provides a minimal reverse proxy framework for the Firefox SamacSys proxy included in the extension, this is needed for SamacSys use in firefox.

This is an experimental feature and the maintainers take no responsibility for this feature, the extension does not host or operate this proxy

## Reverse Proxy Logic

The extension sends a `POST` request to the proxy. The proxy request includes a `Authorization` header to authorise the request with the proxy using a bearer token, while the JSON payload includes the SamacSys headers and body separately:

Configure the final HTTPS relay endpoint directly. The extension rejects relay HTTP redirects because replaying the JSON body would forward upstream credentials. The worker's own approved SamacSys redirect handling is separate from this outer transport.

SamacSys Body and Headers:
```json
{
  "url": "https://ms.componentsearchengine.com/entry_u_newDesign.php?...",
  "method": "GET",
  "headers": {
    "Accept": "text/html",
    "Cookie": "PHPSESSID=example-session; partner=mouser",
    "Authorization": "Basic ..."
  },
  "credentials": "include",
  "bodyText": null,
  "bodyBase64": null
}
```

The Reverse Proxy request headers look like:

```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer YOUR_RELAY_TOKEN"
}
```

a combined post request to the proxy would look something like this

```json
{
  "url": "https://your-worker.your-subdomain.workers.dev",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer YOUR_RELAY_TOKEN"
  },
  "body": {
    "url": "https://ms.componentsearchengine.com/entry_u_newDesign.php?...",
    "method": "GET",
    "headers": {
      "Accept": "text/html",
      "Cookie": "PHPSESSID=example-session; partner=mouser",
      "Authorization": "Basic SAMACSYS_AUTH_VALUE"
    },
    "bodyText": null,
    "bodyBase64": null
  }
}
```


The Proxy:

This proxy first authenticates the caller by validating the incoming Authorization header against the configured proxy token.

After authentication, it performs the SamacSys / Component Search Engine request server-side. It forwards the supplied upstream Cookie and Authorization headers to SamacSys, then returns the upstream response body and HTTP status code unchanged.

The response is then edited to include permissive CORS headers so the browser extension can access it. It also includes an x-upstream-url header, allowing the extension to see the final upstream URL after any redirects.

## Below is a minimal cloudflare worker implementation  

```js
// Relay authenticated requests to approved SamacSys HTTPS destinations, checking
// each redirect before sending origin-bound credentials to the next server.
const ALLOWED_HOST_PATTERN = /(^|\.)componentsearchengine\.com$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

const BLOCKED_FORWARD_HEADERS = new Set([
  "host",
  "content-length"
]);

function withCors(headers = new Headers()) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return headers;
}

function textResponse(body, status) {
  return new Response(body, {
    status,
    headers: withCors()
  });
}

function isAuthorized(request, env) {
  const token = String(env.RELAY_BEARER_TOKEN || "").trim();

  if (!token) {
    return false;
  }

  return request.headers.get("Authorization") === `Bearer ${token}`;
}

function validateTargetUrl(url) {
  let parsedUrl;

  try {
    parsedUrl = new URL(String(url || ""));
  } catch {
    throw new Error("Invalid upstream URL.");
  }

  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password ||
      parsedUrl.port || !ALLOWED_HOST_PATTERN.test(parsedUrl.hostname)) {
    throw new Error("Upstream URL must use HTTPS on componentsearchengine.com.");
  }

  return parsedUrl.toString();
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function buildForwardHeaders(headers = {}) {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;

    const normalizedKey = key.toLowerCase();

    if (
      BLOCKED_FORWARD_HEADERS.has(normalizedKey) ||
      normalizedKey.startsWith("cf-")
    ) {
      continue;
    }

    result.set(key, String(value));
  }

  return result;
}

function buildUpstreamRequest(payload) {
  const requestInit = {
    method: payload.method || "GET",
    headers: buildForwardHeaders(payload.headers)
  };

  if (payload.bodyText !== null && payload.bodyText !== undefined) {
    requestInit.body = payload.bodyText;
  } else if (payload.bodyBase64) {
    requestInit.body = decodeBase64(payload.bodyBase64);
  }

  return requestInit;
}

// Fetch redirects manually so every hop satisfies the same destination rule.
// Origin changes clear credentials; Fetch's POST/303 rules govern body replay.
async function fetchAllowedUpstream(url, init) {
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    const location = response.headers.get("Location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return { response, url };
    }
    await response.body?.cancel();
    if (redirects >= 10) throw new Error("Too many upstream redirects.");
    const nextUrl = validateTargetUrl(new URL(location, url).href);
    const headers = new Headers(init.headers);
    if (new URL(nextUrl).origin !== new URL(url).origin) {
      headers.delete("Cookie");
      headers.delete("Authorization");
    }
    const method = String(init.method || "GET").toUpperCase();
    const becomesGet = (response.status === 303 && !["GET", "HEAD"].includes(method)) ||
      ([301, 302].includes(response.status) && method === "POST");
    if (becomesGet) {
      init = { ...init, method: "GET", body: undefined };
      for (const name of ["Content-Type", "Content-Encoding", "Content-Language", "Content-Location"]) {
        headers.delete(name);
      }
    }
    init = { ...init, headers };
    url = nextUrl;
  }
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: withCors()
    });
  }

  if (request.method !== "POST") {
    return textResponse("Method not allowed.", 405);
  }

  if (!isAuthorized(request, env)) {
    return textResponse("Unauthorized.", 401);
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return textResponse("Invalid JSON payload.", 400);
  }

  let upstreamUrl;

  try {
    upstreamUrl = validateTargetUrl(payload.url);
  } catch (error) {
    return textResponse(error.message || "Bad upstream URL.", 400);
  }

  let upstreamResponse;

  try {
    const result = await fetchAllowedUpstream(upstreamUrl, buildUpstreamRequest(payload));
    upstreamResponse = result.response;
    upstreamUrl = result.url;
  } catch (error) {
    return textResponse(
      `Upstream fetch failed: ${error.message || "network error"}`,
      502
    );
  }

  const responseHeaders = withCors(new Headers(upstreamResponse.headers));
  responseHeaders.set("x-upstream-url", upstreamResponse.url || upstreamUrl);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}

export default {
  fetch: handleRequest
};
```

## Deploy quickly

1. Go to [Cloudflare Workers](https://workers.cloudflare.com/).
2. Create a new Worker.
3. Replace the default Worker code with the proxy script above.
4. Add a Worker secret named:
   `RELAY_BEARER_TOKEN`
   Set its value to a long random token, for example:
   `a-long-random-private-token`
   Do not include `Bearer` in the secret value. The Worker code adds/checks the `Bearer` prefix itself.
5. Deploy the Worker.
6. Copy the Worker URL, for example:
   `https://your-samacsys-proxy.your-subdomain.workers.dev`
7. In the extension settings, open `Advanced Firefox settings`.
8. Paste the Worker URL into:

   `Firefox SamacSys proxy URL`
9. Paste `Bearer ` followed by the same token into:

   `Authentication token`

   For example, `Bearer a-long-random-private-token` matches the raw secret stored in `RELAY_BEARER_TOKEN`.
10. Leave `Remember helper password/token on this device` unticked unless you accept the local-storage risk.
11. Reload the target Mouser, Farnell, element14, or Newark page.
12. Test previews in Firefox first.
13. If previews work, try ZIP export.

## Notes

- The proxy permits HTTPS on `componentsearchengine.com` and its subdomains at the standard port. Every redirect is validated, and origin changes clear forwarded cookies and authorization.
- The current extension relay contract expects the proxy to expose the final upstream URL through `x-upstream-url`.
- The extension sends proxy auth separately in the proxy request `Authorization` header.
- The extension also forwards an explicit upstream SamacSys `Authorization` header in `headers.Authorization`, sourced from locally generated Basic auth.
