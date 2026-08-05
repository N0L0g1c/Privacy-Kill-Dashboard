// Privacy Kill Dashboard — mic/cam privacy locks + VPN soft kill-switch
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

const POLL_MS = 2000;
const CONFIG_DIR = 'privacy-kill-dashboard';
const CONFIG_FILE = 'settings.json';

/**
 * @returns {string}
 */
function configPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        CONFIG_DIR,
        CONFIG_FILE,
    ]);
}

/**
 * @returns {{killSwitchArmed: boolean}}
 */
function loadConfig() {
    const defaults = {killSwitchArmed: false};
    try {
        const file = Gio.File.new_for_path(configPath());
        if (!file.query_exists(null))
            return defaults;
        const [, bytes] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return {
            killSwitchArmed: !!data.killSwitchArmed,
        };
    } catch {
        return defaults;
    }
}

/**
 * @param {{killSwitchArmed: boolean}} cfg
 */
function saveConfig(cfg) {
    try {
        const file = Gio.File.new_for_path(configPath());
        const dir = file.get_parent();
        if (dir && !dir.query_exists(null))
            dir.make_directory_with_parents(null);
        file.replace_contents(
            new TextEncoder().encode(JSON.stringify(cfg, null, 2)),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } catch (e) {
        logError(e, 'Privacy Kill Dashboard: saveConfig failed');
    }
}

/**
 * @param {string} key
 * @param {string} value
 * @param {string} [style]
 */
class StatusRow extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(key, value, style = '') {
        super({
            reactive: false,
            can_focus: false,
            style_class: 'pkd-row',
        });

        this._key = new St.Label({
            text: key,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pkd-key',
        });
        this.add_child(this._key);

        this._val = new St.Label({
            text: value,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: `pkd-val ${style}`.trim(),
            x_expand: true,
        });
        this.add_child(this._val);
    }

    /**
     * @param {string} text
     * @param {string} [style]
     */
    setValue(text, style = '') {
        this._val.text = text;
        this._val.style_class = `pkd-val ${style}`.trim();
    }
}

class PrivacyKillIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, 'Privacy Kill Dashboard', false);

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._panelIcon = new St.Icon({
            icon_name: 'security-high-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._panelIcon);

        this._panelLabel = new St.Label({
            text: 'Priv',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pkd-panel-label',
        });
        box.add_child(this._panelLabel);

        this.add_child(box);

        this._cfg = loadConfig();
        this._hadVpn = false;
        this._pollSource = 0;
        this._nmClient = null;
        this._nmSignalIds = [];
        this._privacy = null;
        this._mixerControl = null;
        this._inputStream = null;
        this._streamChangedId = 0;
        this._privacyChangedIds = [];

        try {
            this._privacy = new Gio.Settings({
                schema_id: 'org.gnome.desktop.privacy',
            });
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: privacy settings unavailable');
        }

        try {
            this._mixerControl = Volume.getMixerControl();
            this._inputStream = this._mixerControl.get_default_source();
            this._streamChangedId = this._mixerControl.connect(
                'default-source-changed',
                () => {
                    this._inputStream = this._mixerControl.get_default_source();
                    this._refresh();
                }
            );
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: mixer unavailable');
        }

        this._micRow = new StatusRow('Microphone', '…');
        this._camRow = new StatusRow('Camera lock', '…');
        this._micLockRow = new StatusRow('Mic lock', '…');
        this._vpnRow = new StatusRow('VPN', '…');
        this._ksRow = new StatusRow('Kill-switch', '…');

        this.menu.addMenuItem(this._micRow);
        this.menu.addMenuItem(this._camRow);
        this.menu.addMenuItem(this._micLockRow);
        this.menu.addMenuItem(this._vpnRow);
        this.menu.addMenuItem(this._ksRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._toggleMicItem = new PopupMenu.PopupMenuItem('Toggle mic mute');
        this._toggleMicItem.connect('activate', () => this._toggleMicMute());
        this.menu.addMenuItem(this._toggleMicItem);

        this._toggleCamLock = new PopupMenu.PopupMenuItem('Toggle camera privacy lock');
        this._toggleCamLock.connect('activate', () =>
            this._togglePrivacyKey('disable-camera'));
        this.menu.addMenuItem(this._toggleCamLock);

        this._toggleMicLock = new PopupMenu.PopupMenuItem('Toggle microphone privacy lock');
        this._toggleMicLock.connect('activate', () =>
            this._togglePrivacyKey('disable-microphone'));
        this.menu.addMenuItem(this._toggleMicLock);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._armItem = new PopupMenu.PopupMenuItem(this._armLabel());
        this._armItem.connect('activate', () => {
            this._cfg.killSwitchArmed = !this._cfg.killSwitchArmed;
            saveConfig(this._cfg);
            this._armItem.label.text = this._armLabel();
            this._refresh();
            if (this._cfg.killSwitchArmed) {
                Main.notify(
                    'Privacy Kill Dashboard',
                    'Kill-switch armed. If the VPN drops, networking will be disabled.'
                );
            }
        });
        this.menu.addMenuItem(this._armItem);

        this._cutNetItem = new PopupMenu.PopupMenuItem('Disable networking now');
        this._cutNetItem.connect('activate', () => this._setNetworking(false));
        this.menu.addMenuItem(this._cutNetItem);

        this._enableNetItem = new PopupMenu.PopupMenuItem('Enable networking');
        this._enableNetItem.connect('activate', () => this._setNetworking(true));
        this.menu.addMenuItem(this._enableNetItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const hint = new PopupMenu.PopupMenuItem(
            'Locks use GNOME Privacy settings. Kill-switch is soft (NM).',
            {reactive: false, can_focus: false}
        );
        hint.label.add_style_class_name('pkd-hint');
        this.menu.addMenuItem(hint);

        this._statusItem = new PopupMenu.PopupMenuItem('Ready', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('pkd-status');
        this.menu.addMenuItem(this._statusItem);

        if (this._privacy) {
            for (const key of ['disable-camera', 'disable-microphone']) {
                const id = this._privacy.connect(`changed::${key}`, () => this._refresh());
                this._privacyChangedIds.push(id);
            }
        }
    }

    _armLabel() {
        return this._cfg.killSwitchArmed
            ? 'Disarm VPN kill-switch'
            : 'Arm VPN kill-switch';
    }

    async start() {
        try {
            this._nmClient = await NM.Client.new_async(null);
            this._nmSignalIds.push(
                this._nmClient.connect('notify::active-connections', () => this._onNmChange())
            );
            this._nmSignalIds.push(
                this._nmClient.connect('notify::networking-enabled', () => this._refresh())
            );
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: NetworkManager unavailable');
            this._statusItem.label.text = 'NetworkManager unavailable';
        }

        this._hadVpn = this._vpnActive();
        this._refresh();

        this._pollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._onNmChange();
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._pollSource) {
            GLib.Source.remove(this._pollSource);
            this._pollSource = 0;
        }
        if (this._mixerControl && this._streamChangedId) {
            this._mixerControl.disconnect(this._streamChangedId);
            this._streamChangedId = 0;
        }
        if (this._privacy) {
            for (const id of this._privacyChangedIds)
                this._privacy.disconnect(id);
            this._privacyChangedIds = [];
        }
        if (this._nmClient) {
            for (const id of this._nmSignalIds)
                this._nmClient.disconnect(id);
            this._nmSignalIds = [];
        }
        this._nmClient = null;
        this._mixerControl = null;
        this._inputStream = null;
        this._privacy = null;
        super.destroy();
    }

    /**
     * @returns {boolean}
     */
    _vpnActive() {
        if (!this._nmClient)
            return false;
        const connections = this._nmClient.get_active_connections() || [];
        for (const ac of connections) {
            const type = ac.get_connection_type?.() || ac.connection_type || '';
            // VPN, WireGuard (NM treats wg as VPN or wireguard depending on version)
            if (type === 'vpn' || type === 'wireguard' || type.includes('vpn'))
                return true;
            const id = (ac.get_id?.() || ac.id || '').toLowerCase();
            if (id.includes('vpn') || id.includes('wireguard') || id.includes('wg-') ||
                id.includes('tailscale') || id.includes('mullvad') || id.includes('proton'))
                return true;
        }
        // Also treat tailscale0 / wg* interfaces via NM devices
        const devices = this._nmClient.get_devices?.() || [];
        for (const dev of devices) {
            const iface = dev.get_iface?.() || dev.interface || '';
            const state = dev.get_state?.() || dev.state;
            if (!iface || state !== NM.DeviceState.ACTIVATED)
                continue;
            if (iface === 'tailscale0' || iface.startsWith('wg') || iface.startsWith('tun'))
                return true;
        }
        return false;
    }

    _onNmChange() {
        const vpn = this._vpnActive();
        if (this._cfg.killSwitchArmed && this._hadVpn && !vpn) {
            this._triggerKillSwitch();
        }
        this._hadVpn = vpn;
    }

    _triggerKillSwitch() {
        Main.notify(
            'Privacy Kill Dashboard',
            'VPN dropped — disabling networking (kill-switch).'
        );
        this._setNetworking(false);
        this._statusItem.label.text = 'Kill-switch fired — networking disabled';
    }

    /**
     * @param {boolean} enabled
     */
    _setNetworking(enabled) {
        if (!this._nmClient) {
            Main.notify('Privacy Kill Dashboard', 'NetworkManager not available');
            return;
        }
        try {
            this._nmClient.networking_set_enabled(enabled);
            this._statusItem.label.text = enabled
                ? 'Networking enabled'
                : 'Networking disabled';
            this._refresh();
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: networking_set_enabled failed');
            Main.notify(
                'Privacy Kill Dashboard',
                `Could not ${enabled ? 'enable' : 'disable'} networking`
            );
        }
    }

    _toggleMicMute() {
        try {
            const stream = this._inputStream ||
                this._mixerControl?.get_default_source?.();
            if (!stream) {
                Main.notify('Privacy Kill Dashboard', 'No input device found');
                return;
            }
            stream.change_is_muted(!stream.is_muted);
            this._refresh();
        } catch (e) {
            logError(e, 'Privacy Kill Dashboard: mic mute failed');
        }
    }

    /**
     * @param {'disable-camera'|'disable-microphone'} key
     */
    _togglePrivacyKey(key) {
        if (!this._privacy) {
            Main.notify('Privacy Kill Dashboard', 'Privacy settings unavailable');
            return;
        }
        try {
            const cur = this._privacy.get_boolean(key);
            this._privacy.set_boolean(key, !cur);
            this._refresh();
        } catch (e) {
            logError(e, `Privacy Kill Dashboard: toggle ${key} failed`);
        }
    }

    _refresh() {
        // Microphone mute state
        let micMuted = null;
        try {
            const stream = this._inputStream ||
                this._mixerControl?.get_default_source?.();
            if (stream)
                micMuted = !!stream.is_muted;
        } catch {
            // ignore
        }

        if (micMuted === null) {
            this._micRow.setValue('unknown', 'pkd-warn');
        } else if (micMuted) {
            this._micRow.setValue('muted', 'pkd-ok');
        } else {
            this._micRow.setValue('live (unmuted)', 'pkd-danger');
        }

        // Privacy locks
        let camLocked = null;
        let micLocked = null;
        if (this._privacy) {
            try {
                camLocked = this._privacy.get_boolean('disable-camera');
                micLocked = this._privacy.get_boolean('disable-microphone');
            } catch {
                // ignore
            }
        }

        this._camRow.setValue(
            camLocked === null ? 'n/a' : camLocked ? 'locked' : 'allowed',
            camLocked === null ? 'pkd-warn' : camLocked ? 'pkd-ok' : 'pkd-warn'
        );
        this._micLockRow.setValue(
            micLocked === null ? 'n/a' : micLocked ? 'locked' : 'allowed',
            micLocked === null ? 'pkd-warn' : micLocked ? 'pkd-ok' : 'pkd-warn'
        );

        const vpn = this._vpnActive();
        this._vpnRow.setValue(
            vpn ? 'connected' : 'down',
            vpn ? 'pkd-ok' : 'pkd-warn'
        );

        let netOn = true;
        if (this._nmClient) {
            try {
                if (typeof this._nmClient.networking_get_enabled === 'function')
                    netOn = !!this._nmClient.networking_get_enabled();
                else
                    netOn = !!this._nmClient.networking_enabled;
            } catch {
                netOn = true;
            }
        }

        if (this._cfg.killSwitchArmed) {
            this._ksRow.setValue(
                netOn ? 'ARMED' : 'ARMED · net OFF',
                'pkd-armed'
            );
            this._armItem.label.text = this._armLabel();
        } else {
            this._ksRow.setValue(netOn ? 'disarmed' : 'disarmed · net OFF', '');
            this._armItem.label.text = this._armLabel();
        }

        // Panel summary
        const bits = [];
        if (micMuted === false)
            bits.push('MIC');
        if (camLocked === false)
            bits.push('CAM');
        if (this._cfg.killSwitchArmed)
            bits.push(vpn ? 'KS' : 'KS!');
        if (!netOn)
            bits.push('NET×');

        if (bits.length === 0) {
            this._panelLabel.text = 'OK';
            this._panelLabel.style_class = 'pkd-panel-label pkd-ok';
            this._panelIcon.icon_name = 'security-high-symbolic';
        } else if (bits.includes('KS!') || bits.includes('MIC')) {
            this._panelLabel.text = bits.join('·');
            this._panelLabel.style_class = 'pkd-panel-label pkd-danger';
            this._panelIcon.icon_name = 'security-low-symbolic';
        } else {
            this._panelLabel.text = bits.join('·');
            this._panelLabel.style_class = 'pkd-panel-label pkd-warn';
            this._panelIcon.icon_name = 'security-medium-symbolic';
        }
    }
}

export default class PrivacyKillDashboardExtension extends Extension {
    enable() {
        this.disable();
        this._indicator = new PrivacyKillIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.start().catch(e => logError(e));
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        const leftover = Main.panel.statusArea[this.uuid];
        if (leftover) {
            try {
                leftover.destroy();
            } catch {
                // already destroyed
            }
        }
    }
}
