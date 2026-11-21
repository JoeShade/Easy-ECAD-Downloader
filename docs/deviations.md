# Current Deviations from `systemDesign.md`

## Direct SamacSys redirect destinations

Expected: The destination rule in systemDesign.md section 5.4 confines upstream requests to approved HTTPS SamacSys hosts.

Observed: Direct Chrome fetches validate the requested URL and the final response URL before using metadata, previews or ZIP bytes. Chrome follows intermediate redirects before exposing the response to the extension, so an intermediate request may still reach another host. The user-managed relay validates each upstream hop.

Closure: Verify browser-compatible redirect enforcement for entry, preview and ZIP flows, with regressions covering each hop and successful provider redirects. This remains an open implementation mismatch, with no approved exception.
