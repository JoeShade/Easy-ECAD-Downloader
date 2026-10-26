# Current Deviations from `systemDesign.md`

## Direct SamacSys redirect destinations

Expected: The destination rule in systemDesign.md section 5.4 confines upstream requests to approved HTTPS SamacSys hosts.

Observed: Direct Chrome fetches validate the initial URL and then use native automatic redirects. Metadata validates the final URL; preview and ZIP fetches can consume an out-of-allowlist redirected response. The user-managed relay example validates each upstream hop. Browser credential stripping applies to direct redirects; cross-origin credential disclosure has not been demonstrated.

Closure: Verify browser-compatible redirect enforcement for entry, preview and ZIP flows, with regressions covering each hop and successful provider redirects. This remains an open implementation mismatch, with no approved exception.
