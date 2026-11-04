# local-plugins

Fork-local DSH plugins and the local patch registry, kept in this checkout so
they travel with it. They are **not** part of the pnpm workspace:
`pnpm-workspace.yaml` only globs `packages/*/*`, and keeping them out means
`pnpm run build`, `pnpm run typecheck` and the workspace constraint checks never
see them. Both plugins are dependency-free single-package ESM, loaded by a
profile directly.

| Path | What it does |
| --- | --- |
| `dsh-ntfy/` | Publish notifications to the phone over a self-hosted ntfy server (`ntfy_send`, `ntfy_send_file`). See `dsh-ntfy/docs/publish.md`. |
| `dsh-safe-install/` | Gate every plugin install behind a trial boot. Wraps `pluginManager.installBundle`; `dsh-safe-install.sh` beside it does the throwaway-`DSH_HOME` install, boot, and probes. |
| `patches/` | The local patch registry: which installed files this profile edits (`dsh-webui-auth`, `dsh-restart-anywhere`) and the patchers that re-derive them after an upgrade. `dsh-safe-install.sh` reads it from here. |

## Nothing names a machine

Every path is derived from where these files live, so a checkout moved or cloned
elsewhere keeps working:

- `dsh-safe-install.sh` resolves the checkout root and the patch registry from
  its own directory (`$HERE/../..`, `$HERE/../patches`); `DSH_CHECKOUT` and
  `DSH_PATCH_REGISTRY` still override.
- The plugin resolves `./dsh-safe-install.sh` from `import.meta.dirname`;
  `DSH_SAFE_INSTALL_SCRIPT` or the `script` config key points it elsewhere.

## Deployment values stay in the profile

The bundled `cordis.patch.yml` files carry **placeholders only**. Real values —
the ntfy server URL and, more importantly, its topic, which is a password by
construction — live in `~/.dsh/profiles/web/cordis.patch.yml`, which overrides
the whole `config` block. Never commit them here.

## How a profile loads them

A profile links the plugin into its own `node_modules` (and records the same
`link:` specifier in its `package.json`), then the plugin's `cordis.patch.yml`
supplies the configuration entry:

```bash
ln -s ../../../../../../opt/dsh/deepseek-harness/local-plugins/dsh-ntfy \
  ~/.dsh/profiles/web/node_modules/dsh-ntfy
```

Nothing here is built or bundled: `package.json` points `main` straight at the
source file, so an edit takes effect on the next dsh restart.

## Provenance

Vendored from `~/dsh/plugins/` and `~/dsh/patches/` on 2026-11-04, with the DSH
0.2.2-alpha.3 upgrade. Those copies are gone; this tree is the only source, and
the profile symlinks point here.
