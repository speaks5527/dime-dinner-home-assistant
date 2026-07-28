# Dime Dinner — Home Assistant add-on

A self-contained meal planning panel for Home Assistant. It appears as its own tab in the
left sidebar (via add-on ingress) and does not create any entities, services or automations.

- **Recipes** — search the [Eating on a Dime](https://www.eatingonadime.com/) catalog, or paste
  a link from any public recipe site that publishes schema.org Recipe data.
- **Cooking Mode** — one big step at a time, hero image, progress bar, expandable ingredient
  list, keyboard shortcuts and an optional keep-screen-awake toggle.
- **Weekly planner** — seven days, lunch and dinner slots.
- **Grocery list** — generated from the week's plan, duplicates combined, sorted by aisle, with
  check-off, editable amounts and manual items.
- **Pantry** — a persistent list of what you already have; the grocery list deducts from it
  conservatively and always explains what it did.
- **Exports** — categorized plain text, CSV, print/PDF grocery list, a print/PDF weekly plan and
  a standards-compliant `.ics` calendar file (all local; nothing is uploaded).
- **Optional Kroger lookups** — on-demand product matches with price, aisle and fulfillment.
- **Optional Kroger cart** — sign in to your own Kroger account and send the grocery list to your
  Kroger cart, after reviewing every product, quantity and pickup/delivery choice yourself.

Everything is stored in a SQLite database inside the add-on's `/data` folder.

---

## Installation

### Option A — local add-on (simplest)

1. Copy this whole folder to your Home Assistant machine at `/addons/dime_dinner`
   (the `addons` share, e.g. via the Samba or File Editor add-on).
2. Go to **Settings → Add-ons → Add-on Store**, open the ⋮ menu and choose **Check for updates**.
3. "Dime Dinner" appears under **Local add-ons**. Open it and press **Install** — the first build
   takes a few minutes because the client is compiled inside the image.
4. Turn on **Start on boot**, **Watchdog** and **Show in sidebar**, then press **Start**.
5. Click **Dime Dinner** in the sidebar.

### Option B — add-on repository

Host this folder inside a git repository as `dime_dinner/` with a `repository.yaml` at the
repository root (a sample is in [`packaging/repository.yaml`](packaging/repository.yaml)), then add
the repository URL under **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.

---

## Configuration

All add-on options are optional. Leave them blank to configure the same values from the app's
**Settings** page instead.

| Option                 | Default | Purpose                                                            |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| `kroger_enabled`       | `false` | Turn on Kroger product lookups.                                    |
| `kroger_client_id`     | `""`    | Kroger developer application client ID.                            |
| `kroger_client_secret` | `""`    | Kroger developer application client secret (stored as a password). |
| `kroger_zip`           | `""`    | ZIP code used to pick a nearby store.                              |
| `kroger_location_id`   | `""`    | Exact Kroger location ID; overrides the ZIP lookup.                |
| `kroger_redirect_uri`  | `""`    | Exact OAuth redirect URL registered at Kroger (see below).         |
| `lunch_time`           | `12:00` | Local time used for exported lunch calendar events.                |
| `dinner_time`          | `18:00` | Local time used for exported dinner calendar events.               |
| `timezone`             | `""`    | IANA time zone for exports (falls back to the system zone).        |

When an option is set in the add-on configuration it takes precedence over the value saved in the
app, and the Settings page says so.

### Network ports

The app itself is **ingress-only** — it is reached through the Home Assistant sidebar and is not
published on the network. One port is published, and only because OAuth requires it:

| Port       | Serves                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `8099/tcp` | `/api/kroger/oauth/callback` and nothing else. No app, no API, no data.    |

A Home Assistant ingress URL contains a session token that rotates, so it can never be registered
as a static OAuth callback — Kroger would stop recognising it. The add-on therefore runs a second,
deliberately tiny listener that answers exactly one path with `GET`, exchanges the authorization code
server-side, and returns a static result page. Every other path, method and query is a 404 or 405.
Set the port mapping to nothing in the add-on's **Network** panel to disable connecting a Kroger
account; everything else in the add-on keeps working.

### Kroger product lookups (optional)

1. Create a free account at [developer.kroger.com](https://developer.kroger.com/).
2. Add an application; note the **Client ID** and **Client Secret**.
3. Enter the credentials plus a ZIP code (or a specific location ID) in the add-on options or on
   the app's Settings page, and press **Test connection**.
4. On the grocery list, each line gets a **Kroger** button that fetches candidate products on
   demand: description, brand, size, image, regular and promo price, aisle, fulfillment options and
   stock level when the API supplies one.

Lookups use the client-credentials (service-to-service) flow with the `product.compact` scope, so
they need no Kroger account of yours.

**Stock caveat:** the Products API reports what a store *sells* and how it can be fulfilled. That is
not proof that an item is physically on the shelf right now. Values are shown exactly as the API
returns them, cached for about five minutes, and no local product database is built.

---

## Sending the grocery list to your Kroger cart (optional)

Adding to a cart is a *customer* action, so it needs the OAuth2 authorization-code flow and a
sign-in with your own Kroger shopper account. Dime Dinner requests two scopes and no others:
`product.compact` (to find products) and `cart.basic:write` (to add them).

### 1. Decide the redirect URL

Kroger compares the redirect URL **character for character**. Pick the one that matches how you
reach Home Assistant and use the exact same string in both places:

| How you reach Home Assistant | Redirect URL to register                                       |
| ---------------------------- | -------------------------------------------------------------- |
| `homeassistant.local`        | `http://homeassistant.local:8099/api/kroger/oauth/callback`     |
| A fixed LAN IP               | `http://192.168.1.50:8099/api/kroger/oauth/callback`            |
| An external HTTPS hostname   | `https://ha.example.com:8099/api/kroger/oauth/callback`         |

The default is the first one. The Settings page shows the exact value with a copy button, and refuses
anything that could not be this callback (wrong path, a query string, embedded credentials, a scheme
other than `http`/`https`).

> **If Kroger rejects a plain `http://` redirect for your application**, register an HTTPS URL
> instead. Point a hostname you already terminate TLS on at the add-on's port 8099 — for example an
> NGINX/Traefik server block for `ha.example.com` proxying `/api/kroger/oauth/callback` to
> `http://<home-assistant-ip>:8099`, or Home Assistant's own reverse proxy if you already run one —
> then set `kroger_redirect_uri` to the HTTPS URL. The proxy must forward that path unchanged; the
> add-on only ever reads the `code`, `state` and `error` query parameters. Port 8099 does not have to
> be reachable from the internet, only from the proxy.

### 2. Configure the application at Kroger

1. Sign in at [developer.kroger.com](https://developer.kroger.com/) and open your application.
2. Add the **Products**, **Locations** *and* **Cart** APIs to it. Cart is the one that permits adding
   items — without it a sign-in still succeeds but every cart write is refused with a 403.
3. Use a **Production** application. Certification-environment credentials will sign in but do not
   reach a real cart.
4. Register the redirect URL from step 1, exactly.
5. Copy the **Client ID** and **Client Secret** into the add-on options or the app's Settings page.

### 3. Connect the account

1. Open **Settings** in Dime Dinner. If the redirect URL differs from the default, paste it into
   **Redirect URL** and press **Save redirect URL** (or set `kroger_redirect_uri` in the add-on
   options).
2. Press **Connect Kroger account**. A Kroger sign-in page opens in a new tab — Kroger's consent page
   cannot render inside the Home Assistant frame, so pop-ups must be allowed.
3. Sign in with the **Kroger shopper account whose cart you want to fill**, not the developer login,
   and approve the request.
4. The tab shows a plain confirmation page. Return to Dime Dinner; the Settings page notices the new
   connection on its own and shows which scopes were granted.

### 4. Build a cart

1. On the **Grocery list**, press **Build Kroger cart**. Every item that is still unchecked and not
   already covered by your pantry is looked up at your store.
2. A review opens. For each item you see the matched product's image, name, brand, size and price,
   and you can:
   - change the quantity (whole units, 1–99),
   - choose a different product, or search Kroger for a different term,
   - pick pickup or delivery where the product offers both,
   - tick **Allow substitutes**,
   - or **Skip this item**.
3. Nothing is pre-selected unless a product matched every word of the grocery line and has a UPC the
   Cart API accepts. Anything less is marked **pick a product** and **blocks the whole request** until
   you choose or skip it.
4. Press **Continue** for a final summary: how many products, and an **estimated** subtotal.
5. Press **Add N items to my cart**. Only then does anything reach Kroger.
6. Each item is reported as confirmed or failed, with Kroger's reason. **Open Kroger cart** takes you
   to checkout, where you pick your time slot and confirm the real total. Dime Dinner never places an
   order.

### What is stored, and what is not

- The OAuth tokens are the only Kroger-derived data written to disk: `/data/kroger-oauth.json`,
  created with owner-only (`0600`) permissions, separate from the app database. They are never
  returned to the browser and never written to the add-on log.
- Access tokens are refreshed automatically about a minute before they expire. If Kroger rejects the
  refresh token, the stored grant is deleted and you are asked to sign in again.
- **Disconnect** (Settings) deletes the stored tokens and invalidates any pending sign-in. Clearing
  the Kroger credentials disconnects the account too. Kroger does not publish a token-revocation
  endpoint for this flow, so remove Dime Dinner's access at Kroger's own account page as well if you
  want the grant revoked upstream.
- The cart review lives **in memory only**. It is deleted as soon as you confirm or cancel, and
  expires by itself after 30 minutes. No product data, price or cart content is cached to disk.

### Kroger acceptable use

Product values are displayed exactly as the API returns them, no competitor price comparison is
performed, no product database is built, and lookups are cached for minutes rather than persisted.

---

## Skylight exports

Skylight has no documented public API for pushing lists or calendars, so Dime Dinner never signs in
to a Skylight account and nothing syncs automatically. Instead:

- **Grocery → Copy text** puts a clean, aisle-grouped list on the clipboard.
- **Grocery → Print / PDF** renders a single-page list suitable for Skylight's Magic Import (import
  the PDF or a photo of it).
- **Grocery → CSV** downloads a spreadsheet-friendly file.
- **Planner → Print / PDF** renders the week — dates, lunch and dinner, and the source site — with
  the grocery list as a second page.
- **Planner → .ics calendar** downloads a standards-compliant calendar file with one timed event per
  planned meal, using the lunch/dinner times and time zone from Settings.

---

## How recipes are handled

Recipes are fetched from their publisher **on demand**, only when you search or import, and only the
recipe data the page itself publishes as schema.org JSON-LD. Nothing is bulk-copied, mirrored or
re-published, requests are rate-limited per host with a descriptive user agent, and every recipe
keeps a prominent link back to its source. Dime Dinner is an independent personal tool and is not
affiliated with, endorsed by or sponsored by Eating on a Dime, Kroger or Skylight.

Import safety: only `http(s)` URLs are fetched; localhost, private, link-local, carrier-grade NAT
and cloud metadata addresses are rejected before and after DNS resolution and on every redirect;
redirects, response size and request time are capped; and all stored text is sanitized before it is
rendered.

---

## Development

```bash
npm install
npm run dev      # http://localhost:5000
npm test         # vitest
npm run check    # tsc
npm run build    # dist/public + dist/index.cjs
npm start        # production server
```

The test suite covers the recipe parser, ingredient handling, grocery/pantry deduction, SSRF
defences, `.ics` generation, and the Kroger integration: the OAuth authorize URL and state
lifecycle, the callback exchange, token refresh, cart payload construction and partial failures,
match classification and review sessions, and the explicit-confirmation guard exercised through the
real HTTP route. No test contacts Kroger; `fetch` is stubbed throughout.

| Variable                     | Default                | Purpose                                                    |
| ---------------------------- | ---------------------- | ---------------------------------------------------------- |
| `PORT`                       | `5000`                 | Port the app listens on.                                   |
| `DIME_DINNER_DB`             | `/data/dime-dinner.db` | SQLite path; falls back to `./data/` when `/data` is not writable. |
| `DIME_DINNER_OPTIONS`        | —                      | Path to an add-on options JSON file.                        |
| `DIME_DINNER_KROGER_TOKENS`  | `/data/kroger-oauth.json` | Path to the OAuth token file; same `./data/` fallback.   |
| `DIME_DINNER_CALLBACK_PORT`  | `8099`                 | Port for the OAuth callback listener.                       |

## Limitations

- Browse/search covers Eating on a Dime only; other sites are supported through URL import.
- Sites that do not publish schema.org Recipe data cannot be imported.
- Pantry deduction never converts between weight and volume, so those lines are flagged rather than
  reduced.
- Kroger data is informational, not a live inventory feed.
- Cart quantities are whole retail units, not recipe amounts — "2 lbs ground beef" becomes one
  package unless you raise the count yourself. Nothing is converted.
- The Cart API accepts pickup and delivery only. Ship-to-home is not a cart modality.
- **Allow substitutes** cannot be sent to Kroger — the public Cart API has no such field. Ticking it
  produces a reminder on the results screen so you can set it at checkout instead.
- `PUT /v1/cart/add` returns no per-item detail, so each item is sent as its own request in order to
  report an honest per-item result.
- Signing in needs port 8099 reachable from your browser (or from a proxy in front of it). With the
  port mapping removed, lookups and every export still work; only the cart does not.
- Kroger publishes no token-revocation endpoint for this flow, so **Disconnect** deletes the local
  grant but cannot revoke it upstream.
- A cart review is held in memory and expires after 30 minutes; reopening it starts a fresh lookup.

MIT licensed.
