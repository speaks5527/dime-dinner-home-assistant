# Changelog

## 1.3.0

**Two-way compatibility with ReciMe.** A compatibility bridge, not an official ReciMe integration:
Dime Dinner is independent and unaffiliated, nothing syncs automatically, and no ReciMe account is
used or asked for.

### ReciMe into Dime Dinner

- Public **ReciMe share links** are accepted by the existing URL importer, which recognises
  `recime.app`, `recime.io` and `recimeapp.com` (and their subdomains) without being fooled by a
  lookalike host. Standard schema.org Recipe data is read first; where a share page publishes none,
  a ReciMe-shaped fallback reads the page's own embedded state, and failing that its rendered
  Ingredients/Method headings. Title, image, author, servings, prep/cook/total time, ingredients and
  instructions are taken only when genuinely present — nothing is invented.
- A link that is **not a public share** is refused and said so: a sign-in wall, a private or revoked
  link, and a deleted one each get their own message. No login is attempted and no paywall is worked
  around. A ReciMe link is never answered with a demo recipe.
- **PDFs exported from ReciMe** are recognised on sight, from the document metadata or, when a
  print-to-PDF step stripped it, from the export's own footer. A recognised export is read as one
  recipe however many pages it runs to, instead of one recipe per page, and goes through the same
  local text extraction and Tesseract OCR review flow as any other PDF.
- New **Importing from ReciMe** help panel on the Recipes page, and a note in the PDF import dialog.

### Dime Dinner into ReciMe

- New **Send to ReciMe** menu on the recipe and cooking screens, with three ways out:
  - **Copy for ReciMe** — plain text in the layout ReciMe reads back correctly: title, servings,
    times, one ingredient per line under `Ingredients`, one numbered instruction per line under
    `Instructions`, notes, and the original source. Deterministic to the byte.
  - **Export PDF for ReciMe** — a clean single-recipe PDF, generated entirely inside the add-on,
    with document title/author metadata marking it as a user export from this app and a clickable
    link back to the original source.
  - **Share to ReciMe** — the native share sheet with the PDF attached, so an iOS user can pick
    ReciMe directly. Capability is measured with `navigator.canShare({ files })` rather than
    assumed, and every environment that cannot share falls back to copy-the-text plus download.
- One recipe per export, always. There is no way to bundle several into one file.
- Source URLs are sanitised before they leave: session and token parameters are stripped, and a
  Home Assistant ingress URL, a private-network address or a link carrying credentials is dropped
  entirely rather than published. Nothing about the plan, the grocery list, the pantry or the
  Kroger connection appears in an export.

## 1.2.0

**Import recipes from a PDF or ebook, including scanned ones.** The existing single-page URL
importer is unchanged and still separate.

- New **Import PDF or ebook** flow on the Recipes page. Upload a PDF from your device, or paste a
  link — a direct PDF, a Dropbox share, or a landing page carrying a download link.
- Dropbox `?dl=0` share links are rewritten to their direct download form, keeping the durable
  `rlkey` and dropping the short-lived `st` signature rather than depending on the preview page's
  CDN URL, which expires within minutes. Google Drive viewer links are rewritten too.
- For a landing page, the PDF links on it are ranked and the winner is named on screen, with the
  runners-up listed, so you can see which file is being read before it is read.
- Text is taken from the PDF's own text layer with `pdftotext`. When that layer is missing or too
  thin to be the real content — as it is for a cookbook exported as flattened page images — every
  page is rendered at 165 DPI and recognised with **Tesseract**, locally. No cloud OCR, no
  credentials, nothing leaves your network. The add-on image now installs `poppler-utils`,
  `tesseract-ocr` and `tesseract-ocr-data-eng`.
- The work runs in the background with live progress (resolving, downloading, page count,
  recognising page N of M, detecting) and a **Cancel** button. The HTTP request never blocks.
- Multiple recipes are detected across the book and shown on a **review screen** before anything is
  saved: title, source page, ingredients, method, a confidence score and any warnings, all editable.
  Pages that are a table of contents, a meal plan or a tips spread are excluded and counted.
  Nothing is invented — an unreadable title stays empty, says so, and is not pre-selected.
- Only the recipes you tick are saved, and only after an explicit confirmation. Each keeps its
  source book title, author and page for attribution, with no-affiliation wording on screen.
- Page previews during review are held in memory and die with the job. No page image is ever stored
  with a saved recipe.
- Limits sized for a Home Assistant host: 25 MB, 60 pages, two pages recognised at a time, per-tool
  timeouts, and up to four jobs. Every job owns one directory under `/tmp` which is deleted on
  success, failure, cancellation or expiry, and orphans from a restart are swept at startup.
- Poppler and Tesseract are invoked directly with an argument list and no shell, and filenames are
  reduced to a safe leaf, so nothing in a name can be executed.
- The same SSRF defences as the URL importer apply to the landing page, every redirect hop and the
  download itself; private, link-local, CGNAT and cloud-metadata addresses are refused throughout.
- Clear errors for encrypted, corrupt, oversized and over-long PDFs, for links that need a sign-in,
  for files that are not PDFs, for a book with no recipes in it, and for a build with no OCR
  available.
- The PDF is downloaded transiently and deleted. It is never redistributed, and no copy of it is
  kept once the job ends.

## 1.1.0

**Send the grocery list to your Kroger cart.** Optional, and off until you connect an account.

- Sign in to your own Kroger shopper account with OAuth2 (authorization code), requesting only
  `product.compact` and `cart.basic:write`. Tokens live in `/data/kroger-oauth.json` with
  owner-only permissions, refresh themselves, and are never sent to the browser or the log.
- New **Kroger account** card in Settings: connection status, granted scopes, the exact redirect URL
  with a copy button, portal setup steps, and disconnect.
- New **Build Kroger cart** button on the grocery list. Every unchecked item not covered by your
  pantry is matched at your store, then you review each line — product, quantity, pickup/delivery,
  substitutes — before a final confirmation that states the item count and an estimated subtotal.
  Ambiguous matches are never chosen for you; they block the request until you pick or skip.
- Per-item results report exactly what Kroger confirmed or refused, with a link to Kroger checkout.
  Dime Dinner never places an order.
- Publishes port `8099/tcp`, which serves the OAuth callback path and nothing else. A Home Assistant
  ingress URL carries a rotating session token, so it cannot be registered as a static callback.
  Remove the port mapping to disable account connection; everything else keeps working.
- New `kroger_redirect_uri` option for setups reached by IP, a different hostname, or an HTTPS proxy.
- Cart reviews are held in memory only, dropped when you confirm or cancel, and expire after
  30 minutes.

## 1.0.1

- Fixed a build failure on install by hoisting `ARG BUILD_FROM` to the global Dockerfile scope.

## 1.0.0

- First release: recipe browsing and import, cooking mode, weekly planner, grocery list, pantry,
  text/CSV/print/`.ics` exports, and optional Kroger product lookups.
