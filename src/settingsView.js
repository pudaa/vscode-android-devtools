'use strict'
/**
 * "Settings" sidebar view: visual editor for the android launch configuration.
 * Lets users toggle openLogcatAfterLaunch, pick apkFile/activity etc. without
 * hand-editing launch.json.
 *
 * Also hosts the target-device dropdown: the device list updates in real time
 * (ADB polling via DeviceManager), the choice is remembered until the device
 * disconnects, and the current selection is displayed.
 */
const vscode = require('vscode');
const { getAndroidLaunchConfig } = require('./controlView');
const { getDeviceManager } = require('./utils/device');
const i18n = require('./i18n');

class SettingsViewProvider {
    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this.context = context;
        this._view = null;
        this._deviceChangeListener = null;
    }

    async resolveWebviewView(webviewView) {
        console.log('[android-dev-ext] SettingsViewProvider.resolveWebviewView(): called');
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        const html = await this.render();
        console.log('[android-dev-ext] SettingsViewProvider.resolveWebviewView(): html length =', html.length);
        webviewView.webview.html = html;

        // keep the device dropdown in sync: plug in / unplug a device and the
        // options update in real time (only the dropdown is touched, so any
        // text field the user is editing keeps its focus)
        const manager = getDeviceManager(this.context);
        if (this._deviceChangeListener) {
            manager.removeListener('devices-changed', this._deviceChangeListener);
        }
        this._deviceChangeListener = () => this.pushDevices();
        manager.on('devices-changed', this._deviceChangeListener);
        webviewView.onDidDispose(() => {
            if (this._deviceChangeListener) {
                manager.removeListener('devices-changed', this._deviceChangeListener);
                this._deviceChangeListener = null;
            }
            this._view = null;
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'update':
                    await this.updateConfig(message.key, message.value);
                    webviewView.webview.html = await this.render();
                    break;
                case 'refresh':
                    webviewView.webview.html = await this.render();
                    break;
                case 'select-device':
                    // persist the choice - it is remembered until the device
                    // disconnects (the poller clears it automatically)
                    await manager.selectDevice(message.value || '');
                    this.pushDevices();
                    break;
            }
        });
    }

    /**
     * Send the current device list to the open webview (updates only the
     * dropdown + status line, preserving focus on any field being edited).
     */
    pushDevices() {
        const view = this._view;
        if (!view || !view.webview) return;
        const devices = getDeviceManager().getDevices().map(d => ({
            serial: d.serial,
            status: d.status,
            label: d.label || '',
        }));
        view.webview.postMessage({ command: 'devices-updated', devices });
    }

    /**
     * Update a field in the first android launch config in launch.json
     * @param {string} key
     * @param {*} value
     */
    async updateConfig(key, value) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return;
        const file = vscode.Uri.joinPath(folders[0].uri, '.vscode', 'launch.json');
        let configs;
        try {
            const raw = (await vscode.workspace.fs.readFile(file)).toString();
            configs = JSON.parse(raw);
        } catch (e) {
            vscode.window.showErrorMessage(i18n.localize('settings.cannotRead', 'Cannot read launch.json'));
            return;
        }
        const target = configs.configurations.find(c => c.type === 'android' && c.request === 'launch');
        if (!target) {
            vscode.window.showErrorMessage(i18n.localize('settings.noConfig', 'No android launch configuration in launch.json'));
            return;
        }
        target[key] = value;
        // keep the file pretty
        const text = JSON.stringify(configs, null, 4);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(file, new vscode.Range(0, 0, text.length + 1, 0), text);
        await vscode.workspace.applyEdit(edit);
    }

    async render() {
        const cfg = getAndroidLaunchConfig() || {};
        const openLogcat = cfg.openLogcatAfterLaunch === true;
        const waitDbg = cfg.waitForDebugger === true;
        const apk = cfg.apkFile || '';
        const activity = cfg.launchActivity || '';
        const adb = cfg.adbSocket || 'localhost:5037';
        const pmArgs = Array.isArray(cfg.pmInstallArgs) ? cfg.pmInstallArgs.join(' ') : '-r';
        const releaseTask = cfg.releaseGradleTask || '';
        const logcatFilter = cfg.logcatFilter || '';

        const manager = getDeviceManager(this.context);
        const deviceStatus = this.deviceStatusText(manager);
        const deviceOptions = this.deviceOptionsHtml(manager);

        return `<!DOCTYPE html><html><head><meta charset="utf8">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; margin:0; }
.field { margin: 8px 0; }
.field label { display:block; margin-bottom:4px; opacity:.85; }
.field input[type=text] { width:100%; box-sizing:border-box; padding:5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#444); border-radius:4px; }
.field select { width:100%; box-sizing:border-box; padding:5px 8px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border,#444); border-radius:4px; }
.check { display:flex; align-items:center; gap:8px; margin:8px 0; }
.check input { width:auto; }
.hint { font-size:.85em; opacity:.6; margin-top:2px; }
.btn { display:block; width:100%; margin-top:10px; padding:7px; border-radius:4px; border:none; background:var(--vscode-button-background); color:var(--vscode-button-foreground); cursor:pointer; }
.btn:hover { background:var(--vscode-button-hoverBackground); }
</style></head><body>
<div class="field">
  <label>${i18n.localize('settings.device', 'Target device')}</label>
  <select id="device">${deviceOptions}</select>
  <div id="deviceStatus" class="hint">${escapeHtml(deviceStatus)}</div>
  <div class="hint">${i18n.localize('settings.deviceHint', 'Used by Launch and Logcat. Auto-refreshes when devices connect or disconnect; the choice is remembered until the device disconnects.')}</div>
</div>
<div class="field">
  <label>${i18n.localize('settings.launchConfig', 'Launch configuration')}</label>
  <input type="text" id="cfgName" value="${escapeAttr(cfg.name || '')}" data-key="name"/>
</div>
<div class="check">
  <input type="checkbox" id="openLogcat" ${openLogcat ? 'checked' : ''} data-key="openLogcatAfterLaunch"/>
  <label for="openLogcat">${i18n.localize('settings.openLogcatAfterLaunch', 'Open Logcat after launch (no debugger)')}</label>
</div>
<div class="check">
  <input type="checkbox" id="waitDbg" ${waitDbg ? 'checked' : ''} data-key="waitForDebugger"/>
  <label for="waitDbg">${i18n.localize('settings.waitForDebugger', 'Launch with -D (wait for debugger, breakpoints from Application.onCreate)')}</label>
</div>
<div class="field">
  <label>${i18n.localize('settings.apkFile', 'APK file')}</label>
  <input type="text" data-key="apkFile" value="${escapeAttr(apk)}"/>
  <div class="hint">${i18n.localize('settings.apkFileHint', 'Path to the built debug APK')}</div>
</div>
<div class="field">
  <label>${i18n.localize('settings.launchActivity', 'Launch activity')}</label>
  <input type="text" data-key="launchActivity" value="${escapeAttr(activity)}"/>
  <div class="hint">${i18n.localize('settings.launchActivityHint', 'e.g. .ui.MainActivity (leave empty for launcher activity)')}</div>
</div>
<div class="field">
  <label>${i18n.localize('settings.adbSocket', 'ADB socket')}</label>
  <input type="text" data-key="adbSocket" value="${escapeAttr(adb)}"/>
</div>
<div class="field">
  <label>${i18n.localize('settings.pmInstallArgs', 'pm install args')}</label>
  <input type="text" data-key="pmInstallArgs" value="${escapeAttr(pmArgs)}"/>
  <div class="hint">${i18n.localize('settings.pmInstallArgsHint', 'space-separated, e.g. -r -d')}</div>
</div>
<div class="field">
  <label>${i18n.localize('settings.releaseGradleTask', 'Release gradle task')}</label>
  <input type="text" data-key="releaseGradleTask" value="${escapeAttr(releaseTask)}"/>
  <div class="hint">${i18n.localize('settings.releaseGradleTaskHint', 'Used by Build & Launch Release. Default: assembleRelease')}</div>
</div>
<div class="field">
  <label>${i18n.localize('settings.logcatFilter', 'Logcat filter')}</label>
  <input type="text" data-key="logcatFilter" value="${escapeAttr(logcatFilter)}"/>
  <div class="hint">${i18n.localize('settings.logcatFilterHint', 'Extra adb logcat args, e.g. --pid=1234 or -s MyTag:*')}</div>
</div>
<button class="btn" id="save">${i18n.localize('settings.save', 'Save to launch.json')}</button>
<script>
const vscode = acquireVsCodeApi();
const MSG_DEVICE_NONE = ${JSON.stringify(i18n.localize('settings.deviceNoDevice', 'No device connected'))};
const MSG_DEVICE_CURRENT = ${JSON.stringify(i18n.localize('settings.deviceStatusSelected', 'Current: {0}'))};
const MSG_DEVICE_NONE_SEL = ${JSON.stringify(i18n.localize('settings.deviceStatusNone', '{0} device(s) connected - pick one below'))};
function escHtml(s) {
    return String(s).replace(/[&"'<>]/g, c => ({'&':'&amp;','"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'}[c]));
}
function updateDeviceUi(devices) {
    const sel = document.getElementById('device');
    if (!sel) return;
    const prev = sel.value;
    const usable = devices.filter(d => d.status === 'device');
    let optionsHtml = '';
    if (!devices.length) {
        optionsHtml = '<option value="">' + escHtml(MSG_DEVICE_NONE) + '</option>';
    } else {
        devices.forEach(d => {
            const label = (d.label || d.serial) + (d.status === 'device' ? '' : ' (' + d.status + ')');
            const selected = d.serial === prev ? ' selected' : '';
            const disabled = d.status === 'device' ? '' : ' disabled';
            optionsHtml += '<option value="' + escHtml(d.serial) + '"' + selected + disabled + '>' + escHtml(label) + '</option>';
        });
    }
    sel.innerHTML = optionsHtml;
    // restore the previous selection if the device is still there
    if (prev && usable.some(d => d.serial === prev)) {
        sel.value = prev;
    }
    // status line: what is connected / which device is in use
    const statusEl = document.getElementById('deviceStatus');
    if (statusEl) {
        const chosen = sel.selectedOptions && sel.selectedOptions[0];
        if (chosen && chosen.value) {
            statusEl.textContent = MSG_DEVICE_CURRENT.replace('{0}', chosen.textContent);
        } else if (usable.length) {
            statusEl.textContent = MSG_DEVICE_NONE_SEL.replace('{0}', usable.length);
        } else {
            statusEl.textContent = MSG_DEVICE_NONE;
        }
    }
}
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg && msg.command === 'devices-updated') {
        updateDeviceUi(msg.devices || []);
    }
});
const deviceSel = document.getElementById('device');
if (deviceSel) {
    deviceSel.addEventListener('change', () => {
        vscode.postMessage({ command: 'select-device', value: deviceSel.value });
    });
}
const save = document.getElementById('save');
save.addEventListener('click', () => {
    document.querySelectorAll('input[data-key]').forEach(inp => {
        const key = inp.dataset.key;
        let val;
        if (inp.type === 'checkbox') {
            val = inp.checked;
        } else if (key === 'pmInstallArgs') {
            val = inp.value.trim() ? inp.value.trim().split(/\s+/) : ['-r'];
        } else {
            val = inp.value;
        }
        vscode.postMessage({ command: 'update', key, value: val });
    });
});
</script>
</body></html>`;
    }

    /**
     * Build the <option> list for the device dropdown.
     * @param {ReturnType<typeof getDeviceManager>} manager
     * @returns {string}
     */
    deviceOptionsHtml(manager) {
        const devices = manager.getDevices();
        if (!devices.length) {
            return `<option value="">${escapeHtml(i18n.localize('settings.deviceNoDevice', 'No device connected'))}</option>`;
        }
        const selected = manager.getSelectedSerial();
        let html = '';
        for (const d of devices) {
            const label = (d.label || d.serial) + (d.status === 'device' ? '' : ` (${d.status})`);
            const selectedAttr = d.serial === selected ? ' selected' : '';
            const disabledAttr = d.status === 'device' ? '' : ' disabled';
            html += `<option value="${escapeAttr(d.serial)}"${selectedAttr}${disabledAttr}>${escapeHtml(label)}</option>`;
        }
        return html;
    }

    /**
     * Status line under the dropdown: which device is in use / how many are connected.
     * @param {ReturnType<typeof getDeviceManager>} manager
     * @returns {string}
     */
    deviceStatusText(manager) {
        const devices = manager.getDevices();
        const usable = devices.filter(d => d.status === 'device');
        const selected = manager.getSelectedDevice();
        if (selected) {
            return i18n.localize('settings.deviceStatusSelected', 'Current: {0}', selected.label || selected.serial);
        }
        if (!usable.length) {
            return i18n.localize('settings.deviceNoDevice', 'No device connected');
        }
        return i18n.localize('settings.deviceStatusNone', '{0} device(s) connected - pick one below', usable.length);
    }
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(s) {
    return String(s).replace(/[&"'<>]/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]));
}

module.exports = {
    SettingsViewProvider,
};
