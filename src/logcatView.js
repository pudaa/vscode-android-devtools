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
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };

        // connect to the device (auto-pick if only one, else ask)
        const autoStartADB = true;
        try {
            await checkADBStarted(autoStartADB);
            const device = await selectTargetDevice(vscode, 'Logcat display');
            if (!device) {
                webviewView.webview.html = this.renderPlaceholder('No device connected');
                return;
            }
            currentDevice = device.serial;
            this._logcat = new LogcatContent(device.serial);
            const html = await this._logcat.content();
            webviewView.webview.html = html;
            this.attachMessageHandler(webviewView);
        } catch (e) {
            webviewView.webview.html = this.renderPlaceholder(`Logcat init failed: ${e.message}`);
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
                        this._logcat = new LogcatContent(device.serial);
                        const html = await this._logcat.content();
                        webviewView.webview.html = html;
                    }
                } catch (e) {
                    vscode.window.showInformationMessage(`Logcat refresh failed: ${e.message}`);
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
<div style="margin-top:12px"><button class="g" onclick="(function(){var v=acquireVsCodeApi();v.postMessage({command:'refresh'});})()">Retry / Refresh</button></div>
</body></html>`;
    }
}

module.exports = {
    LogcatViewProvider,
};
