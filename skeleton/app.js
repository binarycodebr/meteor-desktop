/* eslint-disable import/no-unresolved */
/* eslint-disable global-require */

import electron from 'electron';
const { app, BrowserWindow, dialog } = electron;

import { EventEmitter as Events } from 'events';

import path from 'path';
const { join } = path;
import fs from 'fs';
import shell from 'shelljs';
import assignIn from 'lodash/assignIn';

import winston from 'winston';
import electronDebug from 'electron-debug';

import Module from './modules/module.js';
import desktop from './desktop.js';

/**
 * This is the main app which is a skeleton for the whole integration.
 * Here all the plugins/modules are loaded, local server is spawned and autoupdate is initialized.
 */
class App {

    constructor() {
        this.initLogger();
        this.l = this.getLogger();

        // System events emitter.
        this.systemEvents = new Events();

        this.desktop = null;
        this.app = app;
        this.window = null;
        this.windowAlreadyLoaded = false;
        this.webContents = null;
        this.modules = {};
        this.localServer = null;

        this.settings = {
            devTools: false
        };

        this.catchUncaughtExceptions();

        this.getOsSpecificValues();

        this.loadSettings();

        electronDebug({
            showDevTools: true,
            enabled: (this.settings.devTools !== undefined) ? this.settings.devTools : true
        });

        this.prepareWindowSettings();

        this.newVersionReady = false;
        this.systemEvents.on('newVersionReady', () => (this.newVersionReady = true));

        this.app.on('ready', this.onReady.bind(this));
        this.app.on('window-all-closed', () => this.app.quit());
    }

    /**
     * Prepares all the values that are dependant on os.
     */
    getOsSpecificValues() {
        this.os = {
            isWindows: (process.platform === 'win32'),
            isLinux: (process.platform === 'linux'),
            isOsx: (process.platform === 'darwin')
        };

        this.userDataDir = app.getPath('userData');
    }

    /**
     * Merges window settings specific to current os.
     */
    mergeOsSpecificWindowSettings() {
        ['windows', 'linux', 'osx'].forEach(system => {
            if (
                this.os[`is${system[0].toUpperCase()}${system.substring(1)}`] &&
                (`_${system}`) in this.settings.window
            ) {
                assignIn(this.settings.window, this.settings.window[`_${system}`]);
            }
        });
    }

    /**
     * Tries to load the settings.json.
     */
    loadSettings() {
        try {
            this.settings = JSON.parse(fs.readFileSync(join(__dirname, 'settings.json'), 'UTF-8'));
        } catch (e) {
            dialog.showErrorBox('Application', 'Could not read settings.json. Please reinstall' +
                ' this application.');
            if (this.app && this.app.quit) {
                this.app.quit();
            }
            process.exit(1);
        }
    }

    /**
     * Register on uncaughtExceptions so we can handle them.
     */
    catchUncaughtExceptions() {
        process.on('uncaughtException', error => {
            this.l.error(error);
            try {
                this.systemEvents.emit('unhandledException');
            } catch (e) {
                this.l.warn('could not emit unhandledException');
            }
            try {
                this.window.close();
            } catch (e) {
                // Empty catch block... nasty...
            }
            setTimeout(() => {
                dialog.showErrorBox('Application', 'Internal error occurred. Restart this ' +
                    'application. If the problem persist, contact support or try to reinstall.');
                this.app.quit();
            }, 500);
        });
    }

    /**
     * Applies os specific settings and sets proper icon path.
     */
    prepareWindowSettings() {
        if (!('window' in this.settings)) {
            this.settings.window = {};
        }

        this.mergeOsSpecificWindowSettings();

        if ('icon' in this.settings.window) {
            this.settings.window.icon = join(__dirname, 'assets', this.settings.window.icon);
        }
    }

    /**
     * Initializes this app.
     * Loads plugins.
     * Loads modules.
     * Loads desktop.js.
     * Initializes local server.
     */
    onReady() {
        this.l.info('ready fired');

        this.loadPlugins();
        this.systemEvents.emit('beforeModulesLoad');
        this.loadModules();

        this.systemEvents.emit('beforeDesktopLoaded');

        try {
            this.desktop = desktop(
                this.getLogger('desktop'),
                this.app,
                this.settings,
                this.systemEvents,
                this.modules,
                Module
            );
            this.systemEvents.emit('desktopLoaded', this.desktop);
            this.l.debug('desktop loaded');
        } catch (e) {
            this.l.warn('could not load desktop.js');
        }

        this.localServer = this.modules.localServer;

        this.localServer.setCallbacks(
            this.onStartupFailed.bind(this),
            this.onServerReady.bind(this),
            this.onServerRestarted.bind(this)
        );

        this.localServer.init(
            this.modules.autoupdate.getDirectory(),
            this.modules.autoupdate.getParentDirectory()
        );
    }

    /**
     * On server restart point chrome to the new port.
     * @param {integer} port - Port on which the app is served.
     */
    onServerRestarted(port) {
        this.webContents.loadURL(`http://127.0.0.1:${port}/`);
    }

    /**
     * Loads and initializes all plugins listed in settings.json.
     */
    loadPlugins() {
        if ('plugins' in this.settings) {
            Object.keys(this.settings.plugins).forEach(plugin => {
                this.l.debug(`loading plugin: ${plugin}`);
                this.modules[plugin] = require(plugin);
                const Plugin = this.modules[plugin];
                this.modules[plugin] = new Plugin(
                    this.getLogger(plugin),
                    this.app,
                    this.settings,
                    this.systemEvents,
                    this.modules,
                    this.settings.plugins[plugin],
                    Module
                );
            });
        }
    }

    /**
     * Loads and initializes internal and app modules.
     */
    loadModules() {
        let moduleName;

        // Load internal modules. Scan for files in /modules.
        shell.ls(join(__dirname, 'modules', '*.js')).forEach(file => {
            if (!~file.indexOf('module.js')) {
                moduleName = path.parse(file).name;
                this.l.debug(`loading module: ${file}`);
                this.modules[moduleName] = require(file);
                const InternalModule = this.modules[moduleName];
                const settings = {};
                this.modules[moduleName] = new InternalModule(
                    this.getLogger(moduleName),
                    this.app,
                    this.settings,
                    this.systemEvents,
                    this.modules,
                    settings,
                    Module
                );
            }
        });

        // Now go through each directory. If there is a index.js then it should be a module.
        shell.ls('-d', join(__dirname, 'modules', '*')).forEach(dir => {
            try {
                if (fs.accessSync(path.join(dir, 'index.js'), fs.R_OK)) {
                    moduleName = path.parse(dir).name;
                    this.l.debug(`loading module: ${dir} => ${moduleName}`);
                    let settings = {};
                    // module.json is mandatory, but we can live without it.
                    try {
                        let moduleJson = {};
                        moduleJson = JSON.parse(
                            fs.readFileSync(path.join(dir, 'module.json'), 'UTF-8')
                        );
                        if ('settings' in moduleJson) {
                            settings = moduleJson.settings;
                        }
                        if ('name' in moduleJson) {
                            moduleName = moduleJson.name;
                        }
                    } catch (e) {
                        this.l.warn(`could not load ${path.join(dir, 'module.json')}`);
                    }
                    this.modules[moduleName] = require(path.join(dir, 'index.js'));
                    const AppModule = this.modules[moduleName];
                    this.modules[moduleName] = new AppModule(
                        this.getLogger(moduleName),
                        this.app,
                        this.settings,
                        this.systemEvents,
                        this.modules,
                        settings,
                        Module
                    );
                }
            } catch (e) {
                this.l.warn(`no index.js found in ${dir}`);
            }
        });
    }

    /**
     * Handle startup failure.
     * @param {integer} code - Error code from local server.
     */
    onStartupFailed(code) {
        this.systemEvents.emit('startupFailed');
        dialog.showErrorBox('Startup error', 'Could not initialize app. Please contact' +
            ` your support. Error code: ${code}`);
        this.app.quit();
    }

    /**
     * Starts the app loading in the browser.
     * @param {integer} port - Port on which our local server is listening.
     */
    onServerReady(port) {
        const windowSettings = {
            width: 800, height: 600,
            webPreferences: {
                nodeIntegration: false, // node integration must to be off
                preload: join(__dirname, 'preload.js')
            },
            show: false
        };

        if ('webPreferences' in this.settings.window &&
            'nodeIntegration' in this.settings.window.webPreferences &&
            this.settings.window.webPreferences.nodeIntegration === true) {
            // Too risky to allow that... sorry.
            this.settings.window.webPreferences.nodeIntegration = false;
        }

        assignIn(windowSettings, this.settings.window);

        this.window = new BrowserWindow(windowSettings);
        this.webContents = this.window.webContents;

        this.systemEvents.emit('windowOpened', this.window);

        // Here we are catching reloads triggered by hot code push.
        this.webContents.on('will-navigate', event => {
            // We need to block it.
            event.preventDefault();

            if (this.newVersionReady) {
                this.systemEvents.emit(
                    'beforeReload', this.modules.autoupdate.getPendingVersion());

                // Firing reset routine.
                this.modules.autoupdate.onReset();

                // Reinitialize the local server.
                this.localServer.init(
                    this.modules.autoupdate.getDirectory(),
                    this.modules.autoupdate.getParentDirectory(),
                    true
                );
            }
            this.newVersionReady = false;
        });

        // The app was loaded.
        this.webContents.on('did-stop-loading', () => {
            if (!this.windowAlreadyLoaded) {
                this.windowAlreadyLoaded = true;
                this.systemEvents.emit('beforeLoadingFinished');
                this.window.show();
                this.window.focus();
            }
            this.systemEvents.emit('loadingFinished');
        });
        this.webContents.loadURL(`http://127.0.0.1:${port}/`);
    }


    initLogger() {
        const fileLogConfiguration = { filename: join(this.userDataDir, 'run.log') };
        winston.loggers.options.transports = [
            new (winston.transports.Console)(),
            new (winston.transports.File)(fileLogConfiguration)
        ];
    }

    /**
     * Returns a new logger instance.
     * @param {string} entityName
     * @returns {Logger}
     */
    getLogger(entityName) {
        const transports = [];
        const filters = [];
        if (entityName) {
            transports.push(new (winston.transports.File)({ filename: join(this.userDataDir, `${entityName}.log`) }));
            filters.push((level, msg) => `[${entityName}] ${msg}`);
        }
        const logger = new winston.Logger({
            level: 'debug',
            transports,
            filters
        });
        logger.clone = (subEntityName) => new winston.Logger({
            level: 'debug',
            transports,
            filters: [ (level, msg) => `[${subEntityName}] ${msg}` ]
        });
        return logger;
    }
}

const appInstance = new App();
