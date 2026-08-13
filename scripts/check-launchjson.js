const fs = require('fs');
const raw = fs.readFileSync('.vscode/launch.json', 'utf8');
// strip // comment lines (JSONC)
const noComments = raw.replace(/^\s*\/\/.*$/gm, '');
// remove trailing commas before } or ]
const fixed = noComments.replace(/,\s*([}\]])/g, '$1');
try {
    const l = JSON.parse(fixed);
    console.log('JSONC valid OK (after comment/trailing-comma strip)');
    console.log('configs:', l.configurations.map(c => c.name).join(' | '));
    const c = l.configurations[0];
    console.log('first args:', JSON.stringify(c.args));
} catch (e) {
    console.log('error:', e.message);
}
