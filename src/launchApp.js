'use strict'
/**
 * Independent "install + launch app + open logcat" flow.
 *
 * This deliberately does NOT go through a VS Code debug session, so the debug
 * and logcat-only workflows are kept completely separate (they no longer fight
 * each other like the old "openLogcatAfterLaunch inside a debug session"
 * approach did - no -D, no attach, no TerminatedEvent/auto-restart loop).
 */
const vscode = require('vscode');
const { ADBClient } = require('./adbclient');
const { APKFileInfo } = require('./apk-file-info');
const { checkADBStarted } = require('./utils/android');
const { selectTargetDevice } = require('./utils/device');
const { getAndroidLaunchConfig } = require('./controlView');
const { openLogcatWindow } = require('./logcat');
const i18n = require('./i18n');

/**
 * Resolve ${workspaceRoot}/${workspaceFolder} in a configured path.
 * @param {string} p
 * @returns {string}
 */
function resolveWorkspacePath(p) {
    if (!p) return '';
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders[0] ? folders[0].uri.fsPath : '';
    return String(p)
        .replace(/\$\{workspaceRoot\}/g, root)
        .replace(/\$\{workspaceFolder\}/g, root);
}

/**
 * Pick the activity to launch: the configured launchActivity if it exists in the
 * APK manifest, otherwise the manifest launcher (e.g. when the configured one is
 * present but not exported).
 * @param {*} cfg launch config from launch.json
 * @param {import('./apk-file-info').APKFileInfo} info
 * @returns {string}
 */
function pickLaunchActivity(cfg, info) {
    const norm = (n) => {
        const s = String(n || '').trim();
        return s.startsWith('.') ? info.manifest.package + s : s;
    };
    const act = (cfg.launchActivity || '').trim();
    if (act) {
        const full = norm(act);
        const valid = (info.manifest.activities || []).some(a => norm(a) === full);
        if (valid) return act;
    }
    return info.manifest.launcher;
}

/**
 * Install the APK on the device if the installed one differs (hash compare).
 * @param {ADBClient} adb
 * @param {import('./apk-file-info').APKFileInfo} info
 * @param {string[]|undefined} pmInstallArgs
 */
async function ensureInstalled(adb, info, pmInstallArgs) {
    const q = `/system/bin/sha1sum $(pm path ${info.manifest.package}|grep -o -e '/.*' || echo '/system/bin/sha1sum')`;
    const sha = await adb.shell_cmd({ command: q });
    const installedHash = ((sha || '').match(/^[0-9a-fA-F]*/) || [''])[0].toLowerCase();
    if (installedHash === info.content_hash) {
        return; // already up to date
    }
    const args = Array.isArray(pmInstallArgs) ? pmInstallArgs.join(' ') : '-r';
    await adb.push_file({
        pathname: '/data/local/tmp/debug.apk',
        data: info.file_data,
        mtime: (Date.now() / 1000) | 0,
        perms: 0o100664,
    });
    const out = await adb.shell_cmd({ command: `pm install ${args} /data/local/tmp/debug.apk` });
    const failure = (out || '').match(/Failure\s+\[[^\]]+\]/g);
    if (failure) {
        throw new Error('Installation failed. ' + failure[0]);
    }
}

/**
 * Run the launch.json preLaunchTask (e.g. "run gradle") and wait for it to finish,
 * so the APK is built before we install & launch. No-op if none is configured or
 * the task infrastructure is unavailable.
 * @param {string|undefined} taskName
 */
async function runPreLaunchTask(taskName) {
    if (!taskName) return;
    try {
        const tasks = await vscode.tasks.fetchTasks();
        const task = tasks.find(t => t.name === taskName || t.label === taskName);
        if (!task) return;
        await new Promise((resolve) => {
            const sub = vscode.tasks.onDidEndTaskProcess(e => {
                if (e.execution && e.execution.task === task) {
                    sub.dispose();
                    resolve();
                }
            });
            vscode.tasks.executeTask(task);
        });
    } catch (e) { /* task infrastructure unavailable - continue anyway */ }
}

/**
 * Start the app on a device and open the sidebar Logcat view. Fully independent
 * of the VS Code debug session.
 */
async function launchAppAndOpenLogcat() {
    try {
        const cfg = getAndroidLaunchConfig() || {};
        const apkFile = resolveWorkspacePath(cfg.apkFile);
        if (!apkFile) {
            vscode.window.showErrorMessage(i18n.localize('launch.noApk', 'No apkFile configured in launch.json'));
            return;
        }
        // build first (e.g. "run gradle") so the APK is up to date
        await runPreLaunchTask(cfg.preLaunchTask);
        const info = await APKFileInfo.from({ apkFile });

        if (!(await checkADBStarted(cfg.autoStartADB !== false))) {
            vscode.window.showErrorMessage(i18n.localize('launch.adbFailed', 'ADB server could not be started. Set ANDROID_HOME or add adb to PATH.'));
            return;
        }
        const device = await selectTargetDevice(vscode, 'Launch');
        if (!device) return;
        const adb = new ADBClient(device.serial);

        await ensureInstalled(adb, info, cfg.pmInstallArgs);

        const launchActivity = pickLaunchActivity(cfg, info);
        let out = await adb.shell_cmd({ command: `am start -n ${info.manifest.package}/${launchActivity}` });
        if (/Permission Denial|not exported|Error:|Activity not found|does not exist/i.test(out)) {
            // configured activity can't start -> retry with the manifest launcher
            out = await adb.shell_cmd({ command: `am start -n ${info.manifest.package}/${info.manifest.launcher}` });
            if (/Permission Denial|not exported|Error:/i.test(out)) {
                vscode.window.showErrorMessage(i18n.localize('launch.startFailed', 'Failed to start the app: {0}', String(out || '').trim().slice(0, 200)));
                return;
            }
        }

        // open the sidebar logcat view
        await openLogcatWindow(vscode);
    } catch (e) {
        vscode.window.showErrorMessage(i18n.localize('launch.failed', 'Launch failed: {0}', e && e.message));
    }
}

module.exports = {
    launchAppAndOpenLogcat,
    pickLaunchActivity,
    runPreLaunchTask,
};
