# Privacy Kill Dashboard

GNOME Shell extension: top-panel **privacy status board** for microphone mute, camera/mic privacy locks, and an optional soft VPN kill-switch.

## Features

- Panel summary: `OK`, or flags such as `MIC`, `CAM`, `KS`, `NET×`
- Toggle default input (mic) mute via GNOME Shell volume control
- Toggle camera and microphone privacy locks (`org.gnome.desktop.privacy`)
- Arm a soft kill-switch: if VPN / WireGuard / Tailscale was up and then drops, NetworkManager networking is disabled
- Manual disable/enable networking via NetworkManager

## Requirements

- GNOME Shell **45–50**
- NetworkManager (for VPN detection and soft kill-switch)

## Install (local)

```bash
UUID=privacy-kill-dashboard@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

On Wayland, log out and back in so the shell discovers a newly copied UUID, then enable it.

## Configuration

Optional: `~/.config/privacy-kill-dashboard/settings.json`

```json
{
  "killSwitchArmed": false
}
```

## Limits

- Privacy locks are the same settings as **Settings → Privacy**.
- Kill-switch is **soft** (NM networking off). It is not a kernel/nftables kill-switch. Prefer your VPN client’s hard kill-switch for threat models that need it.

## Publish to extensions.gnome.org

This project follows the [EGO review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html):

| Requirement | How this extension complies |
|---|---|
| GPL-compatible license | GPL-2.0-or-later (`LICENSE`) |
| `enable()` / `disable()` lifecycle | Objects, signals, and timeouts only while enabled; cleaned up in `disable()` |
| No work before `enable()` | `Extension` class only constructs the indicator in `enable()` |
| Honest `metadata.json` | UUID `name@namespace`, `shell-version` stable only, network/privacy behavior described |
| No telemetry | No analytics |
| No bundled binaries | Uses system NetworkManager and Shell mixer APIs only |
| Zip contents | Only files needed to run (see below) |

### Package for upload

```bash
./pack.sh
# produces: privacy-kill-dashboard@n0l0g1c.github.io.shell-extension.zip
```

The zip root **must** contain `metadata.json` (contents of the UUID directory only — not the git repo root).

Upload at [extensions.gnome.org](https://extensions.gnome.org/) after creating an account. Reviewers check security and guideline compliance, not full product QA.

## Development

```bash
# after editing, reinstall and reload
cp -a privacy-kill-dashboard@n0l0g1c.github.io \
  ~/.local/share/gnome-shell/extensions/
# X11: Alt+F2 → r → Enter
# Wayland: log out / log in
journalctl -f /usr/bin/gnome-shell
```

## License

[GPL-2.0-or-later](LICENSE) — required for code loaded into GPL-licensed GNOME Shell.

## Author

[N0L0g1c](https://github.com/N0L0g1c)
