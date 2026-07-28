# Changelog

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
