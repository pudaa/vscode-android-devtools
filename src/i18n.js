'use strict'
/**
 * Minimal i18n helper for the extension.
 *
 * Uses VS Code's language id (zh-cn supported; everything else falls back to en).
 * String tables live in package.nls.json (default/en) and package.nls.zh-cn.json.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/** @type {{[key:string]: string}} */
let table = null;
/** @type {string} */
let currentLang = '';

/**
 * Load the string table for the current UI language.
 * @param {vscode.ExtensionContext} [context]
 */
function load(context) {
    const lang = vscode.env.language.toLowerCase();
    currentLang = lang;
    const root = context ? context.extensionPath : __dirname;
    const candidates = [
        lang.startsWith('zh') ? 'package.nls.zh-cn.json' : null,
        lang.startsWith('zh') ? 'package.nls.zh.json' : null,
        'package.nls.json',
    ].filter(Boolean);

    for (const file of candidates) {
        const fpn = path.join(root, file);
        try {
            if (fs.existsSync(fpn)) {
                table = JSON.parse(fs.readFileSync(fpn, 'utf8'));
                return;
            }
        } catch (e) {
            // try next
        }
    }
    table = {};
}

/**
 * Localize a key, optionally substituting {0}, {1}, ...
 * @param {string} key
 * @param {string} [defaultValue]
 * @param {...any} args
 */
function localize(key, defaultValue, ...args) {
    if (!table) load();
    let s = (table && table[key]) || defaultValue || key;
    args.forEach((a, i) => {
        s = s.replace(new RegExp(`\\{${i}\\}`, 'g'), String(a));
    });
    return s;
}

module.exports = {
    load,
    localize,
    get currentLang() { return currentLang; },
};
