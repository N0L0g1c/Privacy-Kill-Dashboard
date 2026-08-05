# Privacy Kill Dashboard

GNOME Shell extension: top-panel **privacy status board** for microphone mute, camera/mic privacy locks, and an optional soft VPN kill-switch.

![Screenshot](screenshots/screenshot.png)

## Features

- Panel summary: `OK`, or flags such as `MIC`, `CAM`, `KS`, `NET×`
- Toggle default input (mic) mute via GNOME Shell volume control
- Toggle camera and microphone privacy locks (`org.gnome.desktop.privacy`)
- Arm a soft kill-switch: if VPN / WireGuard / Tailscale was up and then drops, NetworkManager networking is disabled
- Manual disable/enable networking via NetworkManager

## Requirements

- GNOME Shell **45–50**
- NetworkManager (for VPN detection and soft kill-switch)

## Install

```bash
UUID=privacy-kill-dashboard@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

Log out/in on Wayland (or restart GNOME Shell) so the extension is discovered.

## Configuration

Optional: `~/.config/privacy-kill-dashboard/settings.json`

```json
{
  "killSwitchArmed": false
}
```

## Limits

- Privacy locks are the same settings as **Settings → Privacy**.
- Kill-switch is **soft** (NM networking off). It is not a kernel/nftables kill-switch. Prefer your VPN client’s hard kill-switch when that threat model requires it.

## Screenshots

| File | Contents |
|---|---|
| [`screenshots/screenshot.png`](screenshots/screenshot.png) | Primary store image — armed kill-switch, locks on |
| [`screenshots/screenshot-alert.png`](screenshots/screenshot-alert.png) | Alert state — mic live, locks open |
| [`screenshots/icon.png`](screenshots/icon.png) | Optional icon asset |

## Packaging

Package only the extension runtime files (EGO zip must have `metadata.json` at the root):

```bash
./pack.sh
# → privacy-kill-dashboard@n0l0g1c.github.io.shell-extension.zip
```

Zip contents: `metadata.json`, `extension.js`, `stylesheet.css`, `LICENSE`.

This project follows the [GNOME Shell extension review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) (lifecycle cleanup, GPL-2.0-or-later, honest metadata, no telemetry, no bundled binaries).

## Development

```bash
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
