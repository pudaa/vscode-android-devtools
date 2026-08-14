'use strict'
// node and external modules
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocketServer = require('ws').Server;
// our stuff
const { ADBClient } = require('./adbclient');
const { AndroidContentProvider } = require('./contentprovider');
const { D } = require('./utils/print');

// Lazy i18n - logcat.js is also loaded by the debug adapter process where the
// 'vscode' module is unavailable, so the require must be guarded.
let _i18n = null;
try { _i18n = require('./i18n'); } catch (e) { /* not inside the extension host */ }
function loc(key, def, ...args) {
    return (_i18n && typeof _i18n.localize === 'function') ? _i18n.localize(key, def, ...args) : def;
}

/**
 * WebSocketServer instance
 * @type {WebSocketServer}
 */
let Server = null;

/**
 * Promise resolved once the WebSocketServer is listening
 * @type {Promise}
 */
let wss_inited;

/**
 * hashmap of all LogcatContent instances, keyed on device id
 * @type {Map<string, LogcatContent>}
 */
const LogcatInstances = new Map();

/**
 * Class to manage logcat data transferred between device and a WebView.
 * 
 * Each LogcatContent instance receives logcat lines via ADB, formats them into
 * HTML and sends them to a WebSocketClient running within a WebView page.
 * 
 * The order goes:
 *   - a new LogcatContent instance is created
 *   - if this is the first instance, create the WebSocketServer
 *   - set up handlers to receive logcat messages from ADB
 *   - upon the first get content(), return the templated HTML page - this is designed to bootstrap the view and create a WebSocket client.
 *   - when the client connects, start sending logcat messages over the websocket
 */
class LogcatContent {

    /**
     * @param {string} deviceid 
     * @param {{packageName?:string, filterMode?:string}} [options]
     */
    constructor(deviceid, options = {}) {
        this._logcatid = deviceid;
        this._logs = [];
        this._htmllogs = [];
        this._oldhtmllogs = [];
        this._notifying = 0;
        this._refreshRate = 200;    // ms
        this._state = 'connecting';
        this._htmltemplate = '';
        // Optional logcat filter (from launch.json 'logcatFilter', e.g. '--pid=1234' or '-s MyTag:*').
        // Defaults to empty = no filtering (full device log).
        this._filter = AndroidContentProvider.getLaunchConfigSetting('logcatFilter', '');
        // package:mine support (like Android Studio's Logcat): only show logs from
        // the current app's processes. Package name comes from launch.json 'appId'
        // (or is inferred from launchActivity by the caller). filterMode:
        //   'all'  = no package filter (whole device)
        //   'mine' = only the current app (default when a package name is known)
        this._packageName = String(options.packageName !== undefined ? options.packageName : AndroidContentProvider.getLaunchConfigSetting('appId', '') || '').trim();
        this._filterMode = options.filterMode || (this._packageName ? 'mine' : 'all');
        // specific process selected via the toolbar process dropdown ('process' mode)
        this._processPid = null;
        // the pids currently applied to the running logcat (package:mine mode);
        // used to detect app restarts and drop the filter when the app exits
        this._activePids = [];
        // true while the monitor is being torn down for a filter/mode switch -
        // suppresses "Device disconnected" notifications during the swap
        this._restarting = false;
        // pending poll timer for package:mine auto-recovery (app not running yet)
        this._pidRetryTimer = null;
        this._adbclient = new ADBClient(deviceid);
        this._initwait = this.initialise();
        LogcatInstances.set(this._logcatid, this);
    }

    /**
     * Ensures the websocket server is initialised and sets up
     * logcat handlers for ADB.
     * Once everything is ready, returns the initial HTML bootstrap content
     * @returns {Promise<string>}
     */
    async initialise() {
        try {
            // create the WebSocket server instance
            await initWebSocketServer();
            // register handlers for logcat
            const filter = await this.buildFilterArgs();
            await this._adbclient.startLogcatMonitor({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
                filter,
            });
            this._state = 'connected';
            this._initwait = null;
        } catch (err) {
            return loc('logcat.initFailedContent', 'Logcat initialisation failed: {0}', err.message);
        }
        // retrieve the initial content
        return this.content();
    }

    /**
     * @returns {Promise<string>}
     */
    async content() {
        if (this._initwait) return this._initwait;
        if (this._state !== 'disconnected')
            return this.htmlBootstrap({connected:true, status:'',oldlogs:''});
        // if we're in the disconnected state, and this.content is called, it means the user has requested
        // this logcat again - check if the device has reconnected
        return this._initwait = this.tryReconnect();
    }

    async tryReconnect() {
        // clear the logs first - if we successfully reconnect, we will be retrieving the entire logcat again
        const prevlogs = {_logs: this._logs, _htmllogs: this._htmllogs, _oldhtmllogs: this._oldhtmllogs };
        this._logs = []; this._htmllogs = []; this._oldhtmllogs = [];
        try {
            const filter = await this.buildFilterArgs();
            await this._adbclient.startLogcatMonitor({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
                filter,
            })
            // we successfully reconnected
            this._state = 'connected';
            this._initwait = null;
            return this.content();
        } catch(err) {
            // reconnection failed - put the logs back and return the cached info
            this._logs = prevlogs._logs;
            this._htmllogs = prevlogs._htmllogs;
            this._oldhtmllogs = prevlogs._oldhtmllogs;
            this._initwait = null;
            const cached_content = this.htmlBootstrap({
                connected: false,
                status: loc('logcat.disconnected', 'Device disconnected'),
                oldlogs: this._oldhtmllogs.join(os.EOL),
            });
            return cached_content;
        }
    }

    /**
     * Retrieve the PIDs belonging to the given package. There may be several (the
     * main process plus ':webview', ':remote' etc. child processes).
     * Uses a THROWAWAY ADBClient: this._adbclient holds the long-lived logcat
     * stream socket, so reusing it here (e.g. from the pid poll) would reset
     * the socket and kill the logcat stream.
     * @param {string} pkg
     * @returns {Promise<string[]>}
     */
    async getAppPids(pkg) {
        try {
            const out = await new ADBClient(this._logcatid).shell_cmd({ command: `pidof ${pkg}`, untilclosed: true }, 8000);
            return String(out).trim().split(/\s+/).filter(x => x && /^\d+$/.test(x));
        } catch (e) {
            return [];
        }
    }

    /**
     * Build the effective logcat filter arguments for the current filter mode.
     * 'mine' => '--pid=<app pids...>' (package:mine, like Android Studio),
     * merged with any static logcatFilter from launch.json.
     * When the app is not running yet, fall back to NO pid filter (full device
     * log) instead of '-s' (silent) - '-s' with no tag matches shows only the
     * "beginning of main/system" markers and nothing else, which looks broken.
     * The pid poll then restarts the monitor automatically once the app starts.
     * @returns {Promise<string>}
     */
    async buildFilterArgs() {
        const static_filter = (this._filter || '').trim();
        let pid_args = '';
        if (this._filterMode === 'mine' && this._packageName) {
            const pids = await this.getAppPids(this._packageName);
            if (pids.length) {
                // app is running - cancel any pending retry and filter by pid
                this.schedulePidRetry(true);
                this._activePids = pids;
                pid_args = pids.map(p => `--pid=${p}`).join(' ');
            } else {
                // app not running yet: show everything for now, but keep polling
                // so the filter switches to package:mine once the app comes up
                this._activePids = [];
                this.schedulePidRetry(true);
            }
        } else if (this._filterMode === 'process' && this._processPid) {
            pid_args = `--pid=${this._processPid}`;
        }
        return pid_args ? (static_filter + ' ' + pid_args).trim() : static_filter;
    }

    /**
     * Schedule (or cancel) a poll that keeps package:mine filtering in sync with
     * the app process. While filterMode is 'mine' the poll runs continuously:
     *   - app not running        -> show everything, poll every 2s
     *   - app running, no filter -> switch to --pid=<pids>
     *   - app pid changed        -> restart monitor with the new pids
     *   - app exited             -> drop the pid filter (show everything again)
     * This makes the view robust to app restarts (and to the view being opened
     * before the app has started) instead of silently freezing on an empty log.
     * @param {boolean} need true = app not running, keep polling
     */
    schedulePidRetry(need) {
        if (this._pidRetryTimer) {
            clearTimeout(this._pidRetryTimer);
            this._pidRetryTimer = null;
        }
        if (!need) return;
        this._pidRetryTimer = setTimeout(async () => {
            this._pidRetryTimer = null;
            if (this._filterMode !== 'mine' || !this._packageName) return;
            const pids = await this.getAppPids(this._packageName);
            const current_pids = (this._activePids || []).join(',');
            const new_pids = pids.join(',');
            try {
                if (pids.length && new_pids !== current_pids) {
                    // app came up (or restarted): switch to package:mine filtering
                    await this.restartMonitor();
                } else if (!pids.length && current_pids) {
                    // app exited: drop the pid filter so the log stays visible
                    this._activePids = [];
                    await this.restartMonitor();
                } else if (!pids.length && !current_pids) {
                    // still not running - keep polling
                    this.schedulePidRetry(true);
                }
            } catch (e) {
                this.schedulePidRetry(true);
            }
        }, 2000);
    }

    /**
     * Restart the logcat monitor with the current filter mode. Called when the
     * user toggles between "all logs" and "package:mine".
     */
    async restartMonitor() {
        // suppress "Device disconnected" from the old monitor while we swap
        this._restarting = true;
        try {
            try {
                await this._adbclient.endLogcatMonitor();
            } catch (e) { /* ignore */ }
            this._state = 'connecting';
            const filter = await this.buildFilterArgs();
            await this._adbclient.startLogcatMonitor({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
                filter,
            });
            this._state = 'connected';
            // keep package:mine in sync with the app lifecycle
            if (this._filterMode === 'mine' && this._packageName) {
                this.schedulePidRetry(true);
            }
            // tell every client the filter changed (frontend can refresh its UI)
            this.sendClientMessage(':filter_updated');
        } finally {
            this._restarting = false;
        }
    }

    /**
     * Switch the logcat filter mode ('all' | 'mine') and restart the monitor.
     * @param {string} mode
     */
    async setFilterMode(mode) {
        if (mode !== 'all' && mode !== 'mine') {
            return;
        }
        this._filterMode = mode;
        this._processPid = null;
        this._activePids = [];
        if (this._pidRetryTimer) {
            clearTimeout(this._pidRetryTimer);
            this._pidRetryTimer = null;
        }
        try {
            await this.restartMonitor();
        } catch (err) {
            this._state = 'disconnected';
            this.sendDisconnectMsg();
        }
    }

    /**
     * Filter logcat to a single debug process (Android Studio style process picker).
     * @param {string} pid
     */
    async setProcess(pid) {
        if (!/^\d+$/.test(pid)) {
            return;
        }
        this._filterMode = 'process';
        this._processPid = pid;
        this._activePids = [];
        if (this._pidRetryTimer) {
            clearTimeout(this._pidRetryTimer);
            this._pidRetryTimer = null;
        }
        try {
            await this.restartMonitor();
        } catch (err) {
            this._state = 'disconnected';
            this.sendDisconnectMsg();
        }
    }

    /**
     * Send the list of named debuggable processes to the requesting client so the
     * toolbar process dropdown can be populated.
     * @param {import('ws').WebSocket} client
     */
    async listProcesses(client) {
        try {
            const named = await new ADBClient(this._logcatid).named_jdwp_list(2000);
            if (client && client.readyState === 1) {
                client.send('!processes:' + JSON.stringify(named.filter(p => p && p.name)));
            }
        } catch (e) { /* ignore - dropdown just stays with the fixed options */ }
    }

    sendClientMessage(msg) {
        const clients = [...Server.clients].filter(client => client['_logcatid'] === this._logcatid);
        clients.forEach(client => client.send(msg+'\n'));   // include a newline to try and persuade a buffer write
    }

    sendDisconnectMsg() {
        this.sendClientMessage(':disconnect');
    }

    onClientConnect(client) {
        if (this._oldhtmllogs.length) {
            const lines = '<div class="logblock">' + this._oldhtmllogs.join(os.EOL) + '</div>';
            client.send(lines);
        }
        // if the window is tabbed away and then returned to, vscode assumes the content
        // has not changed from the original bootstrap. So it proceeds to load the html page (with no data),
        // causing a connection to the WSServer as if the connection is still valid (which it was, originally).
        // If it's not, tell the client (again) that the device has disconnected
        if (this._state === 'disconnected')
            this.sendDisconnectMsg();
    }

    onClientMessage(client, message) {
        if (message === 'cmd:clear_logcat') {
            if (this._state !== 'connected') return;
            new ADBClient(this._adbclient.deviceid).shell_cmd({command:'logcat -c'})
                .then(() => {
                    // clear everything and tell the clients
                    this._logs = []; this._htmllogs = []; this._oldhtmllogs = [];
                    this.sendClientMessage(':logcat_cleared');
                })
                .catch(e => {
                    D('Clear logcat command failed: ' + e.message);
                })
        } else if (message === 'cmd:set_filter:all' || message === 'cmd:set_filter:mine') {
            // package:mine toggle (Android Studio style)
            this.setFilterMode(message === 'cmd:set_filter:mine' ? 'mine' : 'all');
        } else if (message.startsWith('cmd:set_process:')) {
            this.setProcess(message.slice('cmd:set_process:'.length));
        } else if (message === 'cmd:list_processes') {
            this.listProcesses(client);
        } else if (message === 'cmd:export_logcat') {
            this.exportLogcat();
        }
    }

    /**
     * Export the buffered logcat lines to a file via a VS Code save dialog.
     * No-op when not running inside the extension host (e.g. debug adapter).
     */
    async exportLogcat() {
        let vscode;
        try {
            vscode = require('vscode');
        } catch (e) {
            return; // not inside the extension host
        }
        try {
            // _oldhtmllogs holds the most recent lines (newest-first) as HTML
            // fragments; strip the tags and un-escape to get plain text lines.
            const texts = this._oldhtmllogs
                .map(h => String(h).replace(/<[^>]*>/g, ''))
                .map(s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
                .reverse(); // oldest first, matching log order
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`logcat-${this._logcatid}-${stamp}.txt`),
                filters: { 'Logcat': ['txt', 'log'] },
            });
            if (!uri) return;
            await vscode.workspace.fs.writeFile(uri, Buffer.from(texts.join('\n') + '\n', 'utf8'));
            vscode.window.showInformationMessage(loc('logcat.exported', 'Logcat exported to {0}', uri.fsPath));
        } catch (e) {
            D('Export logcat failed: ' + (e && e.message));
        }
    }

    updateLogs() {
        // no point in formatting the data if there are no connected clients
        const clients = [...Server.clients].filter(client => client['_logcatid'] === this._logcatid);
        if (clients.length) {
            const lines = '<div class="logblock">' + this._htmllogs.join('') + '</div>';
            clients.forEach(client => client.send(lines));
        }
        // once we've updated all the clients, discard the info
        // (kept small to bound memory usage; the frontend also caps its own DOM rows)
        this._oldhtmllogs = this._htmllogs.concat(this._oldhtmllogs).slice(0, 2500);
        this._htmllogs = [], this._logs = [];
    }

    htmlBootstrap(vars) {
        if (!this._htmltemplate)
            this._htmltemplate = fs.readFileSync(path.join(__dirname,'res/logcat.html'), 'utf8');
        // log direction preference: false = terminal style (new lines at the
        // bottom, the default), true = Android Studio style (newest at the top)
        let newestFirst = false;
        try {
            const vscode = require('vscode');
            const cfg = vscode.workspace.getConfiguration('android-dev-ext');
            newestFirst = cfg.get('logcatNewestFirst', false) === true;
        } catch (e) { /* not inside the extension host */ }
        vars = Object.assign({
            logcatid: this._logcatid,
            wssport: Server.options.port,
            lNewestFirst: newestFirst,
            lFilterPlaceholder: loc('logcat.filterPlaceholder', 'Filter regex (e.g. word|error)'),
            lFilterTitle: loc('logcat.filterTitle', 'Filter regex'),
            lPause: loc('logcat.pause', 'Pause / resume'),
            lAutoScroll: loc('logcat.autoScroll', 'Auto-scroll to newest'),
            lClear: loc('logcat.clear', 'Clear logcat'),
            lLevel: loc('logcat.level', 'Level:'),
            lShown: loc('logcat.shown', 'shown {0} / {1}'),
            lConnecting: loc('logcat.connecting', 'Connecting...'),
            lConnectionError: loc('logcat.connectionError', 'Connection error'),
            lInvalidRegex: loc('logcat.invalidRegex', 'Invalid regular expression'),
            lFilterAll: loc('logcat.filterAll', 'All logs'),
            lFilterMine: loc('logcat.filterMine', 'package:mine'),
            lFilterModeTitle: loc('logcat.filterModeTitle', 'Show all logs or only the current app'),
            lFilterMode: this._filterMode,
            lColTime: loc('logcat.colTime', 'Time'),
            lColLevel: loc('logcat.colLevel', 'Lvl'),
            lColPid: loc('logcat.colPid', 'PID'),
            lColTid: loc('logcat.colTid', 'TID'),
            lColTag: loc('logcat.colTag', 'Tag'),
            lColMessage: loc('logcat.colMessage', 'Message'),
            lWaitingLogs: loc('logcat.waitingLogs', 'Waiting for logs...'),
            lExport: loc('logcat.export', 'Export logcat'),
            lProcessTitle: loc('logcat.processTitle', 'Filter logs'),
            lColumns: loc('logcat.columns', 'Columns'),
        }, vars);
        // simple value replacement using !{name} as the placeholder
        // (use ?? '' instead of || '' so false/0 values are preserved - a
        // false boolean rendered as '' would break the inline JS, e.g.
        // "var newestFirst =  === true" is a syntax error and kills the whole
        // webview script)
        const html = this._htmltemplate.replace(/!\{(.*?)\}/g, (match,expr) => {
            const v = vars[expr.trim()];
            return (v === undefined || v === null) ? '' : '' + v;
        });
        return html;
    }
    renotify() {
        if (++this._notifying > 1) return;
        this.updateLogs();
        setTimeout(() => {
            if (--this._notifying) {
                this._notifying = 0;
                this.renotify();
            }
        }, this._refreshRate);
    }
    onLogcatContent(e) {
        if (e.logs.length) {
            const mrlast = e.logs.slice();
            this._logs = this._logs.concat(mrlast);
            mrlast.forEach(log => {
                if (!(log = log.trim())) return;
                // replace html-interpreted chars
                const m = log.match(/^\d\d-\d\d\s+?\d\d:\d\d:\d\d\.\d+?\s+?(.)/);
                const style = (m && m[1]) || '';
                log = log.replace(/[&"'<>]/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]));
                this._htmllogs.unshift(`<div class="log ${style}">${log}</div>`);
                
            });
            this.renotify();
        }
    }
    onLogcatDisconnect(/*e*/) {
        if (this._state === 'disconnected') return;
        // ignore disconnects caused by an in-progress filter/mode switch - the
        // monitor is being restarted, not actually lost
        if (this._restarting) return;
        this._state = 'disconnected';
        this.sendDisconnectMsg();
    }
}

function initWebSocketServer() {
    if (wss_inited) {
        // already inited
        return wss_inited;
    }

    // retrieve the logcat websocket port
    const default_wssport = 7038;
    let start_port = AndroidContentProvider.getLaunchConfigSetting('logcatPort', default_wssport);
    if (typeof start_port !== 'number' || start_port <= 0 || start_port >= 65536 || start_port !== (start_port|0)) {
        start_port = default_wssport;
    }

    wss_inited = new Promise((resolve, reject) => {
        let retries = 100;
        tryCreateWebSocketServer(start_port, retries, (err, server) => {
            if (err) {
                wss_inited = null;
                reject(err);
            } else {
                Server = server;
                resolve();
            }
        });
    });
    return wss_inited;
}

/**
 * 
 * @param {number} port 
 * @param {number} retries 
 * @param {(err,server?) => void} cb 
 */
function tryCreateWebSocketServer(port, retries, cb) {
    const wsopts = {
        host: '127.0.0.1',
        port,
        clientTracking: true,
    };
    new WebSocketServer(wsopts)
        .on('listening', function() {
            cb(null, this);
        })
        .on('connection', (client, req) => {
            onWebSocketClientConnection(client, req);
        })
        .on('error', err => {
            if (retries <= 0) {
                cb(err);
            } else {
                tryCreateWebSocketServer(port + 1, retries - 1, cb);
            }
        })
}

function onWebSocketClientConnection(client, req) {
    // the client uses the url path to signify which logcat data it wants
    client._logcatid = req.url.match(/^\/?(.*)$/)[1];
    const lc = LogcatInstances.get(client._logcatid);
    if (!lc) {
        client.close();
        return;
    }
    lc.onClientConnect(client);
    client.on('message', function(message) {
        const lc = LogcatInstances.get(this._logcatid);
        if (lc) {
            lc.onClientMessage(this, message);
        }
    }.bind(client));

    // try and make sure we don't delay writes
    client._socket && typeof(client._socket.setNoDelay)==='function' && client._socket.setNoDelay(true);
}

/**
 * DEPRECATED: the sidebar Logcat view (android-devtools.logcat) is used instead
 * of a separate webview panel. Kept only for reference.
 * @param {import('vscode')} vscode 
 * @param {*} target_device 
 */
function openWebviewLogcatWindow(vscode, target_device) {
    const panel = vscode.window.createWebviewPanel(
        'androidlogcat', // Identifies the type of the webview. Used internally
        `logcat-${target_device.serial}`, // Title of the panel displayed to the user
        vscode.ViewColumn.Two, // Editor column to show the new webview panel in.
        {
            enableScripts: true,    // we use embedded scripts to relay logcat info over a websocket
        }
    );
    const logcat = new LogcatContent(target_device.serial);
    logcat.content().then(html => {
        panel.webview.html = html;
    });
}

/**
 * DEPRECATED: legacy previewHtml fallback - kept only for reference.
 * @param {import('vscode')} vscode 
 * @param {*} target_device 
 */
function openPreviewHtmlLogcatWindow(vscode, target_device) {
    const uri = AndroidContentProvider.getReadLogcatUri(target_device.serial);
    vscode.commands.executeCommand("vscode.previewHtml", uri, vscode.ViewColumn.Two);
}

/**
 * @param {import('vscode')} vscode 
 */
async function openLogcatWindow(vscode) {
    // Open the SIDEBAR Logcat view (android-devtools.logcat) instead of creating
    // a separate webview panel/editor tab. Previously every call spawned a new
    // page, so "Launch + Logcat" ended up with two logcat windows side by side.
    // The sidebar view (src/logcatView.js LogcatViewProvider) handles ADB checks
    // and device selection itself when it resolves.
    try {
        await vscode.commands.executeCommand('android-devtools.logcat.focus');
    } catch (e) {
        vscode.window.showInformationMessage(loc('logcat.cannotDisplay', 'Logcat cannot be displayed: {0}', e.message));
    }
}

module.exports = {
    LogcatContent,
    openLogcatWindow,
}
