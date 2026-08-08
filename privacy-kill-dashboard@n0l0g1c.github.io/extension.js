// SPDX-License-Identifier: GPL-2.0-or-later

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

const POLL_MS = 2000;
const CFG = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'privacy-kill-dashboard', 'settings.json',
]);

class Row extends PopupMenu.PopupBaseMenuItem {
    static { GObject.registerClass(this); }

    constructor(label) {
        super({reactive: false, can_focus: false, style_class: 'pkd-row'});
        this.add_child(new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pkd-key',
        }));
        this._val = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pkd-val',
            x_expand: true,
        });
        this.add_child(this._val);
    }

    set(text, extra = '') {
        this._val.text = text;
        this._val.style_class = extra ? `pkd-val ${extra}` : 'pkd-val';
    }
}

class Indicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor() {
        super(0.5, 'Privacy Kill Dashboard', false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'security-high-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: 'Priv',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pkd-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._armed = false;
        this._hadVpn = false;
        this._timer = 0;
        this._nm = null;
        this._nmIds = [];
        this._privacyIds = [];
        this._streamId = 0;

        this._privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
        this._mixer = Volume.getMixerControl();
        this._source = this._mixer.get_default_source();
        this._streamId = this._mixer.connect('default-source-changed', () => {
            this._source = this._mixer.get_default_source();
            this._paint();
        });

        this._mic = new Row('Microphone');
        this._cam = new Row('Camera lock');
        this._micLock = new Row('Mic lock');
        this._vpn = new Row('VPN');
        this._ks = new Row('Kill-switch');
        this.menu.addMenuItem(this._mic);
        this.menu.addMenuItem(this._cam);
        this.menu.addMenuItem(this._micLock);
        this.menu.addMenuItem(this._vpn);
        this.menu.addMenuItem(this._ks);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const mute = new PopupMenu.PopupMenuItem('Toggle mic mute');
        mute.connect('activate', () => this._toggleMute());
        this.menu.addMenuItem(mute);

        const cam = new PopupMenu.PopupMenuItem('Toggle camera lock');
        cam.connect('activate', () => this._flipPrivacy('disable-camera'));
        this.menu.addMenuItem(cam);

        const micLock = new PopupMenu.PopupMenuItem('Toggle microphone lock');
        micLock.connect('activate', () => this._flipPrivacy('disable-microphone'));
        this.menu.addMenuItem(micLock);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._arm = new PopupMenu.PopupMenuItem(this._armText());
        this._arm.connect('activate', () => {
            this._armed = !this._armed;
            this._save();
            this._arm.label.text = this._armText();
            this._paint();
            if (this._armed) {
                Main.notify(
                    'Privacy Kill Dashboard',
                    'Kill-switch armed. Networking disables if VPN drops.'
                );
            }
        });
        this.menu.addMenuItem(this._arm);

        const cut = new PopupMenu.PopupMenuItem('Disable networking now');
        cut.connect('activate', () => this._setNet(false));
        this.menu.addMenuItem(cut);

        const enable = new PopupMenu.PopupMenuItem('Enable networking');
        enable.connect('activate', () => this._setNet(true));
        this.menu.addMenuItem(enable);

        this._note = new PopupMenu.PopupMenuItem('Ready', {reactive: false, can_focus: false});
        this._note.label.add_style_class_name('pkd-status');
        this.menu.addMenuItem(this._note);

        for (const key of ['disable-camera', 'disable-microphone'])
            this._privacyIds.push(
                this._privacy.connect(`changed::${key}`, () => this._paint())
            );
    }

    _armText() {
        return this._armed ? 'Disarm VPN kill-switch' : 'Arm VPN kill-switch';
    }

    async start() {
        try {
            const file = Gio.File.new_for_path(CFG);
            if (file.query_exists(null)) {
                const [, bytes] = await file.load_contents_async(null);
                const data = JSON.parse(new TextDecoder().decode(bytes));
                this._armed = !!data.killSwitchArmed;
                this._arm.label.text = this._armText();
            }
        } catch {
            // defaults
        }

        try {
            this._nm = await NM.Client.new_async(null);
            this._nmIds.push(
                this._nm.connect('notify::active-connections', () => this._onNm())
            );
            this._nmIds.push(
                this._nm.connect('notify::networking-enabled', () => this._paint())
            );
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: NM unavailable');
            this._note.label.text = 'NetworkManager unavailable';
        }

        this._hadVpn = this._vpnUp();
        this._paint();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._onNm();
            this._paint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        if (this._streamId) {
            this._mixer.disconnect(this._streamId);
            this._streamId = 0;
        }
        for (const id of this._privacyIds)
            this._privacy.disconnect(id);
        this._privacyIds = [];
        if (this._nm) {
            for (const id of this._nmIds)
                this._nm.disconnect(id);
            this._nmIds = [];
            this._nm = null;
        }
        this._mixer = null;
        this._source = null;
        this._privacy = null;
        super.destroy();
    }

    async _save() {
        try {
            const file = Gio.File.new_for_path(CFG);
            const dir = file.get_parent();
            if (dir && !dir.query_exists(null))
                dir.make_directory_with_parents(null);
            await file.replace_contents_async(
                new TextEncoder().encode(JSON.stringify({killSwitchArmed: this._armed}, null, 2)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: save failed');
        }
    }

    _vpnUp() {
        if (!this._nm)
            return false;
        for (const ac of this._nm.get_active_connections()) {
            const type = ac.get_connection_type() || '';
            if (type === 'vpn' || type === 'wireguard' || type.includes('vpn'))
                return true;
            const id = (ac.get_id() || '').toLowerCase();
            if (id.includes('vpn') || id.includes('wireguard') || id.includes('tailscale'))
                return true;
        }
        for (const dev of this._nm.get_devices()) {
            if (dev.get_state() !== NM.DeviceState.ACTIVATED)
                continue;
            const iface = dev.get_iface() || '';
            if (iface === 'tailscale0' || iface.startsWith('wg') || iface.startsWith('tun'))
                return true;
        }
        return false;
    }

    _onNm() {
        const up = this._vpnUp();
        if (this._armed && this._hadVpn && !up) {
            Main.notify('Privacy Kill Dashboard', 'VPN dropped — networking disabled');
            this._setNet(false);
            this._note.label.text = 'Kill-switch fired';
        }
        this._hadVpn = up;
    }

    _setNet(on) {
        if (!this._nm) {
            Main.notify('Privacy Kill Dashboard', 'NetworkManager not available');
            return;
        }
        this._nm.networking_set_enabled(on);
        this._note.label.text = on ? 'Networking enabled' : 'Networking disabled';
        this._paint();
    }

    _toggleMute() {
        const stream = this._source || this._mixer.get_default_source();
        if (!stream) {
            Main.notify('Privacy Kill Dashboard', 'No input device');
            return;
        }
        stream.change_is_muted(!stream.is_muted);
        this._paint();
    }

    _flipPrivacy(key) {
        this._privacy.set_boolean(key, !this._privacy.get_boolean(key));
        this._paint();
    }

    _paint() {
        const stream = this._source || this._mixer.get_default_source();
        const muted = stream ? !!stream.is_muted : null;
        if (muted === null)
            this._mic.set('unknown', 'pkd-warn');
        else if (muted)
            this._mic.set('muted', 'pkd-ok');
        else
            this._mic.set('live', 'pkd-danger');

        const camOff = this._privacy.get_boolean('disable-camera');
        const micOff = this._privacy.get_boolean('disable-microphone');
        this._cam.set(camOff ? 'locked' : 'allowed', camOff ? 'pkd-ok' : 'pkd-warn');
        this._micLock.set(micOff ? 'locked' : 'allowed', micOff ? 'pkd-ok' : 'pkd-warn');

        const vpn = this._vpnUp();
        this._vpn.set(vpn ? 'connected' : 'down', vpn ? 'pkd-ok' : 'pkd-warn');

        let netOn = true;
        if (this._nm)
            netOn = this._nm.networking_get_enabled();

        if (this._armed)
            this._ks.set(netOn ? 'ARMED' : 'ARMED · net OFF', 'pkd-armed');
        else
            this._ks.set(netOn ? 'disarmed' : 'disarmed · net OFF');
        this._arm.label.text = this._armText();

        const flags = [];
        if (muted === false)
            flags.push('MIC');
        if (!camOff)
            flags.push('CAM');
        if (this._armed)
            flags.push(vpn ? 'KS' : 'KS!');
        if (!netOn)
            flags.push('NET×');

        if (!flags.length) {
            this._label.text = 'OK';
            this._label.style_class = 'pkd-panel-label pkd-ok';
            this._icon.icon_name = 'security-high-symbolic';
        } else if (flags.includes('KS!') || flags.includes('MIC')) {
            this._label.text = flags.join('·');
            this._label.style_class = 'pkd-panel-label pkd-danger';
            this._icon.icon_name = 'security-low-symbolic';
        } else {
            this._label.text = flags.join('·');
            this._label.style_class = 'pkd-panel-label pkd-warn';
            this._icon.icon_name = 'security-medium-symbolic';
        }
    }
}

export default class PrivacyKillDashboardExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.start().catch(e => logError(e));
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
