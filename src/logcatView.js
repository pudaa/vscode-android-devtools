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
const { selectTargetDevice } = require('./utils/device');
const { getAndroidLaunchConfig } = require('./controlView');
const i18n = require('./i18n');

/**
 * Resolve the current app's package name for package:mine filtering.
 * Uses launch.json 'appId' if present, otherwise infers it from a fully
 * qualified launchActivity (e.g. com.example.app.MainActivity -> com.example.app).
 * @returns {string}
 */
function getAppPackageName() {
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
    return '';
}

/**
 * @type {Map<string, LogcatContent>}
 */
const viewInstances = new Map();

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

        // connect to the device (auto-pick if only one, else ask)
        const autoStartADB = true;
        try {
            console.log('[android-dev-ext] LogcatViewProvider: checking ADB...');
            const adbStarted = await checkADBStarted(autoStartADB);
            if (!adbStarted) {
                console.error('[android-dev-ext] LogcatViewProvider: ADB server could not be started');
                webviewView.webview.html = this.renderPlaceholder(i18n.localize('logcat.adbStartFailed', 'ADB server could not be started. Set ANDROID_HOME or add adb to PATH.'));
                return;
            }
            console.log('[android-dev-ext] LogcatViewProvider: ADB OK, selecting device...');
            const device = await selectTargetDevice(vscode, 'Logcat display');
            console.log('[android-dev-ext] LogcatViewProvider: device =', device && device.serial);
            if (!device) {
                webviewView.webview.html = this.renderPlaceholder(i18n.localize('logcat.noDevice', 'No device connected'));
                return;
            }
            currentDevice = device.serial;
            this._logcat = new LogcatContent(device.serial, {
                packageName: getAppPackageName(),
            });
            const html = await this._logcat.content();
            console.log('[android-dev-ext] LogcatViewProvider: logcat html length =', html.length);
            webviewView.webview.html = html;
            this.attachMessageHandler(webviewView);
        } catch (e) {
            console.error('[android-dev-ext] LogcatViewProvider.resolveWebviewView() failed:', e);
            webviewView.webview.html = this.renderPlaceholder(i18n.localize('logcat.initFailed', 'Logcat init failed: {0}', e.message));
        }
    }

    /**
     * Handle messages from the webview (e.g. refresh device, clear log)
     * @param {vscode.WebviewView} webviewView
     */
    attachMessageHandler(webviewView) {
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'refresh') {
                try {
                    const device = await selectTargetDevice(vscode, 'Logcat display');
                    if (device && device.serial !== currentDevice) {
                        currentDevice = device.serial;
                        this._logcat = new LogcatContent(device.serial, {
                            packageName: getAppPackageName(),
                        });
                        const html = await this._logcat.content();
                        webviewView.webview.html = html;
                    }
                } catch (e) {
                    vscode.window.showInformationMessage(i18n.localize('logcat.refreshFailed', 'Logcat refresh failed: {0}', e.message));
                }
            }
        });
    }

    /**
     * Simple placeholder page (device not connected / init failure)
     * @param {string} message
     */
    renderPlaceholder(message) {
        return `<!DOCTYPE html><html><head><meta charset="utf8"></head>
<body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px">
<div style="opacity:.8;font-size:.95em">${message}</div>
<div style="margin-top:12px"><button class="g" onclick="(function(){var v=acquireVsCodeApi();v.postMessage({command:'refresh'});})()">${i18n.localize('logcat.retry', 'Retry / Refresh')}</button></div>
</body></html>`;
    }
}

module.exports = {
    LogcatViewProvider,
};
