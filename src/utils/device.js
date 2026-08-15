'use strict'
/**
 * Device manager: keeps the connected-device list fresh (ADB polling), resolves
 * which device to use for Launch / Logcat / Attach and builds human-readable
 * device labels (brand + model instead of raw serials like "127.0.0.1:5555").
 *
 * The chosen device is persisted in the extension's globalState until it
 * disconnects, so the QuickPick only appears when the choice is unknown
 * (e.g. several devices connected and no selection made yet).
 */
const { EventEmitter } = require('events');
const { ADBClient } = require('../adbclient');
const i18n = require('../i18n');

const POLL_INTERVAL_MS = 2000;
const LABEL_TTL_MS = 60000;
const STORAGE_KEY = 'androidDevTools.selectedDeviceSerial';

/** @type {DeviceManager|null} */
let _manager = null;

class DeviceManager extends EventEmitter {
    /**
     * @param {import('vscode').ExtensionContext} [context]
     */
    constructor(context) {
        super();
        this.context = context;
        /** @type {{serial:string,status:string,label?:string,vendor?:string,model?:string}[]} */
        this._devices = [];
        /** @type {Map<string,{label:string,vendor:string,model:string,fetchedAt:number}>} */
        this._labels = new Map();
        /** @type {Map<string,Promise>} */
        this._labelFetches = new Map();
        this._pollTimer = null;
        this._pollPromise = null;
    }

    /** Begin polling the device list (safe to call multiple times). */
    start() {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(() => {
            this._poll().catch(e => {
                console.error('[android-dev-ext] DeviceManager poll failed:', e);
            });
        }, POLL_INTERVAL_MS);
        this._poll().catch(e => {
            console.error('[android-dev-ext] DeviceManager poll failed:', e);
        });
    }

    stop() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    /** @returns {{serial:string,status:string,label?:string}[]} */
    getDevices() {
        return this._devices;
    }

    /** @returns {{serial:string,status:string,label?:string}[]} */
    getUsableDevices() {
        return this._devices.filter(d => d.status === 'device');
    }

    getSelectedSerial() {
        const gs = this.context && this.context.globalState;
        return (gs && gs.get(STORAGE_KEY, '')) || '';
    }

    /**
     * Persist the device choice. The selection stays active until the device
     * disconnects (it is cleared automatically by the poller).
     * @param {string} serial
     */
    async selectDevice(serial) {
        const gs = this.context && this.context.globalState;
        if (gs) {
            await gs.update(STORAGE_KEY, serial || '');
        }
    }

    /**
     * The currently selected device, or null when no selection was made or the
     * selected device is no longer connected.
     */
    getSelectedDevice() {
        const serial = this.getSelectedSerial();
        if (!serial) return null;
        return this._devices.find(d => d.serial === serial) || null;
    }

    /**
     * Force a device-list refresh, waiting for any in-flight poll to finish.
     */
    async refresh() {
        if (this._pollPromise) {
            await this._pollPromise.catch(() => {});
        } else {
            await this._poll();
        }
    }

    async _poll() {
        if (this._pollPromise) return;
        const poll_task = (async () => {
            let devices;
            try {
                devices = await new ADBClient().list_devices();
            } catch (e) {
                // adb server not running / unreachable - treat as no devices
                devices = [];
            }
            const prev_key = this._devices.map(d => `${d.serial}:${d.status}`).join('|');
            const cur_key = devices.map(d => `${d.serial}:${d.status}`).join('|');
            this._devices = devices;
            // enrich labels in the background (emits 'devices-changed' when labels land)
            this._enrichDevices(devices);
            // forget a selection whose device has disconnected
            const selected = this.getSelectedSerial();
            if (selected && !devices.some(d => d.serial === selected)) {
                await this.selectDevice('');
            }
            if (prev_key !== cur_key) {
                this.emit('devices-changed', this._devices.slice());
            }
        })();
        this._pollPromise = poll_task;
        try {
            await poll_task;
        } finally {
            this._pollPromise = null;
        }
    }

    /**
     * Fetch brand/model labels for devices without a (fresh) cached label.
     * Mutates the device entries in place and emits 'devices-changed' when a
     * label was actually fetched.
     * @param {{serial:string,status:string,label?:string,vendor?:string,model?:string}[]} devices
     */
    async _enrichDevices(devices) {
        const now = Date.now();
        const to_fetch = [];
        for (const d of devices) {
            const cached = this._labels.get(d.serial);
            if (cached && now - cached.fetchedAt < LABEL_TTL_MS) {
                d.label = cached.label;
                d.vendor = cached.vendor;
                d.model = cached.model;
            } else {
                to_fetch.push(d);
            }
        }
        if (!to_fetch.length) return;
        const results = await Promise.all(to_fetch.map(d => this._fetchDeviceLabel(d.serial)));
        to_fetch.forEach((d, i) => {
            const info = results[i];
            this._labels.set(d.serial, {
                label: info.label,
                vendor: info.vendor,
                model: info.model,
                fetchedAt: Date.now(),
            });
            d.label = info.label;
            d.vendor = info.vendor;
            d.model = info.model;
        });
        this.emit('devices-changed', this._devices.slice());
    }

    /**
     * Build a display label for a device serial: "HUAWEI PGT-N10" (brand +
     * model), "(Emulator)" for emulators, falling back to the serial itself.
     * Concurrent fetches for the same serial are deduplicated.
     * @param {string} serial
     * @returns {Promise<{vendor:string,model:string,label:string}>}
     */
    _fetchDeviceLabel(serial) {
        let p = this._labelFetches.get(serial);
        if (!p) {
            p = (async () => {
                try {
                    const props = await new ADBClient(serial).get_device_props();
                    const name = props.marketname || props.model;
                    const vendor = props.brand || props.manufacturer;
                    // avoid "HUAWEI HUAWEI Mate 60 Pro" when the name already
                    // includes the vendor (brand is prefixed on many devices)
                    let label = (vendor && name && name.toLowerCase().startsWith(vendor.toLowerCase()))
                        ? name
                        : [vendor, name].filter(Boolean).join(' ') || serial;
                    if (/^emulator-/.test(serial)) {
                        label = name
                            ? `${name} (${i18n.localize('device.emulator', 'Emulator')})`
                            : i18n.localize('device.emulator', 'Emulator');
                    }
                    return { vendor, model: name, label };
                } catch (e) {
                    // device not responding (e.g. unauthorized) - use the serial
                    return { vendor: '', model: '', label: serial };
                }
            })();
            this._labelFetches.set(serial, p);
            p.finally(() => this._labelFetches.delete(serial));
        }
        return p;
    }

    /**
     * Resolve the device to use for an action.
     * Priority: persisted choice (still connected) -> single connected device ->
     * QuickPick (multiple devices). The chosen device is persisted until it
     * disconnects, so the picker only appears when the choice is unknown.
     * @param {import('vscode')} vscode
     * @param {string} action
     * @param {{alwaysShow?:boolean}} [options]
     * @returns {Promise<{serial:string,status:string,label?:string}|null>}
     */
    async resolveTargetDevice(vscode, action, options = {}) {
        await this.refresh();
        const devices = this.getUsableDevices();
        if (!devices.length) {
            vscode.window.showWarningMessage(i18n.localize('device.noDevices', '{0} failed. No Android devices are connected.', action));
            return null;
        }
        let device = null;
        if (options.alwaysShow) {
            device = await showDevicePicker(vscode, devices);
        } else {
            // the persisted choice, if it is still connected
            device = this.getSelectedDevice();
            // a single connected device is unambiguous - just use it
            if (!device && devices.length === 1) {
                device = devices[0];
            }
            // multiple devices and no (valid) persisted choice - ask the user
            if (!device) {
                device = await showDevicePicker(vscode, devices);
            }
        }
        if (!device) return null;    // user cancelled
        // the user might take a while in the picker - recheck the device exists
        if (!this.getUsableDevices().some(d => d.serial === device.serial)) {
            vscode.window.showInformationMessage(i18n.localize('device.disconnected', '{0} failed. The target device is disconnected.', action));
            return null;
        }
        // remember the choice until the device disconnects
        if (device.serial !== this.getSelectedSerial()) {
            await this.selectDevice(device.serial);
        }
        return device;
    }
}

/**
 * @param {import('vscode')} vscode
 * @param {{serial:string,status:string,label?:string}[]} devices
 */
async function showDevicePicker(vscode, devices) {
    const sorted_devices = devices.slice().sort((a, b) => a.serial.localeCompare(b.serial, undefined, { sensitivity: 'base' }));

    /** @type {import('vscode').QuickPickItem[]} */
    const quick_pick_items = sorted_devices
        .map(device => ({
            label: device.label || device.serial,
            description: device.serial,
        }));

    /** @type {import('vscode').QuickPickOptions} */
    const quick_pick_options = {
        canPickMany: false,
        placeHolder: i18n.localize('device.pickPlaceholder', 'Choose an Android device'),
    };

    const chosen_option = await vscode.window.showQuickPick(quick_pick_items, quick_pick_options);
    return sorted_devices[quick_pick_items.indexOf(chosen_option)] || null;
}

/**
 * Get the extension-wide DeviceManager singleton.
 * @param {import('vscode').ExtensionContext} [context]
 * @returns {DeviceManager}
 */
function getDeviceManager(context) {
    if (!_manager) {
        _manager = new DeviceManager(context);
    }
    return _manager;
}

/**
 * Backwards-compatible wrapper: resolves a device for the given action,
 * respecting the persisted choice (see DeviceManager.resolveTargetDevice).
 * @param {import('vscode')} vscode
 * @param {string} action
 * @param {{alwaysShow?:boolean}} [options]
 */
async function selectTargetDevice(vscode, action, options) {
    return getDeviceManager().resolveTargetDevice(vscode, action, options);
}

module.exports = {
    DeviceManager,
    getDeviceManager,
    selectTargetDevice,
    showDevicePicker,
}
