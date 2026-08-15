'use strict'
/**
 * Logcat as a sidebar WebviewView (can also be dragged to the bottom panel as a tab).
 *
 * Reuses the existing LogcatContent backend (WebSocket push) - the webview's HTML
 * connects to the same WS server, so the streaming/push logic is unchanged.
 */
const vscode = require('vscode');
const { LogcatContent } = require('./logcat');
const { checkADBStarted } = require('./utils/android');
const { getDeviceManager } = require('./utils/device');
const { getAndroidLaunchConfig } = require('./controlView');
const { APKFileInfo } = require('./apk-file-info');
const i18n = require('./i18n');

/**
 * Resolve the current app's package name for package:mine filtering, in order:
 *   1. launch.json 'appId'
 *   2. fully qualified launchActivity (com.example.app.MainActivity -> com.example.app)
 *   3. the real package name parsed from the built APK manifest (reliable fallback)
 * @returns {Promise<string>}
 */
async function getAppPackageName() {
    const cfg = getAndroidLaunchConfig() || {};
    if (cfg.appId && typeof cfg.appId === 'string' && cfg.appId.trim()) {
        return cfg.appId.trim();
    }
    const act = (cfg.launchActivity || '').trim();
    if (act && !act.startsWith('.')) {
        const parts = act.split('.');
        if (parts.length >= 2) {
            return parts.slice(0, -1).join('.');
        }
    }
    if (cfg.apkFile) {
        try {
            const folders = vscode.workspace.workspaceFolders;
            const root = folders && folders[0] ? folders[0].uri.fsPath : '';
            const apk = String(cfg.apkFile)
                .replace(/\$\{workspaceRoot\}/g, root)
                .replace(/\$\{workspaceFolder\}/g, root);
            const info = await APKFileInfo.from({ apkFile: apk });
            if (info.manifest && info.manifest.package) {
                return info.manifest.package;
            }
        } catch (e) { /* APK missing/unreadable - package:mine falls back to all logs */ }
    }
    return '';
}

/**
 * @type {string|null} device serial currently attached to the view
 */
let currentDevice = null;

class LogcatViewProvider {
    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this.context = context;
        this._view = null;
        this._logcat = null;
        this._refreshing = false;
        this._deviceChangeListener = null;
    }

    /**
     * @param {vscode.WebviewView} webviewView
     * @param {vscode.WebviewViewResolveContext} _context
     * @param {vscode.CancellationToken} _token
     */
    async resolveWebviewView(webviewView, _context, _token) {
        console.log('[android-dev-ext] LogcatViewProvider.resolveWebviewView(): called');
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };

        // attach the message handler FIRST - the "Retry / Refresh" button on the
        // no-device placeholder must work even when no device is connected yet
        // (it used to be attached only after a successful device connection,
        // so clicking Retry with no device attached did nothing).
        this.attachMessageHandler(webviewView);

        // react to device plug/unplug: connect automatically when a device
        // appears, show the placeholder when it disappears
        const manager = getDeviceManager(this.context);
        if (!this._deviceChangeListener) {
            this._deviceChangeListener = () => this.onDevicesChanged();
            manager.on('devices-changed', this._deviceChangeListener);
        }
        webviewView.onDidDispose(() => this.dispose());

        await this.refreshDevice();
    }

    /**
     * Handle messages from the webview (e.g. refresh device)
     * @param {vscode.WebviewView} webviewView
     */
    attachMessageHandler(webviewView) {
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'refresh') {
                await this.refreshDevice();
            }
        });
    }

    /**
     * Connect (or reconnect) the view to a device. Resolves the device via the
     * DeviceManager (persisted choice / single device / picker), starts the
     * logcat stream and renders either the live logcat page or a placeholder.
     */
    async refreshDevice() {
        const view = this._view;
        if (!view) return;
        if (this._refreshing) return;
        this._refreshing = true;
        try {
            const autoStartADB = true;
            const adbStarted = await checkADBStarted(autoStartADB);
            if (!adbStarted) {
                console.error('[android-dev-ext] LogcatViewProvider: ADB server could not be started');
                await this.renderPlaceholder(view, i18n.localize('logcat.adbStartFailed', 'ADB server could not be started. Set ANDROID_HOME or add adb to PATH.'));
                return;
            }
            console.log('[android-dev-ext] LogcatViewProvider: ADB OK, selecting device...');
            const device = await getDeviceManager().resolveTargetDevice(vscode, 'Logcat display');
            console.log('[android-dev-ext] LogcatViewProvider: device =', device && device.serial);
            if (!device) {
                currentDevice = null;
                if (this._logcat) {
                    this._logcat.dispose();
                    this._logcat = null;
                }
                await this.renderPlaceholder(view, i18n.localize('logcat.noDevice', 'No device connected'));
                return;
            }
            if (device.serial === currentDevice && this._logcat) {
                // same device as before - only recover a dead stream, never
                // reset a healthy one (resetting would clear the frontend logs)
                if (this._logcat._state === 'disconnected') {
                    view.webview.html = await this._logcat.content();
                }
                return;
            }
            // switching to a different device - tear down the old monitor first
            if (this._logcat) {
                this._logcat.dispose();
                this._logcat = null;
            }
            currentDevice = device.serial;
            this._logcat = new LogcatContent(device.serial, {
                packageName: await getAppPackageName(),
            });
            const html = await this._logcat.content();
            console.log('[android-dev-ext] LogcatViewProvider: logcat html length =', html.length);
            view.webview.html = html;
        } catch (e) {
            console.error('[android-dev-ext] LogcatViewProvider.refreshDevice() failed:', e);
            await this.renderPlaceholder(view, i18n.localize('logcat.initFailed', 'Logcat init failed: {0}', e.message));
        } finally {
            this._refreshing = false;
        }
    }

    /**
     * Called whenever the connected-device set changes (device plugged in /
     * unplugged). Auto-connects the view or shows the placeholder.
     */
    async onDevicesChanged() {
        if (!this._view) return;
        await this.refreshDevice();
    }

    /**
     * Simple placeholder page (device not connected / init failure)
     * @param {vscode.WebviewView} view
     * @param {string} message
     */
    async renderPlaceholder(view, message) {
        view.webview.html = `<!DOCTYPE html><html><head><meta charset="utf8"></head>
<body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px">
<div style="opacity:.8;font-size:.95em">${escapeHtml(message)}</div>
<div style="margin-top:12px"><button class="g" onclick="(function(){var v=acquireVsCodeApi();v.postMessage({command:'refresh'});})()">${i18n.localize('logcat.retry', 'Retry / Refresh')}</button></div>
<div style="margin-top:8px;opacity:.55;font-size:.85em">${i18n.localize('logcat.autoRetryHint', 'Connect a device - the view refreshes automatically.')}</div>
</body></html>`;
    }

    /**
     * Release resources when the view is closed.
     */
    dispose() {
        if (this._deviceChangeListener) {
            getDeviceManager().removeListener('devices-changed', this._deviceChangeListener);
            this._deviceChangeListener = null;
        }
        if (this._logcat) {
            this._logcat.dispose();
            this._logcat = null;
        }
        currentDevice = null;
        this._view = null;
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&"'<>]/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]));
}

module.exports = {
    LogcatViewProvider,
};
