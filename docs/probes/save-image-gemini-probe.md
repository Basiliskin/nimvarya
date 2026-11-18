# saveImage — Gemini image read-route probe

All page values below are raw `evaluatePage` returns from the sandbox tab (id 1799329258) on a real
Gemini conversation with one generated image. Only lengths, sizes and timings were returned — never
image bytes.

## Date

2026-11-18. Signed-in Chrome, rebuilt nimvarya extension, relay, and a fresh Claude Code MCP session.
Conversation: `https://gemini.google.com/app/0a0bbd749434f8d8`.

## Selector

`generated-image single-image img.image` matches 2 elements: two copies of the same generated image, one
for each `src` scheme below. `generated-image single-image img.image[src^="blob:"]` picks the `blob:`
copy (1 match).

## Src scheme

| copy | scheme | origin | src tail |
|---|---|---|---|
| 1 | `https:` | `https://lh3.googleusercontent.com` | `…=s1024-rw` (a server-side size suffix) |
| 2 | `blob:` | `https://gemini.google.com` | `blob:https://gemini.google.com/5b1def9f-…` |

`crossOrigin` is `null` on both copies. The page itself loads the image with its own `fetch`, using
`…=s1024-rw?alr=yes` (Resource Timing `initiatorType: "fetch"`, `decodedBodySize` 101620). It then
displays the result through the `blob:` URL, which it revokes afterwards: see Fetch route.

## Loaded in unfocused tab

Read with the sandbox tab in the background: `document.visibilityState: "hidden"` and
`document.hasFocus(): false`.

| copy | complete | naturalWidth × naturalHeight | CSS size (clientWidth × clientHeight) |
|---|---|---|---|
| https | true | 1024 × 559 px | 708 × 386 px |
| blob | true | 1024 × 559 px | 708 × 386 px |

The image is loaded and decoded in the unfocused tab. An earlier read taken while the tab was focused
(`visibilityState: "visible"`) gave the same 1024 × 559 values.

## Fetch route

`fetch(currentSrc)` then `.blob()`, in the unfocused tab:

| copy | credentials | result | time |
|---|---|---|---|
| https | `same-origin` | `TypeError: Failed to fetch` (CORS) | 327 ms |
| https | `include` | `TypeError: Failed to fetch` (CORS) | 227 ms |
| blob | `same-origin` | `TypeError: Failed to fetch` (blob URL revoked) | 2 ms |
| blob | `include` | `TypeError: Failed to fetch` (blob URL revoked) | 2 ms |

An XHR to the `blob:` URL also fails (`xhr error`), but a new `Image()` on the same URL still decodes
it (1024 × 559) from the image cache. So the generic in-page fetch route **fails** on Gemini: ok=false,
no blob.size.

Site-specific route, for the record only: Gemini's own `?alr=yes` chain. It has three hops, each
fetched with `credentials: "include"` (`lh3.googleusercontent.com` → plain-text signed URL on
`lh3.google.com` → plain-text signed URL → image). In the unfocused tab it returns:

- `=s0`: ok, blob.size 213540 bytes, blob.type `image/jpeg`, magic `ff d8 ff e0`, decoded 1408 × 768 px,
  fetch 649 ms, FileReader base64 2 ms.
- `=s1024-rw`: ok, blob.size 101620 bytes, blob.type `image/webp`, magic `52 49 46 46`, 1024 × 559 px,
  fetch 464 ms, base64 1 ms.

The same chain without `credentials: "include"` fails at the third hop with `Failed to fetch`. This route
depends on Gemini's URL scheme, so it cannot be the generic reader's route.

## Canvas route

`drawImage(img)` onto a `naturalWidth × naturalHeight` canvas, then `toBlob('image/png')`:

- https copy: `SecurityError: Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may
  not be exported.`
- blob copy (same origin, not tainted): ok, size 1213324 bytes, type `image/png`, 48 ms. These are
  re-encoded pixels at the displayed 1024 × 559 size, not the original file bytes.

## Real image size

- Displayed resource (`=s1024-rw`): blob.size 101620 bytes, base64 length 135496, 1024 × 559 px (CSS
  708 × 386 px), `image/webp`.
- Full resolution (`=s0`): blob.size 213540 bytes, base64 length 284720, 1408 × 768 px, `image/jpeg`.
- Both base64 lengths are well under 1,000,000 characters, so a real-size return fits the existing
  `evaluatePage` cap and the 25 MB in-page cap (decisions.md, horizon 18).

## Large-return timing

The roundtrip was measured with a scratch controller client outside the repo. It sends `evaluatePage`
through the relay → extension → CDP `Runtime.evaluate` `returnByValue` path, with code
`'x'.repeat(n)` that takes almost no time to run, so the time measured is mostly transfer. The tab was
unfocused. No probe code was added to the repo.

| return length (chars) | round trip | under the 15000 ms CDP cap? |
|---|---|---|
| 10 | 24 ms | yes |
| 284720 (real full-res base64 length) | 25 ms, then 10 ms | yes |
| 900000 | 55 ms, then 46 ms | yes |

The real image's base64 (284720 chars) is under 1 MB, so this probe tested the real-size transfer
directly. A multi-MB image, up to ~33 MB of base64 at the 25 MB cap, is still untested until the live
phase. There, a timeout surfaces as the `guard()`-mapped `{ error }` outcome.

## Fallback the reader should use

The generic `fetch(currentSrc)` fails on both copies, so the reader needs a CDP route that does not
depend on page CORS. `Page.getResourceContent({frameId, url: currentSrc})`, on the per-command debugger
session, returns the bytes the frame already loaded for the `<img>` (for Gemini, the 101620-byte
displayed webp), base64 encoded. The probe did not run it, because it cannot be reached through
`evaluatePage`. If it returns nothing for a fetch-initiated or revoked `blob:` resource, the next
choice is a same-origin canvas `toBlob` on the `blob:` copy, which re-encodes and is not
original-resolution. Gemini's original 1408 × 768 file is only reachable through its site-specific
credentialed `?alr=yes` chain. Whether `saveImage` should promise "full resolution" or "the bytes the
page displays" is a contract decision for REPLAN.

VERDICT: REPLAN Page.getResourceContent — fetch(currentSrc) fails on Gemini (https lh3 copy blocked by CORS, blob: copy revoked), and the https canvas is tainted; read the img's loaded resource via CDP Page.getResourceContent instead
