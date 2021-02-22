"use strict";

const self = require('./self');
const { PageMod } = require('sdk/page-mod');
const tabs = require("sdk/tabs");
const { UI, ui_type } = require('./ui');
const { isPrivate } = require("sdk/private-browsing");
const simple_prefs = require("sdk/simple-prefs");
const events = require("sdk/system/events");
const { getTargetWindow } = require('sdk/content/mod');
const stylesheet_service = require('./stylesheet-service');
const { process_stylesheet } = require('./methods/abstract-method');
const about_config = require('sdk/preferences/service');
const { gppmm } = require('./gppmm');
const sdk_url = require('sdk/url');
const { get_sytem_font_style } = require('./system-font');
const { Cu, Cc, Ci } = require('chrome');

try {
    Cu.import('resource://gre/modules/devtools/gDevTools.jsm');
} catch(e) {
    try {
        Cu.import("resource://devtools/client/framework/gDevTools.jsm");
    } catch(e) {}
}

const isFennec = require('sdk/system/xul-app').ID === '{aa3c5121-dab2-40e2-81ca-7ea25febc110}';

var loaded_global_stylesheet;

const configured_private = {};
events.on("last-pb-context-exited", function (event) {
    for (let url in configured_private) {
        delete configured_private[url];
    }
}, true);

const methods = require('./methods/methods').get_methods();
var configured_pages;
const preferences = [
    {
        type: 'bool',
        name: 'enabled',
        value: true,
        title: 'Enabled'
    },
    {
        title: "Default method of changing page colors",
        value: 1,
        type: "menulist",
        options: Object.keys(methods).filter(key=>(parseInt(key) >= 0)).map(key=>
            ({
                label: methods[key].label,
                value: key
            })),
        name: "default_method"
    },
    {
        "type": "color",
        "name": "default_foreground_color",
        "value": "#ffffff",
        "title": "Default foreground color"
    },
    {
        "type": "color",
        "name": "default_background_color",
        "value": "#000000",
        "title": "Default background color"
    },
    {
        "type": "color",
        "name": "default_link_color",
        "value": "#7fd7ff",
        "title": "Default link color"
    },
    {
        "type": "color",
        "name": "default_visited_color",
        "value": "#ffafff",
        "title": "Default visited link color"
    },
    {
        "type": "color",
        "name": "default_active_color",
        "value": "#ff0000",
        "title": "Default active link color"
    },
    {
        "type": "color",
        "name": "default_selection_color",
        "value": "#8080ff",
        "title": "Default selection color"
    },
    {
        "type": "color",
        "name": "default_pdf_color",
        "value": "#1A1A1A",
        "title": "PDF Viewer interface color"
    },
    {
        title: "Default method of changing PDF Viewer colors",
        value: 3,
        type: "menulist",
        options: Object.keys(methods).filter(key=>(parseInt(key) >= 0)).map(key=>
            ({
                label: methods[key].label,
                value: key
            })),
        name: "default_pdf_method"
    },
    {
        type: 'bool',
        name: 'devtools',
        value: true,
        title: 'Use dark theme for DevTools'
    },
    {
        type: 'configured_pages',
        name: 'configured_pages',
        value: '{}',
        title: 'configured_pages'
    }

    /*,
    {
        type: 'string',
        name: 'black_on_transparent_selectors',
        value: [
            'img[alt="inline_formula"]'
        ].join(', '),
        title: '"Black on transparent" elements selectors'
    }*/
];
preferences.forEach(pref => {
    if (!(pref.name in simple_prefs.prefs)) {
        simple_prefs.prefs[pref.name] = pref.value;
    }
});

configured_pages = JSON.parse(simple_prefs.prefs['configured_pages']);

const preferences_workers = [];

const built_in_configured = {
    'chrome://browser/content/browser.xul': '0',
    'chrome://browser/content/history/history-panel.xul': 0,
    'chrome://browser/content/bookmarks/bookmarksPanel.xul': 0,
    /*'chrome://browser/content/': '0', - there are iframes in about:preferences that points here, do not ignore it*/
    'chrome://browser/content/devtools/': '0', // Developer tools have good dark theme
    'chrome://devtools/content/': '0',
    //'about:addons': '4'
    'chrome://navigator/content/navigator.xul': '0', // SeaMonkey
};

function get_merged_configured() {
    let result = {};
    for (let att in built_in_configured) {
        result[att] = built_in_configured[att];
    }
    for (let att in configured_pages) {
        result[att] = configured_pages[att];
    }
    for (let att in configured_private) {
        result[att] = configured_private[att];
    }
    return result
}
const protocol_and_www = new RegExp('^(?:(?:https?)|(?:ftp))://(?:www\\.)?');
function get_method_for_url(url) {
    //TODO: merge somehow part of this code with generate_urls()
    let method = 'unspecified';
    if (simple_prefs.prefs['enabled']) {
        let merged_configured = get_merged_configured();
        if (url.search(protocol_and_www) >= 0) {
            url = url.replace(protocol_and_www, '');
            // dirty removing of portnumber from url
            //TODO: do not remove it but handle properly
            let colon = url.indexOf(':');
            let origin_end = url.indexOf('/');
            if (origin_end === -1) origin_end = url.length;
            if (colon < origin_end && url.substring(colon + 1, origin_end).search(/^(\d)+$/) === 0)
                url = url.substr(0, colon) + url.substr(origin_end);
        } else {
            url=url.split('?')[0];
        }
        let pure_domains = Object.keys(merged_configured).filter(key => (key.indexOf('/') < 0));
        let with_path = Object.keys(merged_configured).filter(key => (key.indexOf('/') >= 0));
        if (with_path.sort((a, b) => a.length < b.length).some(saved_url => {
                if (url.indexOf(saved_url) === 0) {
                    method = methods[merged_configured[saved_url]];
                    return true;
                }
            })) {
        } // if .some() returns true => we found it!
        else if (pure_domains.sort((a, b) => a.length < b.length).some(saved_url => {
                let saved_arr = saved_url.split('.').reverse();
                let test_arr = url.split('/')[0].split('.').reverse();
                if (saved_arr.length > test_arr.length)
                    return false;
                if (saved_arr.every((part, index) => (part === test_arr[index]))) {
                    method = methods[merged_configured[saved_url]];
                    return true;
                }
            })) {
        } // use 'Invert' method by default for *.pdf
        else if (/\.pdf$/.test(url)) {
            method = methods[simple_prefs.prefs["default_pdf_method"]];
        }
        else
            method = methods[simple_prefs.prefs["default_method"]];
        return method;
    } else
        return methods[0];
}
function update_devtools_theme(darkmode) {
    if (typeof gDevTools === "undefined") {
        return;
    }
    var oldValue = about_config.get('devtools.theme');
    if (darkmode) {
        about_config.set('devtools.theme', 'dark');
    } else {
        about_config.reset('devtools.theme');
    }
    gDevTools.emit("pref-changed", { pref: "devtools.theme", newValue: about_config.get('devtools.theme'), oldValue: oldValue });
}
const fx_prefs = {
    'browser.display.use_system_colors': false,
    'browser.display.document_color_use': 1, // 'Override the colors specified by the page with my selections above' => 'Never'
};
var fx_prefs_save = {};
function update_global_sheet(unload) {
    if (loaded_global_stylesheet && stylesheet_service.sheetRegistered(loaded_global_stylesheet, 'user'))
        stylesheet_service.unregisterSheet(loaded_global_stylesheet, 'user');
    if (!unload) {
        loaded_global_stylesheet = process_stylesheet(self.data.url('methods/global.css'), simple_prefs.prefs);
        stylesheet_service.loadAndRegisterSheet(loaded_global_stylesheet, 'user');
        Object.keys(fx_prefs).forEach(pref => fx_prefs_save[pref] = about_config.get(pref, fx_prefs[pref]));
        Object.keys(fx_prefs).forEach(pref => about_config.set(pref, fx_prefs[pref]));
    } else {
        Object.keys(fx_prefs_save).forEach(pref => about_config.set(pref, fx_prefs_save[pref]));
    }
    update_devtools_theme(!unload && simple_prefs.prefs['devtools']);
}
function update_options() {
    gppmm.broadcastAsyncMessage('update_options', simple_prefs.prefs);
    update_global_sheet(!(simple_prefs.prefs['enabled']));
}
function settings_changed(data) {
    let { url, method } = data;
    if (!data.isPrivate) {
        if (method < 0) {
            delete configured_pages[url]
        } else {
            configured_pages[url] = method;
        }
        simple_prefs.prefs['configured_pages'] = JSON.stringify(configured_pages);
    } else {
        if (method < 0) {
            delete configured_private[url]
        } else {
            configured_private[url] = method;
        }
    }
    gppmm.broadcastAsyncMessage('update_applied_methods');
}
function generate_urls(url_param) {
    let url_str;
    if (!url_param)
        url_str = tabs.activeTab.url;
    else
        url_str = url_param;
    let url_obj = sdk_url.URL(url_str);

    let result_list = [];
    let preselect;

    let before_path;
    if (['http', 'https', 'ftp'].indexOf(url_obj.scheme) >= 0) {
        let tld = sdk_url.getTLD(url_str);
        let hostname_short = url_obj.hostname
            .replace(new RegExp('^www\\.'), '');
        if (tld) {
            hostname_short = hostname_short
                .replace(new RegExp('\\.' + tld.split('.').join('\\.') + '$'), '');
        } // 'else' is most likely bare IP

        if (url_obj.hostname === tld) { // domain itself is top-level (eg. localhost)
            result_list.push(tld);
            preselect = tld;
            before_path = tld;
        } else {
            hostname_short.split('.').reverse().forEach((part, index, parts) => {
                let result = parts.slice(0, index + 1).reverse().join('.') + (!!tld ? ('.' + tld) : '');
                result_list.push(result);
                preselect = result;
                before_path = result;
            });
        }
        if (url_obj.port) { /* //TODO:
            let result = before_path + ':' + url_obj.port;
            result_list.push(result);
            preselect = result;
            before_path = result; */
        }
    } else {
        if (url_obj.protocol !== url_obj.origin) {
            result_list.push(url_obj.origin);
            preselect = url_obj.origin;
        }
        before_path = url_obj.origin;
    }

    let path_starts_with_slash = false;
    url_obj.pathname.split('/').forEach((part, index, parts) => {
        if (part.length === 0 && index === 0) {
            // if path starts with '/'
            path_starts_with_slash = true;
            return;
        }
        if (part.length === 0 && index === 1)
            return; // path is only '/'
        let result = path_starts_with_slash ?
            [before_path].concat( parts.slice(1, index + 1) ).join('/') :
            before_path + parts.slice(0, index + 1).join('/');
        result_list.push(result);
        if (!(preselect))
            preselect = result;
    });

    let merged = get_merged_configured();
    result_list.forEach(url => {
        if (url in merged)
            preselect = url;
    });

    return { list: result_list, preselect };
}
function get_settings_init_params() {
    return {
        enabled: simple_prefs.prefs['enabled'],
        methods: methods,
        configured: get_merged_configured(),
        //TODO: pass url here:
        urls: generate_urls(),
        /* BAD NEWS: It seems that isPrivate(Tab) is broken on android! But isPrivate(nsIDOMWindow) works //TODO: test with android */
        isPrivate: isFennec ? isPrivate(getTargetWindow(tabs.activeTab)) : isPrivate(tabs.activeTab),
        isTouchscreen: ui_type === 'android',
        style: get_sytem_font_style()
    }
}

function checkBrighttext() {
    var wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
    var toolbar = wm.getMostRecentWindow("navigator:browser").document.querySelector("#navigator-toolbox toolbar");
    return toolbar && toolbar.hasAttribute("brighttext");
}

preferences.forEach(pref => {
    simple_prefs.on(pref.name, key => {
        preferences_workers.forEach(worker => {
            let data;
            let event;
            if (key === 'configured_pages') {
                event = 'refresh-configured';
                data = configured_pages;
            } else {
                event = 'refresh';
                data = {
                    name: key,
                    value: simple_prefs.prefs[key]
                };
            }
            worker.port.emit(event, data);
        });
        //TODO: pref change event handler becomes messy. refactor to avoid it.
        if (['default_method', 'enabled', 'configured_pages', 'devtools', 'default_pdf_method'].indexOf(key) >= 0) {
            if (key === 'configured_pages')
                return;
            if (key === 'devtools') {
                update_devtools_theme(simple_prefs.prefs['enabled'] && simple_prefs.prefs['devtools']);
                return;
            }
            if (key === 'enabled')
                update_global_sheet(!(simple_prefs.prefs['enabled']));
            gppmm.broadcastAsyncMessage('update_applied_methods');
        }
        else
            update_options();
    });
});
simple_prefs.on('open_addon_prefs', () => { tabs.open(self.data.url('preferences.html')) });

PageMod({
    include: self.data.url('preferences.html'),
    attachTo: ['existing', 'top', 'frame'],
    contentScriptFile: self.data.url('preferences.js'),
    onAttach: function(worker) {
        preferences_workers.push(worker);
        worker.on('detach', () => {
            let index = preferences_workers.indexOf(worker);
            if (index >= 0) // for some reason, detach emitted twice
                preferences_workers.splice(index, 1);
            /*else
                console.log('index < 0', (new Error()).stack);*/
        });
        worker.port.on('settings-changed', data => {
            simple_prefs.prefs[data.name] = data.value;
        });
        worker.port.on('settings-reset', name => {
            simple_prefs.prefs[name] = preferences.filter(p => (p.name === name))[0].value;
        });
        worker.port.on('remove-configured', url => {
            settings_changed({
                url: url,
                method: -1,
                isPrivate: false
            });
        });
        worker.port.emit('style', get_sytem_font_style());
        worker.port.emit('init', {
            isBrighttext: checkBrighttext(),
            isTouchscreen: ui_type === 'android',
            preferences: preferences.map(p => {
                let pref = {};
                for (let k in p) {
                    if (k === 'value') {
                        pref['value'] = simple_prefs.prefs[p.name];
                    } else {
                        pref[k] = p[k];
                    }
                }
                return pref;
            }).filter(p => (p.name !== 'configured_pages')), //TODO: do not filter it out. Allow to edit configured pages.
            configured_pages: configured_pages,
            methods: methods
        });
    }
});

var ui = new UI({
    id: 'configure-for-current-tab',
    label: 'Advanced Night Mode',
    labelShort: 'Advanced Night Mode',
    tooltip: 'Advanced Night Mode options for current web page',
    height: 350,
    icon: {
        "16": "./icon16.png",
        "24": "./icon24.png",
        "32": "./icon32.png",
        "64": "./icon64.png"
    },
    contentURL: self.data.url("configure-for-current-tab-panel.html"),
    contentScriptFile: self.data.url("configure-for-current-tab-panel.js")
});
ui.on('panel-show', () => ui.emit('init', get_settings_init_params()));
ui.on('panel-port-settings-changed', data => {
    ui.hide();
    settings_changed(data);
});
ui.on('panel-port-open-preferences', () => {
    ui.hide();
    // TODO: move isPrivate(tab) to function
    tabs.open({
        url: self.data.url('preferences.html'),
        isPrivate: isFennec ? isPrivate(getTargetWindow(tabs.activeTab)) : isPrivate(tabs.activeTab)
    });
});
ui.on('panel-port-enabled-change', enabled => {
    ui.hide();
    simple_prefs.prefs['enabled'] = enabled;
});

function prepare_prefs_to_send() {
    let to_send = {};
    preferences.forEach(pref => {
        to_send[pref.name] = simple_prefs.prefs[pref.name];
    });
    return to_send;
}

const message_listeners = {
    query_method_for_url: msg => {
        msg.target.sendAsyncMessage('result_method_for_url', {
            method: get_method_for_url(msg.data.url).number,
            prefs: prepare_prefs_to_send(),
            index: msg.data.index
        });
    }
};

exports.main = function(options, callbacks) {
    stylesheet_service.loadAndRegisterSheet(self.data.url('button.css'), 'user');
    update_global_sheet(!(simple_prefs.prefs['enabled']));

    gppmm.loadProcessScript('chrome://advanced-night-mode/content/process-script.js', true);
    for (let message in message_listeners)
        gppmm.addMessageListener(message, message_listeners[message]);
};

exports.onUnload = function(reason) {
    if (reason !== 'shutdown') { // no need to do heavy things on shutdown
        update_global_sheet(true);
        stylesheet_service.unregisterSheet(self.data.url('button.css'), 'user');

        for (let message in message_listeners)
            gppmm.removeMessageListener(message, message_listeners[message]);
        gppmm.broadcastAsyncMessage('unload_all');
        gppmm.removeDelayedProcessScript('chrome://advanced-night-mode/content/process-script.js');
    } else {
        Object.keys(fx_prefs_save).forEach(pref => about_config.set(pref, fx_prefs_save[pref]));
    }
};

const { setTimeout } = require('sdk/timers');
setTimeout(function() { // migrate to GitHub
  Cu.import("resource://gre/modules/Services.jsm");
  var migrate;
  try { migrate = Services.prefs.getBoolPref("extensions.justoff-migration"); } catch(e) {}
  if (typeof migrate == "boolean") return;
  Services.prefs.getDefaultBranch("extensions.").setBoolPref("justoff-migration", true);
  Cu.import("resource://gre/modules/AddonManager.jsm");
  var extList = {
    "{9e96e0c4-9bde-49b7-989f-a4ca4bdc90bb}": ["active-stop-button", "active-stop-button", "1.5.15", "md5:b94d8edaa80043c0987152c81b203be4"],
    "abh2me@Off.JustOff": ["add-bookmark-helper", "add-bookmark-helper", "1.0.10", "md5:f1fa109a7acd760635c4f5afccbb6ee4"],
    "AdvancedNightMode@Off.JustOff": ["advanced-night-mode", "advanced-night-mode", "1.0.13", "md5:a1dbab8231f249a3bb0b698be79d7673"],
    "behind-the-overlay-me@Off.JustOff": ["dismiss-the-overlay", "dismiss-the-overlay", "1.0.7", "md5:188571806207cef9e6e6261ec5a178b7"],
    "CookiesExterminator@Off.JustOff": ["cookies-exterminator", "cookexterm", "2.9.10", "md5:1e3f9dcd713e2add43ce8a0574f720c7"],
    "esrc-explorer@Off.JustOff": ["esrc-explorer", "esrc-explorer", "1.1.6", "md5:2727df32c20e009219b20266e72b0368"],
    "greedycache@Off.JustOff": ["greedy-cache", "greedy-cache", "1.2.3", "md5:a9e3b70ed2a74002981c0fd13e2ff808"],
    "h5vtuner@Off.JustOff": ["html5-video-tuner", "html5-media-tuner", "1.2.5", "md5:4ec4e75372a5bc42c02d14cce334aed1"],
    "location4evar@Off.JustOff": ["L4E", "location-4-evar", "1.0.8", "md5:32e50c0362998dc0f2172e519a4ba102"],
    "lull-the-tabs@Off.JustOff": ["lull-the-tabs", "lull-the-tabs", "1.5.2", "md5:810fb2f391b0d00291f5cc341f8bfaa6"],
    "modhresponse@Off.JustOff": ["modify-http-response", "modhresponse", "1.3.8", "md5:5fdf27fd2fbfcacd5382166c5c2c185c"],
    "moonttool@Off.JustOff": ["moon-tester-tool", "moon-tester-tool", "2.1.3", "md5:553492b625a93a42aa541dfbdbb95dcc"],
    "password-backup-tool@Off.JustOff": ["password-backup-tool", "password-backup-tool", "1.3.2", "md5:9c8e9e74b1fa44dd6545645cd13b0c28"],
    "pmforum-smart-preview@Off.JustOff": ["pmforum-smart-preview", "pmforum-smart-preview", "1.3.5", "md5:3140b6ba4a865f51e479639527209f39"],
    "pxruler@Off.JustOff": ["proxy-privacy-ruler", "pxruler", "1.2.4", "md5:ceadd53d6d6a0b23730ce43af73aa62d"],
    "resp-bmbar@Off.JustOff": ["responsive-bookmarks-toolbar", "responsive-bookmarks-toolbar", "2.0.3", "md5:892261ad1fe1ebc348593e57d2427118"],
    "save-images-me@Off.JustOff": ["save-all-images", "save-all-images", "1.0.7", "md5:fe9a128a2a79208b4c7a1475a1eafabf"],
    "tab2device@Off.JustOff": ["send-link-to-device", "send-link-to-device", "1.0.5", "md5:879f7b9aabf3d213d54c15b42a96ad1a"],
    "SStart@Off.JustOff": ["speed-start", "speed-start", "2.1.6", "md5:9a151e051e20b50ed8a8ec1c24bf4967"],
    "youtubelazy@Off.JustOff": ["youtube-lazy-load", "youtube-lazy-load", "1.0.6", "md5:399270815ea9cfb02c143243341b5790"]
  };
  AddonManager.getAddonsByIDs(Object.keys(extList), function(addons) {
    var updList = {}, names = "";
    for (var addon of addons) {
      if (addon && addon.updateURL == null) {
        var url = "https://github.com/JustOff/" + extList[addon.id][0] + "/releases/download/" + extList[addon.id][2] + "/" + extList[addon.id][1] + "-" + extList[addon.id][2] + ".xpi";
        updList[addon.name] = {URL: url, Hash: extList[addon.id][3]};
        names += '"' + addon.name + '", ';
      }
    }
    if (names == "") {
      Services.prefs.setBoolPref("extensions.justoff-migration", false);
      return;
    }
    names = names.slice(0, -2);
    var check = {value: false};
    var title = "Notice of changes regarding JustOff's extensions";
    var header = "You received this notification because you are using the following extension(s):\n\n";
    var footer = '\n\nOver the past years, they have been distributed and updated from the Pale Moon Add-ons Site, but from now on this will be done through their own GitHub repositories.\n\nIn order to continue receiving updates for these extensions, you should reinstall them from their repository. If you want to do it now, click "Ok", or select "Cancel" otherwise.\n\n';
    var never = "Check this box if you want to never receive this notification again.";
    var mrw = Services.wm.getMostRecentWindow("navigator:browser");
    if (mrw) {
      var result = Services.prompt.confirmCheck(mrw, title, header + names + footer, never, check);
      if (result) {
        mrw.gBrowser.selectedTab.linkedBrowser.contentDocument.defaultView.InstallTrigger.install(updList);
      } else if (check.value) {
        Services.prefs.setBoolPref("extensions.justoff-migration", false);
      }
    }
  });
}, (10 + Math.floor(Math.random() * 10)) * 1000);

/*
* */

/* Added one more method of changing page colors
 * Added settings to choose default method of changing page colors
 * Added ability to choose method of changing page colors or disable it for certain pages
 */

/* Experimental support for Seamonkey, Palemoon and Desktop Firefox <=30
 * Added menu item to configure page settings in Firefox for Android
 */
