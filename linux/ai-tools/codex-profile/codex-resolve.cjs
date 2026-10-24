'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function windowsHome() {
    return process.env.USERPROFILE || os.homedir();
}

function linuxHome() {
    return process.env.HOME || os.homedir();
}

function resolveHome() {
    if (Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME')) {
        return process.env.CODEX_HOME;
    }

    const home = process.platform === 'win32' ? windowsHome() : linuxHome();
    if (!home) {
        throw new Error('cannot determine the user home directory');
    }

    const configDir = path.join(home, '.config', 'ai-usage-monitor');
    const configPath = process.env.CODEX_ACCOUNTS_PATH || path.join(configDir, 'codex-accounts.json');
    let text;
    try {
        text = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return path.join(home, '.codex');
        }
        throw new Error(`cannot read ${configPath}: ${error.message}`);
    }

    let config;
    try {
        config = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new Error(`cannot parse ${configPath}: ${error.message}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`${configPath}: top level must be an object`);
    }
    if (!Array.isArray(config.accounts)) {
        throw new Error(`${configPath}: accounts must be an array`);
    }

    if (config.default_removed !== undefined && typeof config.default_removed !== 'boolean') {
        throw new Error(`${configPath}: default_removed must be a boolean`);
    }
    const registered = new Set();
    if (config.default_removed !== true) {
        registered.add('default');
    }
    for (const entry of config.accounts) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`${configPath}: every account must be an object`);
        }
        if (typeof entry.id !== 'string' || !ACCOUNT_ID.test(entry.id)) {
            throw new Error(`${configPath}: invalid account id`);
        }
        if (entry.id === 'default') {
            throw new Error(`${configPath}: account id is reserved: default`);
        }
        if (registered.has(entry.id)) {
            throw new Error(`${configPath}: duplicate account id ${entry.id}`);
        }
        registered.add(entry.id);
    }

    const active = config.active === undefined ? 'default' : config.active;
    if (active === null) {
        throw new Error(`${configPath}: active account is null; no profile can be selected`);
    }
    if (typeof active !== 'string' || !ACCOUNT_ID.test(active)) {
        throw new Error(`${configPath}: invalid active account id`);
    }
    if (!registered.has(active)) {
        throw new Error(`${configPath}: active account is not registered: ${active}`);
    }

    return active === 'default'
        ? path.join(home, '.codex')
        : path.join(configDir, 'codex-accounts', active);
}

function quoteCmdArgument(value) {
    if (!value) return '""';
    let quoted = '"';
    let slashes = 0;
    for (const char of value) {
        if (char === '\\') {
            slashes++;
        } else if (char === '"') {
            quoted += '\\'.repeat(slashes * 2 + 1) + '"';
            slashes = 0;
        } else {
            quoted += '\\'.repeat(slashes) + char;
            slashes = 0;
        }
    }
    return quoted + '\\'.repeat(slashes * 2) + '"';
}

function executeReal(real, args) {
    if (!real || !fs.existsSync(real)) {
        throw new Error(`real Codex shim not found: ${real || '(empty)'}`);
    }
    let command = '""' + real + '"';
    for (const arg of args) command += ` ${quoteCmdArgument(arg)}`;
    command += '"';
    const result = childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/c', command], {
        windowsVerbatimArguments: true,
        stdio: 'inherit',
        env: process.env,
    });
    if (result.error) {
        throw new Error(`cannot start real Codex shim: ${result.error.message}`);
    }
    if (result.status === null) {
        throw new Error('real Codex shim did not return an exit code');
    }
    return result.status;
}

const argv = process.argv.slice(2);
try {
    if (argv[0] === '--exec') {
        if (process.platform !== 'win32') {
            throw new Error('--exec is only supported on Windows');
        }
        const home = resolveHome();
        if (!Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME')) {
            process.env.CODEX_HOME = home;
        }
        process.exitCode = executeReal(argv[1], argv.slice(2));
    } else {
        process.stdout.write(`${resolveHome()}\n`);
    }
} catch (error) {
    process.stderr.write(`codex-profile: ${error.message}\n`);
    process.exitCode = 1;
}
