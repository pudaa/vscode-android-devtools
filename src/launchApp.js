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
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
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
 * When the installed signature differs (e.g. a release APK over a debug build,
 * or vice versa) `pm install -r` fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE;
 * in that case uninstall first, then install fresh (like Android Studio does).
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
        const first = failure[0];
        // signature mismatch: uninstall the conflicting build, then retry once
        if (/UPDATE_INCOMPATIBLE|SIGNATURE|INCOMPATIBLE/.test(first)) {
            await adb.shell_cmd({ command: `pm uninstall ${info.manifest.package}` });
            const out2 = await adb.shell_cmd({ command: `pm install ${args.replace(/\s*-r\s*/,' ')} /data/local/tmp/debug.apk` });
            const failure2 = (out2 || '').match(/Failure\s+\[[^\]]+\]/g);
            if (failure2) {
                throw new Error('Installation failed. ' + failure2[0]);
            }
            return;
        }
        throw new Error('Installation failed. ' + first);
    }
}

/**
 * Run the launch.json preLaunchTask (e.g. "run gradle") and wait for it to finish,
 * so the APK is built before we install & launch.
 * @param {string|undefined} taskName
 * @throws {Error} when the task is configured but cannot be found or run
 */
async function runPreLaunchTask(taskName) {
    if (!taskName) return;
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find(t => t.name === taskName || t.label === taskName);
    if (!task) {
        throw new Error(i18n.localize('launch.taskMissing', 'preLaunchTask "{0}" was not found in tasks.json. Add it or remove the preLaunchTask setting.', taskName));
    }
    await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            sub.dispose();
            reject(new Error(i18n.localize('launch.taskTimeout', 'preLaunchTask "{0}" timed out after 10 minutes.', taskName)));
        }, 10 * 60 * 1000);
        const sub = vscode.tasks.onDidEndTaskProcess(e => {
            if (settled) return;
            if (e.execution && e.execution.task === task) {
                clearTimeout(timer);
                settled = true;
                sub.dispose();
                if (e.exitCode !== 0) {
                    reject(new Error(i18n.localize('launch.taskFailed', 'preLaunchTask "{0}" exited with code {1}.', taskName, e.exitCode)));
                } else {
                    resolve();
                }
            }
        });
        vscode.tasks.executeTask(task);
    });
}

/**
 * Run a gradle task (e.g. assembleDebug / assembleRelease) via the project's
 * gradle wrapper, with a progress notification.
 * @param {string} task
 * @throws {Error} when the gradle wrapper is missing or the build fails
 */
async function runGradleTask(task) {
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders[0] ? folders[0].uri.fsPath : '';
    if (!root) {
        throw new Error(i18n.localize('launch.noWorkspace', 'No workspace folder is open - cannot build the APK.'));
    }
    const gradlew = path.join(root, /^win/.test(process.platform) ? 'gradlew.bat' : 'gradlew');
    if (!fs.existsSync(gradlew)) {
        throw new Error(i18n.localize('launch.gradleMissing', 'Gradle wrapper not found at {0}. Configure "gradleTask" or "preLaunchTask" in launch.json.', gradlew));
    }
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: i18n.localize('launch.building', 'Building APK ({0})...', task) },
        () => new Promise((resolve, reject) => {
            execFile(gradlew, [task], { cwd: root, shell: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
                if (err) {
                    reject(new Error(i18n.localize('launch.buildFailed', 'Gradle build failed: {0}', (stderr || err.message || '').slice(0, 400))));
                } else {
                    resolve();
                }
            });
        })
    );
}

/**
 * Build the APK for the requested variant.
 * Priority: explicit gradleTask -> configured preLaunchTask -> gradlew assemble<Variant>.
 * @param {string} variant 'debug' | 'release'
 * @param {*} cfg
 */
async function buildApk(variant, cfg) {
    const task = cfg.gradleTask && String(cfg.gradleTask).trim();
    if (task) {
        await runGradleTask(task);
        return;
    }
    if (cfg.preLaunchTask) {
        await runPreLaunchTask(cfg.preLaunchTask);
        return;
    }
    await runGradleTask(variant === 'release' ? 'assembleRelease' : 'assembleDebug');
}

/**
 * Map the configured APK path to the requested variant.
 * debug: .../apk/debug/app-debug.apk -> release: .../apk/release/app-release.apk
 * @param {string} apkFile
 * @param {string} variant
 * @returns {string}
 */
function resolveVariantApk(apkFile, variant) {
    const rel = String(apkFile || '');
    if (variant !== 'release' || !rel) return rel;
    const m = rel.match(/^(.*\/apk\/)debug\/(.+)-debug\.apk$/i);
    if (m) return `${m[1]}release/${m[2]}-release.apk`;
    return rel.replace(/\/debug\//g, '/release/').replace(/-debug\.apk$/i, '-release.apk');
}

/**
 * Start the app on a device and open the sidebar Logcat view. Fully independent
 * of the VS Code debug session. The build variant comes from the explicit
 * argument (if given) or launch.json 'buildVariant' (default 'debug').
 * @param {string} [variant] 'debug' | 'release'
 */
async function launchAppAndOpenLogcat(variant) {
    try {
        const cfg = getAndroidLaunchConfig() || {};
        const buildVariant = (variant || cfg.buildVariant || 'debug').toLowerCase() === 'release' ? 'release' : 'debug';

        // 1. build the requested variant
        await buildApk(buildVariant, cfg);

        // 2. resolve the APK for this variant
        const apkFile = resolveVariantApk(resolveWorkspacePath(cfg.apkFile), buildVariant);
        if (!apkFile) {
            vscode.window.showErrorMessage(i18n.localize('launch.noApk', 'No apkFile configured in launch.json'));
            return;
        }
        if (!fs.existsSync(apkFile)) {
            vscode.window.showErrorMessage(i18n.localize('launch.apkMissing', 'APK not found: {0}', apkFile));
            return;
        }
        const info = await APKFileInfo.from({ apkFile });

        if (!(await checkADBStarted(cfg.autoStartADB !== false))) {
            vscode.window.showErrorMessage(i18n.localize('launch.adbFailed', 'ADB server could not be started. Set ANDROID_HOME or add adb to PATH.'));
            return;
        }
        const device = await selectTargetDevice(vscode, 'Launch');
        if (!device) return;
        const adb = new ADBClient(device.serial);

        await ensureInstalled(adb, info, cfg.pmInstallArgs);

        // force-stop first so `am start` begins from a clean state (a leftover
        // "waiting for debugger" process from an interrupted debug session would
        // otherwise just resume on the foreground and appear frozen)
        try {
            await adb.shell_cmd({ command: `am force-stop ${info.manifest.package}` });
        } catch (e) { /* best effort - no output from force-stop */ }

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
        // confirm the app process actually came up (am start can return success
        // even when the app immediately crashes or stays stuck)
        let pid = '';
        for (let i = 0; i < 10; i++) {
            pid = await adb.shell_cmd({ command: `pidof ${info.manifest.package}` });
            pid = String(pid || '').trim();
            if (pid) break;
            await new Promise(r => setTimeout(r, 1000));
        }
        if (!pid) {
            vscode.window.showErrorMessage(i18n.localize('launch.processMissing', 'The app was started but its process is not running. It may have crashed or is waiting for a debugger. Check the logcat output.'));
            return;
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
    resolveVariantApk,
};
