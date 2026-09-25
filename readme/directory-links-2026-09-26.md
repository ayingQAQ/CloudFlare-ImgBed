# Opaque dashboard directory links

Dashboard navigation now uses `?d=d_<sha256>` instead of exposing the folder
path in `?dir=`. The authenticated `/api/manage/directoryLink` endpoint stores
the mapping under `manage@directory-link@` in shared metadata. It uses direct
key reads/writes, never list operations. These IDs are navigation identifiers,
not access credentials; admin authentication is still required.

Legacy directory URLs are replaced in browser history after resolution. Root
navigation removes both parameters. Refresh, back/forward and opening bookmarks
on another browser/backend use the same persistent mapping. A bounded 200-entry
memory cache avoids repeated registration during navigation. File-list requests
also encode directory paths, preserving literal plus signs and ampersands.

No stored file/object names, image bytes, file URLs or existing folder records
are changed. Source changes are in the sibling Sanyue-ImgHub frontend repository;
the production bundle and source maps are included here.

Validation: 20 frontend tests; 140 backend tests; production browser navigation
with synthetic directory responses (legacy conversion, parent, back, reload,
special characters, no page errors); authenticated mapping round-trip across
imgb.top, www.imgb.top and origin-vps.imgb.top; unauthenticated requests return
401 on all three. Temporary test mappings and session were removed.

VPS image: `cloudflare-imgbed:directory-links-20260926`.
Previous compose: `/opt/cloudflare-imgbed/compose.yaml.before-directory-links-20260926`.
The additive mapping records can remain when rolling back; older code ignores them.
