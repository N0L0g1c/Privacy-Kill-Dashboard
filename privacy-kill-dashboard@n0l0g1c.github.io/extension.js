// SPDX-License-Identifier: GPL-2.0-or-later
/* mic/cam privacy + soft VPN kill-switch */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import NM from 'gi://NM';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

const CFG = `${GLib.get_user_config_dir()}/privacy-kill-dashboard/settings.json`;

const Panel = GObject.registerClass(
class Panel extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Privacy Kill Dashboard');

        this._text = new St.Label({
            text: 'Priv',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._text);

        this.armed = false;
        this.hadVpn = false;
        this.nm = null;
        this.nmSig = [];
        this.privSig = [];
        this.timeout = 0;

        this.privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
        this.mixer = Volume.getMixerControl();
        this.input = this.mixer.get_default_source();
        this.mixerSig = this.mixer.connect('default-source-changed', () => {
            this.input = this.mixer.get_default_source();
            this.refresh();
        });

        this.micItem = new PopupMenu.PopupMenuItem('Mic: …', {reactive: false});
        this.camItem = new PopupMenu.PopupMenuItem('Camera: …', {reactive: false});
        this.micLockItem = new PopupMenu.PopupMenuItem('Mic lock: …', {reactive: false});
        this.vpnItem = new PopupMenu.PopupMenuItem('VPN: …', {reactive: false});
        this.ksItem = new PopupMenu.PopupMenuItem('Kill-switch: …', {reactive: false});
        this.menu.addMenuItem(this.micItem);
        this.menu.addMenuItem(this.camItem);
        this.menu.addMenuItem(this.micLockItem);
        this.menu.addMenuItem(this.vpnItem);
        this.menu.addMenuItem(this.ksItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let m = new PopupMenu.PopupMenuItem('Toggle mic mute');
        m.connect('activate', () => {
            const s = this.input || this.mixer.get_default_source();
            if (s)
                s.change_is_muted(!s.is_muted);
            this.refresh();
        });
        this.menu.addMenuItem(m);

        m = new PopupMenu.PopupMenuItem('Toggle camera lock');
        m.connect('activate', () => {
            const k = 'disable-camera';
            this.privacy.set_boolean(k, !this.privacy.get_boolean(k));
        });
        this.menu.addMenuItem(m);

        m = new PopupMenu.PopupMenuItem('Toggle mic lock');
        m.connect('activate', () => {
            const k = 'disable-microphone';
            this.privacy.set_boolean(k, !this.privacy.get_boolean(k));
        });
        this.menu.addMenuItem(m);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.armItem = new PopupMenu.PopupMenuItem('Arm VPN kill-switch');
        this.armItem.connect('activate', () => {
            this.armed = !this.armed;
            this.save();
            this.armItem.label.text = this.armed
                ? 'Disarm VPN kill-switch'
                : 'Arm VPN kill-switch';
            this.refresh();
            if (this.armed)
                Main.notify('Privacy Kill Dashboard',
                    'If VPN drops, networking will be turned off');
        });
        this.menu.addMenuItem(this.armItem);

        m = new PopupMenu.PopupMenuItem('Disable networking');
        m.connect('activate', () => this.setNet(false));
        this.menu.addMenuItem(m);

        m = new PopupMenu.PopupMenuItem('Enable networking');
        m.connect('activate', () => this.setNet(true));
        this.menu.addMenuItem(m);

        for (const key of ['disable-camera', 'disable-microphone']) {
            this.privSig.push(
                this.privacy.connect(`changed::${key}`, () => this.refresh()));
        }

        this.bootstrap();
    }

    async bootstrap() {
        try {
            const f = Gio.File.new_for_path(CFG);
            if (f.query_exists(null)) {
                const [, b] = await f.load_contents_async(null);
                const j = JSON.parse(new TextDecoder().decode(b));
                this.armed = !!j.killSwitchArmed;
                this.armItem.label.text = this.armed
                    ? 'Disarm VPN kill-switch'
                    : 'Arm VPN kill-switch';
            }
        } catch (e) { /* keep defaults */ }

        try {
            this.nm = await NM.Client.new_async(null);
            this.nmSig.push(this.nm.connect('notify::active-connections', () => {
                this.checkVpnDrop();
            }));
        } catch (e) {
            logError(e);
        }

        this.hadVpn = this.vpnActive();
        this.refresh();
        this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this.checkVpnDrop();
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this.timeout) {
            GLib.Source.remove(this.timeout);
            this.timeout = 0;
        }
        if (this.mixerSig) {
            this.mixer.disconnect(this.mixerSig);
            this.mixerSig = 0;
        }
        for (const id of this.privSig)
            this.privacy.disconnect(id);
        this.privSig = [];
        if (this.nm) {
            for (const id of this.nmSig)
                this.nm.disconnect(id);
            this.nmSig = [];
            this.nm = null;
        }
        super.destroy();
    }

    async save() {
        try {
            const f = Gio.File.new_for_path(CFG);
            const dir = f.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            await f.replace_contents_async(
                new TextEncoder().encode(JSON.stringify({killSwitchArmed: this.armed})),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e);
        }
    }

    vpnActive() {
        if (!this.nm)
            return false;
        for (const c of this.nm.get_active_connections()) {
            const t = c.get_connection_type() || '';
            if (t === 'vpn' || t === 'wireguard' || t.indexOf('vpn') !== -1)
                return true;
        }
        for (const d of this.nm.get_devices()) {
            if (d.get_state() !== NM.DeviceState.ACTIVATED)
                continue;
            const iface = d.get_iface() || '';
            if (iface === 'tailscale0' || iface.startsWith('wg') || iface.startsWith('tun'))
                return true;
        }
        return false;
    }

    checkVpnDrop() {
        const up = this.vpnActive();
        if (this.armed && this.hadVpn && !up) {
            Main.notify('Privacy Kill Dashboard', 'VPN dropped, networking disabled');
            this.setNet(false);
        }
        this.hadVpn = up;
    }

    setNet(on) {
        if (!this.nm)
            return;
        this.nm.networking_set_enabled(on);
        this.refresh();
    }

    refresh() {
        const stream = this.input || this.mixer.get_default_source();
        const muted = stream ? stream.is_muted : null;
        this.micItem.label.text = muted === null
            ? 'Mic: ?'
            : muted ? 'Mic: muted' : 'Mic: LIVE';

        const cam = this.privacy.get_boolean('disable-camera');
        const mic = this.privacy.get_boolean('disable-microphone');
        this.camItem.label.text = cam ? 'Camera: locked' : 'Camera: allowed';
        this.micLockItem.label.text = mic ? 'Mic lock: locked' : 'Mic lock: allowed';

        const vpn = this.vpnActive();
        this.vpnItem.label.text = vpn ? 'VPN: up' : 'VPN: down';

        let net = true;
        if (this.nm)
            net = this.nm.networking_get_enabled();
        this.ksItem.label.text = this.armed
            ? (net ? 'Kill-switch: ARMED' : 'Kill-switch: ARMED, net off')
            : 'Kill-switch: off';

        if (muted === false)
            this._text.text = 'MIC';
        else if (this.armed && !vpn)
            this._text.text = 'KS!';
        else if (!cam || this.armed)
            this._text.text = this.armed ? 'KS' : 'CAM';
        else
            this._text.text = 'OK';
    }
});

export default class extends Extension {
    enable() {
        this._panel = new Panel();
        Main.panel.addToStatusArea(this.uuid, this._panel);
    }

    disable() {
        this._panel.destroy();
        this._panel = null;
    }
}
