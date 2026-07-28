# Dime Dinner — Home Assistant add-on repository

A Home Assistant add-on repository containing a single add-on:

| Add-on                          | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| [Dime Dinner](./dime_dinner/)   | Meal planner, recipe box, grocery list and pantry, as a sidebar panel.       |

Recipes can be browsed from Eating on a Dime, imported from any public recipe page, or read out of a
PDF cookbook — including scanned, image-only ones, which are recognised on your own hardware with
Tesseract. No cloud OCR and no accounts.

The panel itself is reached through the Home Assistant sidebar. One port, `8099/tcp`, is published,
and only to receive the Kroger sign-in callback if you choose to connect a Kroger account — it serves
that single path and nothing else.

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Open the **⋮** menu (top right) and choose **Repositories**.
3. Paste this URL and press **Add**, then **Close**:

   ```
   https://github.com/speaks5527/dime-dinner-home-assistant
   ```

4. Reload the Add-on Store page. A **Dime Dinner Add-ons** section appears — open
   **Dime Dinner** and press **Install**. The first install takes several minutes because
   the client is compiled inside the image on your machine.
5. Turn on **Start on boot**, **Watchdog** and **Show in sidebar**, then press **Start**.
6. Click **Dime Dinner** in the Home Assistant sidebar.

## Documentation

See [`dime_dinner/DOCS.md`](./dime_dinner/DOCS.md) for configuration options, importing a PDF or
ebook, Kroger product lookups, sending the grocery list to a Kroger cart, export formats and
development instructions.
[`dime_dinner/CHANGELOG.md`](./dime_dinner/CHANGELOG.md) lists what changed in each version.

MIT licensed.
