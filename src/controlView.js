'use strict'
/**
 * "Launch" sidebar view: visual config summary + one-click run buttons.
 * Provides buttons to launch the app (logcat-only or debug) without touching
 * launch.json every time.
 */
const vscode = require('vscode');
const { AndroidContentProvider } = require('./contentprovider');
const { openLogcatWindow } = require('./logcat');
const i18n = require('./i18n');

/**
 * Read the current android launch configuration from launch.json (first match)
 */
function getAndroidLaunchConfig() {
    const configs = vscode.workspace.getConfiguration('launch.configurations');
    for (let i = 0; ; i++) {
        const config = configs.get(`${i}`);
        if (!config) break;
        if (config.type === 'android' && config.request === 'launch') {
            return config;
        }
    }
    return null;
}

class LaunchViewProvider {
    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this.context = context;
        this._view = null;
    }

    /**
     * @param {vscode.WebviewView} webviewView
     */
    resolveWebviewView(webviewView) {
        console.log('[android-dev-ext] LaunchViewProvider.resolveWebviewView(): called');
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        const html = this.render();
        console.log('[android-dev-ext] LaunchViewProvider.resolveWebviewView(): html length =', html.length);
        webviewView.webview.html = html;

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'refresh':
                    webviewView.webview.html = this.render();
                    break;
                case 'launch-logcat':
                    // install + launch + open logcat - independent of the debug session
                    await vscode.commands.executeCommand('android-dev-ext.launchApp');
                    break;
                case 'launch-release':
                    // build the RELEASE variant and launch it (no debugging)
                    await vscode.commands.executeCommand('android-dev-ext.launchRelease');
                    break;
                case 'launch-debug':
                    await vscode.commands.executeCommand('workbench.action.debug.start');
                    break;
                case 'open-launchjson':
                    await this.openLaunchJson();
                    break;
                case 'open-logcat':
                    await openLogcatWindow(vscode);
                    break;
            }
        });
    }

    /**
     * Run the app and auto-open logcat, without entering debug mode.
     * It launches the currently selected android launch config (debug session)
     * with openLogcatAfterLaunch forced on by temporarily editing? -> simpler:
     * we execute the F5 launch; if the config has openLogcatAfterLaunch it will
     * behave as logcat-only. If not, we fall back to openLogcatWindow after start.
     */
    async launchWithLogcat() {
        const config = getAndroidLaunchConfig();
        if (!config) {
            vscode.window.showErrorMessage(i18n.localize('logcat.launchFailed', 'No Android launch configuration found. Add one in launch.json first.'));
            return;
        }
        if (config.openLogcatAfterLaunch) {
            // config already handles it
            await vscode.commands.executeCommand('workbench.action.debug.start');
        } else {
            // launch, then open logcat panel manually
            await vscode.commands.executeCommand('workbench.action.debug.start');
            // give the app a moment to start, then open logcat
            setTimeout(() => openLogcatWindow(vscode), 1500);
        }
    }

    async openLaunchJson() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return;
        const file = vscode.Uri.joinPath(folders[0].uri, '.vscode', 'launch.json');
        try {
            await vscode.workspace.fs.stat(file);
        } catch {
            // create default launch.json
            const defaultConfig = {
                version: '0.2.0',
                configurations: [{
                    type: 'android',
                    request: 'launch',
                    name: 'Launch App & View Logcat',
                    preLaunchTask: '',
                    openLogcatAfterLaunch: true,
                    appSrcRoot: '${workspaceRoot}/app/src/main',
                    apkFile: '${workspaceRoot}/app/build/outputs/apk/debug/app-debug.apk',
                    adbSocket: 'localhost:5037',
                    autoStartADB: true,
                    pmInstallArgs: ['-r'],
                    postLaunchPause: 1000,
                }],
            };
            await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(defaultConfig, null, 4), 'utf8'));
        }
        await vscode.commands.executeCommand('vscode.open', file);
    }

    /**
     * Build the view HTML (inline styles using VS Code theme variables)
     */
    render() {
        const config = getAndroidLaunchConfig();
        const cfg = config || {};
        const appName = cfg.name || i18n.localize('control.noConfig', '(no android launch config)');
        const openLogcatFlag = cfg.openLogcatAfterLaunch === true;
        const apk = cfg.apkFile || '';
        const activity = cfg.launchActivity || '';

        return `<!DOCTYPE html><html><head><meta charset="utf8">
<style>
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 10px; margin:0; }
.card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #444); border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
.card h3 { margin: 0 0 8px 0; font-size: 1em; font-weight: 600; }
.row { display: flex; align-items: center; margin: 4px 0; gap: 8px; }
.row .label { flex: 0 0 72px; opacity: .75; }
.row .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn { display: block; width: 100%; box-sizing: border-box; margin: 6px 0; padding: 8px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 1em; text-align:center; }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.badge { display:inline-block; padding: 1px 8px; border-radius: 10px; font-size: .85em; }
.badge.on { background: var(--vscode-inputValidation-infoBackground, #125); color: var(--vscode-inputValidation-infoForeground, #6cf); }
.badge.off { background: var(--vscode-inputValidation-warningBackground, #531); color: var(--vscode-inputValidation-warningForeground, #fc0); }
</style></head><body>
<div class="card">
  <h3>${i18n.localize('control.config', 'Android App')}</h3>
  <div class="row"><span class="label">${i18n.localize('control.configValue', 'Config')}</span><span class="value">${escapeHtml(appName)}</span></div>
  <div class="row"><span class="label">${i18n.localize('control.logcatMode', 'Logcat')}</span><span class="badge ${openLogcatFlag ? 'on' : 'off'}">${openLogcatFlag ? i18n.localize('control.logcatAuto', 'auto-open') : i18n.localize('control.logcatManual', 'manual')}</span></div>
  <div class="row"><span class="label">${i18n.localize('control.apk', 'APK')}</span><span class="value">${escapeHtml(apk || '—')}</span></div>
  <div class="row"><span class="label">${i18n.localize('control.activity', 'Launch')}</span><span class="value">${escapeHtml(activity || i18n.localize('control.launcherActivity', 'launcher activity'))}</span></div>
</div>

<button class="btn" id="btnLogcat" data-cmd="launch-logcat">${i18n.localize('control.btnLaunchLogcat', '▶ Launch + Logcat')}</button>
<button class="btn" id="btnDebug" data-cmd="launch-debug">${i18n.localize('control.btnLaunchDebug', 'Debug Launch')}</button>
<button class="btn secondary" id="btnRelease" data-cmd="launch-release">${i18n.localize('control.btnLaunchRelease', 'Build & Launch Release')}</button>
<button class="btn secondary" id="btnOpenLogcat" data-cmd="open-logcat">${i18n.localize('control.btnViewLogcat', 'View Logcat')}</button>
<button class="btn secondary" id="btnLaunchJson" data-cmd="open-launchjson">${i18n.localize('control.btnEditLaunchJson', 'Edit launch.json')}</button>

<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('button[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ command: btn.dataset.cmd }));
});
</script>
</body></html>`;
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

module.exports = {
    LaunchViewProvider,
    getAndroidLaunchConfig,
};
