'use strict'
/**
 * "Settings" sidebar view: visual editor for the android launch configuration.
 * Lets users toggle openLogcatAfterLaunch, pick apkFile/activity etc. without
 * hand-editing launch.json.
 */
const vscode = require('vscode');
const { getAndroidLaunchConfig } = require('./controlView');
const i18n = require('./i18n');

class SettingsViewProvider {
    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this.context = context;
        this._view = null;
    }

    resolveWebviewView(webviewView) {
        console.log('[android-dev-ext] SettingsViewProvider.resolveWebviewView(): called');
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        const html = this.render();
        console.log('[android-dev-ext] SettingsViewProvider.resolveWebviewView(): html length =', html.length);
        webviewView.webview.html = html;

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'update':
                    await this.updateConfig(message.key, message.value);
                    webviewView.webview.html = this.render();
                    break;
                case 'refresh':
                    webviewView.webview.html = this.render();
                    break;
            }
        });
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

    render() {
        const cfg = getAndroidLaunchConfig() || {};
        const openLogcat = cfg.openLogcatAfterLaunch === true;
        const apk = cfg.apkFile || '';
        const activity = cfg.launchActivity || '';
        const adb = cfg.adbSocket || 'localhost:5037';
        const pmArgs = Array.isArray(cfg.pmInstallArgs) ? cfg.pmInstallArgs.join(' ') : '-r';

        return `<!DOCTYPE html><html><head><meta charset="utf8">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; margin:0; }
.field { margin: 8px 0; }
.field label { display:block; margin-bottom:4px; opacity:.85; }
.field input[type=text] { width:100%; box-sizing:border-box; padding:5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#444); border-radius:4px; }
.check { display:flex; align-items:center; gap:8px; margin:8px 0; }
.check input { width:auto; }
.hint { font-size:.85em; opacity:.6; margin-top:2px; }
.btn { display:block; width:100%; margin-top:10px; padding:7px; border-radius:4px; border:none; background:var(--vscode-button-background); color:var(--vscode-button-foreground); cursor:pointer; }
.btn:hover { background:var(--vscode-button-hoverBackground); }
</style></head><body>
<div class="field">
  <label>${i18n.localize('settings.launchConfig', 'Launch configuration')}</label>
  <input type="text" id="cfgName" value="${escapeAttr(cfg.name || '')}" data-key="name"/>
</div>
<div class="check">
  <input type="checkbox" id="openLogcat" ${openLogcat ? 'checked' : ''} data-key="openLogcatAfterLaunch"/>
  <label for="openLogcat">${i18n.localize('settings.openLogcatAfterLaunch', 'Open Logcat after launch (no debugger)')}</label>
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
<button class="btn" id="save">${i18n.localize('settings.save', 'Save to launch.json')}</button>
<script>
const vscode = acquireVsCodeApi();
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
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

module.exports = {
    SettingsViewProvider,
};
