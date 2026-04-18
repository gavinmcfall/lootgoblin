# MakerWorld adapter — API discovery notes

Discovered 2026-04-18 via an authenticated browser session. Session cookies
were copied into the adapter test fixtures as an empty jar — real
credentials are not committed.

## Core concepts

- A **Design** is a model. Each design has a numeric `id` (e.g. `2663598`) and a `slug`
  ("sveins-zip-1-zipper-flap-bag"). The canonical page URL is
  `https://makerworld.com/en/models/<designId>-<slug>`.
- A design has multiple **instances** (what Bambu calls "print profiles"). Each
  instance has its own numeric `id` (e.g. `2946891`) and `profileId`. The design's
  `defaultInstanceId` points at the primary instance. A URL fragment
  `#profileId-<id>` deep-links a specific instance.
- Files are downloaded **per instance**, not per design. Each instance resolves to a
  single `.3mf` file (3MF bundles meshes + print settings in one zip).

## Endpoints

| Purpose | Method + URL | Auth | Notes |
|---------|--------------|------|-------|
| Design metadata | `GET /api/v1/design-service/design/{designId}` | cookie | Returns the full design object — same shape as `props.pageProps.design` in the page's `__NEXT_DATA__`. See `tests/fixtures/makerworld/endpoints-reference.json`. |
| Instance download (3MF) | `GET /api/v1/design-service/instance/{instanceId}/f3mf` | cookie | Returns `{ name: string, url: string }`. `url` is a **signed CDN URL** with ~5 min expiry (`exp` query param). Query params: `at`, `exp`, `key`, `uid`. |
| Instance 3MF (preview variant) | `GET /api/v1/design-service/instance/{instanceId}/f3mf?type=preview` | cookie | Same response as above; `?type=` parameter does not affect the returned file for a given instance. We pass no `type`. |
| File download | `GET <signed URL>` | anonymous (URL is pre-signed) | The CDN does not require cookies. Host: `makerworld.bblmw.com`. |

## Extracted metadata fields (from `design` response)

```
id                    number (designId)
slug                  string
title                 string (often localized; prefer titleTranslated if present)
titleTranslated       string | null
summary               string (description)
summaryTranslated     string | null
coverUrl              string (URL to cover image)
tags                  string[]
tagsOriginal          string[] | undefined
categories            Array<{id, name, parentId?}>
license               string (e.g. "standard", CC-BY names)
designCreator         {uid, name, handle, avatar, ...}
createTime            ISO timestamp
updateTime            ISO timestamp
nsfw                  boolean
instances             Array<Instance> — see below
defaultInstanceId     number
modelId               string (bambu internal id, rarely needed)
```

## Extracted instance fields

```
id                    number (instanceId — used for f3mf endpoint)
profileId             number
title                 string
summary               string
cover                 string (URL)
pictures              Array<{url, id, orderNumber?}>
isDefault             boolean
needAms               boolean
hasZipStl             boolean (if true, raw STL zip may exist — endpoint not yet found)
materialCnt           number
extention             object (print settings)
createTime            ISO timestamp
```

## Raw STL zip download — unresolved

Instances report `hasZipStl: true` but no API endpoint for the raw-STL zip was
located during the 2026-04-18 discovery pass. Candidates tried (all 404 on the
test instance):

```
/api/v1/design-service/instance/{id}/stl
/api/v1/design-service/instance/{id}/zip-stl
/api/v1/design-service/instance/{id}/zipstl
/api/v1/design-service/instance/{id}/raw
/api/v1/design-service/instance/{id}/raw-stl
/api/v1/design-service/instance/{id}/zip
```

**v1 decision:** download the 3MF only. 3MF bundles the meshes (as STL-equivalent
binary parts inside the zip) plus Bambu Studio print settings — Manyfold's
`datapackage.json` can reference the 3MF as the primary resource. Raw-STL
extraction can be a post-v1 pipeline step (unzip 3MF client-side, expose the
loose STLs) if the Manyfold UI needs them separately.

## Required request headers

- `User-Agent`: anything plausible — MakerWorld does not appear to gate on UA.
- `Referer: https://makerworld.com/`
- `Cookie`: the user's full `.makerworld.com` cookie jar (specifically `bblauth`,
  `b-user-id`, `_ga*`, and whatever else the session uses — pass them all).

## Rate-limit observations

- No 429s or throttles observed across ~20 probing requests in quick succession.
- Conservative default for the site-config: **1 req / 2s**, matching the spec.

## Error classification

Responses observed during discovery:

- `200 + JSON` → success.
- `404 + {}` → unknown path / instance not found. Non-retryable.
- `401` (expected for missing auth, not directly observed in logged-in session) → non-retryable; mark credential expired.
- `403` (expected for gated content, e.g. paid-only models) → non-retryable; surface license-denied.
- `429` (expected but not observed) → retryable; honor `Retry-After`.
- `5xx` (not observed) → retryable transient error.

## Fixtures

- `tests/fixtures/makerworld/design-2663598-full.json` — full design object as returned by `/api/v1/design-service/design/2663598` (also present in `__NEXT_DATA__`).
- `tests/fixtures/makerworld/endpoints-reference.json` — full responses from both the design and f3mf endpoints as captured on 2026-04-18. Signed URLs inside have expired (5 min TTL) but are kept verbatim so the adapter tests can replay them structurally.

When writing integration tests in B-3, replay these via `msw` handlers. The
signed CDN URL is replaced with an `http://cdn/...` test host by the handler.
