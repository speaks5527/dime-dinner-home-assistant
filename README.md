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
| `lunch_time`           | `12:00` | Local time used for exported lunch calendar events.                |
| `dinner_time`          | `18:00` | Local time used for exported dinner calendar events.               |
| `timezone`             | `""`    | IANA time zone for exports (falls back to the system zone).        |

When an option is set in the add-on configuration it takes precedence over the value saved in the
app, and the Settings page says so.

### Kroger setup (optional)

1. Create a free account at [developer.kroger.com](https://developer.kroger.com/).
2. Add an application; note the **Client ID** and **Client Secret**. The `product.compact` scope is
   all this add-on requests, using the client-credentials (service-to-service) flow — you are never
   asked to sign in to a Kroger account.
3. Enter the credentials plus a ZIP code (or a specific location ID) in the add-on options or on
   the app's Settings page, and press **Test connection**.
4. On the grocery list, each line gets a **Kroger** button that fetches candidate products on
   demand: description, brand, size, image, regular and promo price, aisle, fulfillment options and
   stock level when the API supplies one.

**Stock caveat:** the Products API reports what a store *sells* and how it can be fulfilled. That is
not proof that an item is physically on the shelf right now. Values are shown exactly as the API
returns them, cached for about five minutes, and no local product database is built.

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
npm test         # vitest — parser, ingredients, grocery/pantry, SSRF, ics
npm run check    # tsc
npm run build    # dist/public + dist/index.cjs
npm start        # production server
```

Useful environment variables: `PORT` (default `5000`), `DIME_DINNER_DB` (SQLite path, defaults to
`/data/dime-dinner.db` and falls back to `./data/dime-dinner.db` when `/data` is not writable), and
`DIME_DINNER_OPTIONS` (path to an add-on options JSON file).

## Limitations

- Browse/search covers Eating on a Dime only; other sites are supported through URL import.
- Sites that do not publish schema.org Recipe data cannot be imported.
- Pantry deduction never converts between weight and volume, so those lines are flagged rather than
  reduced.
- Kroger data is informational, not a live inventory feed.

MIT licensed.
