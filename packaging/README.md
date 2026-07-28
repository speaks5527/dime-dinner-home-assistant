# Packaging notes

- `repository.yaml` — sample manifest for hosting Dime Dinner as a Home Assistant add-on
  repository. Copy it to the repository root, with this project in a `dime_dinner/` subfolder.
- For a local install no repository manifest is needed: copy the project folder to
  `/addons/dime_dinner` on the Home Assistant host and refresh the Add-on Store.
- `config.yaml` in the project root declares ingress (`ingress: true`, `ingress_port: 5000`) and the
  sidebar panel (`panel_title`, `panel_icon`), which is what makes the add-on appear as its own tab.
