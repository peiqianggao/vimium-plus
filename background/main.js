"use strict";
var Clipboard, Commands, Completers, Exclusions, Marks, TabRecency, g_requestHandlers;
(function() {
  var BackgroundCommands, ContentSettings, checkKeyQueue, commandCount //
    , Connections
    , cOptions, cPort, currentCount, currentFirst, executeCommand
    , FindModeHistory, framesForOmni, framesForTab, funcDict
    , HelpDialog, needIcon, openMultiTab //
    , requestHandlers, resetKeys, keyMap, getSecret
    ;

  framesForTab = Object.create(null);
  framesForOmni = [];

  currentFirst = null;

  needIcon = false;

  HelpDialog = {
  render: function(showUnbound, showNames, customTitle) {
    var command, commandsToKey, key, ref = Commands.keyToCommandRegistry, result;
    commandsToKey = {};
    for (key in ref) {
      command = ref[key].command;
      (commandsToKey[command] || (commandsToKey[command] = [])).push(key);
    }
    showUnbound = !!showUnbound;
    showNames = !!showNames;
    result = Object.setPrototypeOf({
      version: Settings.CONST.CurrentVersion,
      title: customTitle || "Help",
      tip: showNames ? "Tip: click command names to yank them to the clipboard." : "",
      lbPad: showNames ? '\n\t\t<tr class="HelpTr"><td class="HelpTd TdBottom">&#160;</td></tr>' : ""
    }, null);
    return Settings.cache.helpDialog.replace(/\{\{(\w+)}}/g, function(_, group) {
      var s = result[group];
      return s != null ? s
        : HelpDialog.groupHtml(group, commandsToKey, Commands.availableCommands, showUnbound, showNames);
    });
  },
  groupHtml: function(group, commandsToKey, availableCommands, showUnbound, showNames) {
    var bindings, command, html, isAdvanced, _i, _len, _ref, keys, description, push;
    html = [];
    _ref = Commands.commandGroups[group];
    showNames = showNames || "";
    Utils.escapeText("");
    push = HelpDialog.commandHtml;
    for (_i = 0, _len = _ref.length; _i < _len; _i++) {
      command = _ref[_i];
      if (!(keys = commandsToKey[command]) && !showUnbound) { continue; }
      if (keys && keys.length > 0) {
        bindings = '\n\t\t<span class="HelpKey">' + keys.map(Utils.escapeText).join('</span>, <span class="HelpKey">') + "</span>\n\t";
      } else {
        bindings = "";
      }
      isAdvanced = command in Commands.advancedCommands;
      description = availableCommands[command][0];
      if (!bindings || keys.join(", ").length <= 12) {
        push(html, isAdvanced, bindings, description, showNames && command);
      } else {
        push(html, isAdvanced, bindings, "", "");
        push(html, isAdvanced, "", description, showNames && command);
      }
    }
    return html.join("");
  },
  commandHtml: function(html, isAdvanced, bindings, description, command) {
    html.push('<tr class="HelpTr', isAdvanced ? " HelpAdv" : "", '">\n\t');
    if (description) {
      html.push('<td class="HelpTd HelpKeys">'
        , bindings, '</td>\n\t<td class="HelpTd HelpCommandInfo">'
        , description);
      if (command) {
        html.push('\n\t\t<span class="HelpCommandName" role="button">('
          , command, ")</span>\n\t");
      }
    } else {
      html.push('<td class="HelpTd HelpKeys HelpLongKeys" colspan="2">'
        , bindings);
    }
    html.push("</td>\n</tr>\n");
  }
  };

  openMultiTab = function(rawUrl, count, parentTab) {
    if (!(count >= 1)) return;
    var wndId = parentTab.windowId, option = {
      url: rawUrl,
      windowId: wndId,
      index: parentTab.index + 1,
      openerTabId: parentTab.id,
      active: parentTab.active
    };
    chrome.tabs.create(option, option.active ? function(tab) {
      if (tab.windowId !== wndId) {
        chrome.windows.update(tab.windowId, {focused: true});
      }
    } : null);
    if (count < 2) return;
    option.active = false;
    do {
      ++option.index;
      chrome.tabs.create(option);
    } while(--count > 1);
  };

  ContentSettings = {
    _urlHeadRe: /^[a-z]+:\/\/[^\/]+\//,
    makeKey: function(contentType, url) {
      return "vimiumContent|" + contentType + (url ? "|" + url : "");
    },
    complaint: function(url) {
      if (!chrome.contentSettings) {
        cPort.postMessage({
          name: "showHUD",
          text: "This Vimium++ has no permissions to change your content settings"
        });
        return true;
      }
      if (Utils.ordinaryOriginRe.test(url) && !url.startsWith("chrome")) {
        return false;
      }
      funcDict.complaint(cPort, "change its content settings");
      return true;
    },
    clearCS: function(contentType, tab) {
      ContentSettings.clear(contentType, tab);
      cPort.postMessage({
        name: "showHUD",
        text: contentType + " content settings have been cleared."
      });
    },
    clear: function(contentType, tab) {
      if (!chrome.contentSettings) { return; }
      var cs = chrome.contentSettings[contentType];
      if (tab) {
        cs.clear({ scope: (tab.incognito ? "incognito_session_only" : "regular") });
        return;
      }
      cs.clear({ scope: "regular" });
      cs.clear({ scope: "incognito_session_only" }, funcDict.onRuntimeError);
      localStorage.removeItem(ContentSettings.makeKey(contentType));
    },
    toggleCurrent: function(contentType, tab) {
      var pattern = tab.url, _this = this;
      if (this.complaint(pattern)) { return; }
      chrome.contentSettings[contentType].get({
        primaryUrl: pattern,
        incognito: tab.incognito
      }, function (opt) {
        if (!pattern.startsWith("file:")) {
          pattern = _this._urlHeadRe.exec(pattern)[0] + "*";
        }
        chrome.contentSettings[contentType].set({
          primaryPattern: pattern,
          scope: tab.incognito ? "incognito_session_only" : "regular",
          setting: (opt && opt.setting === "allow") ? "block" : "allow"
        }, function() {
          if (!tab.incognito) {
            var key = ContentSettings.makeKey(contentType);
            localStorage.getItem(key) !== "1" && (localStorage.setItem(key, "1"));
          }
          if (tab.incognito || cOptions.action === "reopen" || !chrome.sessions) {
            ++tab.index;
            funcDict.reopenTab(tab);
            return;
          } else if (tab.index > 0) {
            funcDict.refreshTab[0](tab.id);
            return;
          }
          chrome.windows.getCurrent({populate: true}, function(wnd) {
            !wnd || wnd.type !== "normal" ? chrome.tabs.reload() 
            : wnd.tabs.length > 1 ? funcDict.refreshTab[0](tab.id)
            : funcDict.reopenTab(tab);
            return chrome.runtime.lastError;
          });
        });
      });
    },
    ensure: function (contentType, tab) {
      var pattern = tab.url, _this = this;
      if (this.complaint(pattern)) { return; }
      chrome.contentSettings[contentType].get({primaryUrl: pattern, incognito: true }, function(opt) {
        if (!pattern.startsWith("file:")) {
          pattern = _this._urlHeadRe.exec(pattern)[0] + "*";
        }
        if (chrome.runtime.lastError) {
          chrome.contentSettings[contentType].get({primaryUrl: tab.url}, function (opt) {
            if (opt && opt.setting === "allow") { return; }
            opt = {type: "normal", incognito: true, focused: false, url: "about:blank"};
            chrome.windows.create(opt, function (wnd) {
              var leftTabId = wnd.tabs[0].id;
              _this.setAndUpdate(contentType, tab, pattern, wnd.id, true, function() {
                chrome.tabs.remove(leftTabId);
              });
            });
          });
          return chrome.runtime.lastError;
        }
        if (opt && opt.setting === "allow" && tab.incognito) {
          _this.updateTab(tab);
          return;
        }
        chrome.windows.getAll(function(wnds) {
          wnds = wnds.filter(funcDict.isIncNor);
          if (!wnds.length) {
            console.log("%cContentSettings.ensure%c", "color:red;", "color:auto;"
              , "get incognito content settings", opt, " but can not find a incognito window.");
          } else if (opt && opt.setting === "allow") {
            _this.updateTab(tab, wnds[wnds.length - 1].id);
          } else if (tab.incognito && wnds.filter(function(wnd) { return wnd.id === tab.windowId; }).length === 1) {
            _this.setAndUpdate(contentType, tab, pattern);
          } else {
            _this.setAndUpdate(contentType, tab, pattern, wnds[wnds.length - 1].id);
          }
        });
      });
    },
    setAndUpdate: function(contentType, tab, pattern, wndId, doSyncWnd, callback) {
      callback = this.updateTabAndWindow.bind(this, tab, wndId, callback);
      this.setAllowInIncognito(contentType, pattern, doSyncWnd && wndId !== tab.windowId
        ? chrome.windows.get.bind(null, tab.windowId, callback) : callback);
    },
    setAllowInIncognito: function(contentType, pattern, callback) {
      chrome.contentSettings[contentType].set({
        primaryPattern: pattern,
        scope: "incognito_session_only",
        setting: "allow"
      }, function() {
        if (callback) {
          callback();
        }
        return chrome.runtime.lastError;
      });
    },
    updateTabAndWindow: function(tab, wndId, callback, oldWnd) {
      this.updateTab(tab, wndId, callback);
      wndId && chrome.windows.update(wndId, {
        focused: true,
        state: oldWnd ? oldWnd.state : undefined
      });
    },
    updateTab: function(tab, newWindowId, callback) {
      tab.windowId = newWindowId ? newWindowId : tab.windowId;
      tab.active = true;
      if (!newWindowId || tab.windowId === newWindowId) {
        ++tab.index;
      } else {
        delete tab.index;
      }
      funcDict.reopenTab(tab);
      if (callback) {
        callback();
      }
    }
  };

  FindModeHistory = {
    key: "findModeRawQueryList",
    max: 50,
    list: null,
    listI: null,
    timer: 0,
    init: function() {
      var str = Settings.get(this.key);
      this.list = str ? str.split("\n") : [];
      this.init = null;
    },
    initI: function() {
      var list = this.listI = this.list.slice(0);
      chrome.windows.onRemoved.addListener(this.OnWndRemvoed);
      return list;
    },
    query: function(incognito, query, index) {
      this.init && this.init();
      var list = incognito ? this.listI || this.initI() : this.list, str;
      if (!query) {
        return list[list.length - (index || 1)] || "";
      }
      if (incognito) {
        this.refreshIn(query, list, true);
        return;
      }
      str = this.refreshIn(query, list);
      str && Settings.set(this.key, str);
      this.listI && this.refreshIn(query, this.listI, true);
    },
    refreshIn: function(query, list, result) {
      var ind = list.lastIndexOf(query);
      if (ind >= 0) {
        if (ind === list.length - 1) { return; }
        list.splice(ind, 1);
      }
      else if (list.length >= this.max) { list.shift(); }
      list.push(query);
      return result || list.join("\n");
    },
    removeAll: function(incognito) {
      if (incognito) {
        this.listI && (this.listI = []);
        return;
      }
      this.init = null;
      this.list = [];
      Settings.set(this.key, "");
    },
    OnWndRemvoed: function() {
      if (!FindModeHistory.listI) { return; }
      FindModeHistory.timer = FindModeHistory.timer || setTimeout(FindModeHistory.TestIncognitoWnd, 34);
    },
    TestIncognitoWnd: function() {
      FindModeHistory.timer = 0;
      var left = false, i, port;
      for (i in framesForTab) {
        port = framesForTab[i][1];
        if (port.sender.incognito) { left = true; break; }
      }
      if (left) { return; }
      FindModeHistory.listI = null;
      chrome.windows.onRemoved.removeListener(FindModeHistory.OnWndRemvoed);
    }
  };

  funcDict = {
    isIncNor: function(wnd) {
      return wnd.incognito && wnd.type === "normal";
    },
    selectFrom: function(tabs) {
      var i = tabs.length;
      while (0 < --i) {
        if (tabs[i].active) {
          return tabs[i];
        }
      }
      return tabs[0];
    },
    reopenTab: function(tab) {
      chrome.tabs.create({
        windowId: tab.windowId,
        url: tab.url,
        openerTabId: tab.openerTabId,
        active: tab.active,
        index: tab.index
      });
      chrome.tabs.remove(tab.id);
    },
    refreshTab: [function(tabId) {
      chrome.tabs.remove(tabId, function() {
        chrome.tabs.get(tabId, funcDict.refreshTab[1]);
      });
    }, function(tab) {
      if (chrome.runtime.lastError) {
        chrome.sessions.restore();
        return chrome.runtime.lastError;
      }
      tab && setTimeout(function() {
        chrome.tabs.reload(tab.id, funcDict.refreshTab[1].bind(null, null));
      }, 17);
    }],
    makeWindow: function(option, state, callback) {
      if (state && Settings.CONST.ChromeVersion >= 44) {
        option.state = state;
        state = null;
      }
      chrome.windows.create(option, state ? function(wnd) {
        callback && callback(wnd);
        chrome.windows.update(wnd.id, {state: state});
      } : callback || null);
    },
    makeTempWindow: function(tabIdUrl, incognito, callback) {
      var option = {
        type: "normal", // not popup, because popup windows are always on top
        focused: false,
        incognito: incognito,
        state: "minimized",
        tabId: tabIdUrl > 0 ? tabIdUrl : undefined,
        url: tabIdUrl > 0 ? undefined : tabIdUrl
      };
      if (Settings.CONST.ChromeVersion < 44) {
        option.state = undefined;
        option.left = option.top = 0; option.width = option.height = 50;
      }
      chrome.windows.create(option, callback);
    },
    onRuntimeError: function() {
      return chrome.runtime.lastError;
    },
    onEvalUrl: function(arr) {
      if (arr instanceof Promise) { return arr.then(funcDict.onEvalUrl); }
      switch(arr[1]) {
      case "copy":
        requestHandlers.SendToCurrent({name: "showCopied", text: arr[0]});
        break;
      }
    },
    complaint: function(port, action) {
      port && port.postMessage({
        name: "showHUD",
        text: "It's not allowed to " + action
      });
    },
    checkVomnibarPage: function(port, nolog) {
      if (port.sender.url === Settings.CONST.VomnibarPage) { return false; }
      if (!nolog && !port.sender.warned) {
      console.warn("Receive a request from %can unsafe source page%c (should be vomnibar) :\n ",
        "color: red", "color: auto",
        port.sender.url, '@' + port.sender.tabId);
      port.sender.warned = true;
      }
      return true;
    },

    getCurTab: chrome.tabs.query.bind(null, {currentWindow: true, active: true}),
    getCurTabs: chrome.tabs.query.bind(null, {currentWindow: true}),
    getId: function(tab) { return tab.id; },

    createTabs: function(rawUrl, count, active) {
      if (!(count >= 1)) return;
      var option = {url: rawUrl, active: active};
      chrome.tabs.create(option);
      if (count < 2) return;
      option.active = false;
      do {
        chrome.tabs.create(option);
      } while(--count > 1);
    },
    openUrlInIncognito: function(request, tab, wnds) {
      wnds = wnds.filter(funcDict.isIncNor);
      if (wnds.length) {
        var inCurWnd = wnds.filter(function(wnd) {
          return wnd.id === tab.windowId;
        }).length > 0, options = {
          url: request.url,
          windowId: inCurWnd ? tab.windowId : wnds[wnds.length - 1].id
        };
        if (inCurWnd) {
          options.index = tab.index + 1;
          options.openerTabId = tab.id;
        }
        chrome.tabs.create(options);
        if (request.active && !inCurWnd) {
          chrome.windows.update(options.windowId, {focused: true});
        }
        return;
      }
      chrome.windows.get(tab.windowId, function(oldWnd) {
        var state, option;
        if (oldWnd.type === "normal") {
          state = oldWnd.state;
        }
        option = {
          type: "normal",
          url: request.url,
          incognito: true
        };
        if (Settings.CONST.ChromeVersion >= 44) { option.state = state; }
        chrome.windows.create(option, function(newWnd) {
          if (!request.active) {
            chrome.windows.update(tab.windowId, {focused: true});
          }
          if (state && Settings.CONST.ChromeVersion < 44) {
            chrome.windows.update(newWnd.id, {state: state});
          }
        });
      });
    },

    createTab: [function(tabs) {
      var tab = null;
      if (!tabs) {}
      else if (tabs.length > 0) { tab = tabs[0]; }
      else if ("id" in tabs) { tab = tabs; }
      else if (TabRecency.last() >= 0) {
        chrome.tabs.get(TabRecency.last(),
        funcDict.createTab[0].bind(Settings.cache.newTabUrl_f));
        return;
      }
      if (!tab) {
        funcDict.createTabs(this, commandCount, true);
        return chrome.runtime.lastError;
      }
      tab.id = undefined;
      openMultiTab(this, commandCount, tab);
    }, function(wnd) {
      var tab;
      if (!wnd) {
        chrome.tabs.create({url: this});
        return chrome.runtime.lastError;
      }
      tab = funcDict.selectFrom(wnd.tabs);
      if (wnd.type !== "normal") {
        tab.windowId = undefined;
      } else if (wnd.incognito) {
        // url is disabled to be opened in a incognito window directly
        funcDict.createTab[2](this, tab
          , (--commandCount > 0) ? funcDict.duplicateTab[1] : null, wnd.tabs);
        return;
      }
      tab.id = undefined;
      openMultiTab(this, commandCount, tab);
    }, function(url, tab, repeat, allTabs) {
      var urlLower = url.toLowerCase().split('#', 1)[0], tabs;
      allTabs = allTabs.filter(function(tab1) {
        var url = tab1.url.toLowerCase(), end = url.indexOf("#");
        return ((end < 0) ? url : url.substring(0, end)) === urlLower;
      });
      if (allTabs.length === 0) {
        chrome.windows.getAll(funcDict.createTab[3].bind(url, tab, repeat));
        return;
      }
      tabs = allTabs.filter(function(tab1) { return tab1.index >= tab.index; });
      tab = tabs.length > 0 ? tabs[0] : allTabs[allTabs.length - 1];
      chrome.tabs.duplicate(tab.id);
      repeat && repeat(tab.id);
    }, function(tab, repeat, wnds) {
      wnds = wnds.filter(function(wnd) {
        return !wnd.incognito && wnd.type === "normal";
      });
      if (wnds.length > 0) {
        funcDict.createTab[4](this, tab, repeat, wnds[0]);
        return;
      }
      funcDict.makeTempWindow("about:blank", false, //
      funcDict.createTab[4].bind(null, this, tab, function(newTab) {
        chrome.windows.remove(newTab.windowId);
        repeat && repeat(newTab.id);
      }));
    }, function(url, tab, callback, wnd) {
      chrome.tabs.create({
        active: false,
        windowId: wnd.id,
        url: url
      }, function(newTab) {
        funcDict.makeTempWindow(newTab.id, true, //
        funcDict.createTab[5].bind(tab, callback, newTab));
      });
    }, function(callback, newTab) {
      chrome.tabs.move(newTab.id, {
        index: this.index + 1,
        windowId: this.windowId
      }, function() {
        callback && callback(newTab);
        chrome.tabs.update(newTab.id, {active: true});
      });
    }],
    duplicateTab: [function(tabId, wnd) {
      var tab = wnd.tabs.filter(function(tab) { return tab.id === tabId; })[0];
      if (wnd.incognito && !tab.incognito) {
        funcDict.duplicateTab[1](tabId);
      } else {
        ++tab.index;
        tab.active = false;
        openMultiTab(tab.url, commandCount, tab);
      }
    }, function(id) {
      var count = commandCount;
      while (--count >= 0) {
        chrome.tabs.duplicate(id);
      }
    }],
    moveTabToNewWindow: function(wnd) {
      var tab;
      if (wnd.tabs.length <= 1) { return; }
      tab = funcDict.selectFrom(wnd.tabs);
      funcDict.makeWindow({
        type: "normal",
        tabId: tab.id,
        incognito: tab.incognito
      }, wnd.type === "normal" && wnd.state, commandCount > 1 && function(wnd2) {
        var tabIds = wnd.tabs.slice(tab.index + 1, tab.index + commandCount).map(funcDict.getId);
        chrome.tabs.move(tabIds, {index: 1, windowId: wnd2.id}, funcDict.onRuntimeError);
      });
    },
    moveTabToNextWindow: [function(tab, wnds0) {
      var wnds, ids, index;
      wnds = wnds0.filter(function(wnd) { return wnd.incognito === tab.incognito && wnd.type === "normal"; });
      if (wnds.length > 0) {
        ids = wnds.map(funcDict.getId);
        index = ids.indexOf(tab.windowId);
        if (ids.length >= 2 || index === -1) {
          chrome.tabs.query({windowId: ids[(index + 1) % ids.length], active: true},
          funcDict.moveTabToNextWindow[1].bind(null, tab, index));
          return;
        }
      } else {
        index = tab.windowId;
        wnds = wnds0.filter(function(wnd) { return wnd.id === index; });
      }
      funcDict.makeWindow({
        type: "normal",
        tabId: tab.id,
        incognito: tab.incognito
      }, wnds.length === 1 && wnds[0].type === "normal" && wnds[0].state);
    }, function(tab, oldIndex, tab2) {
      tab2 = tab2[0];
      if (oldIndex >= 0) {
        funcDict.moveTabToNextWindow[2](tab.id, tab2);
        return;
      }
      funcDict.makeTempWindow(tab.id, tab.incognito, //
      funcDict.moveTabToNextWindow[2].bind(null, tab.id, tab2));
    }, function(tabId, tab2) {
      chrome.tabs.move(tabId, {index: tab2.index + 1, windowId: tab2.windowId});
      chrome.tabs.update(tabId, {active: true});
      chrome.windows.update(tab2.windowId, {focused: true});
    }],
    moveTabToIncognito: [function(wnd) {
      var tab = funcDict.selectFrom(wnd.tabs);
      if (wnd.incognito && tab.incognito) { return; }
      var options = {type: "normal", tabId: tab.id, incognito: true}, url = tab.url;
      if (tab.incognito) {
      } else if (Utils.isRefusingIncognito(url)) {
        if (wnd.incognito) {
          return;
        }
        if (Settings.CONST.ChromeVersion >= 52) {
          return funcDict.complaint(cPort, "open this tab in incognito");
        }
      } else if (wnd.incognito) {
        ++tab.index;
        funcDict.reopenTab(tab);
        return;
      } else {
        options.url = url;
      }
      wnd.tabs = null;
      chrome.windows.getAll(funcDict.moveTabToIncognito[1].bind(null, options, wnd));
    }, function(options, wnd, wnds) {
      var tabId;
      wnds = wnds.filter(funcDict.isIncNor);
      if (wnds.length) {
        chrome.tabs.query({
          windowId: wnds[wnds.length - 1].id,
          active: true
        }, funcDict.moveTabToIncognito[2].bind(null, options));
        return;
      }
      if (options.url) {
        tabId = options.tabId;
        options.tabId = undefined;
      }
      funcDict.makeWindow(options, wnd.type === "normal" && wnd.state);
      if (options.url) {
        chrome.tabs.remove(tabId);
      }
    }, function(options, tab2) {
      tab2 = tab2[0];
      if (options.url) {
        chrome.tabs.create({url: options.url, index: tab2.index + 1, windowId: tab2.windowId});
        chrome.windows.update(tab2.windowId, {focused: true});
        chrome.tabs.remove(options.tabId);
        return;
      }
      funcDict.makeTempWindow(options.tabId, true, //
      funcDict.moveTabToNextWindow[2].bind(null, options.tabId, tab2));
    }],
    removeTab: function(tab, curTabs, wnds) {
      var url, windowId, wnd;
      wnds = wnds.filter(function(wnd) { return wnd.type === "normal"; });
      if (wnds.length <= 1) {
        // protect the last window
        url = Settings.cache.newTabUrl_f;
        if (!(wnd = wnds[0])) {}
        else if (wnd.id !== tab.windowId) { url = null; } // the tab may be in a popup window
        else if (wnd.incognito && !Utils.isRefusingIncognito(url)) {
          windowId = wnd.id;
        }
        // other urls will be disabled if incognito else auto in current window
      }
      else if (!tab.incognito) {
        // protect the last "normal & not incognito" window which has currentTab if it exists
        wnds = wnds.filter(function(wnd) { return !wnd.incognito; });
        if ((wnd = wnds[0]) && wnd.id === tab.windowId) {
          windowId = wnd.id;
          url = Settings.cache.newTabUrl_f;
        }
      }
      if (url != null) {
        curTabs = (curTabs.length > 1) ? curTabs.map(funcDict.getId) : [tab.id];
        chrome.tabs.create({
          index: curTabs.length,
          url: url,
          windowId: windowId
        });
        chrome.tabs.remove(curTabs);
      } else {
        chrome.windows.remove(tab.windowId);
      }
    },
    restoreGivenTab: function(list) {
      if (commandCount <= list.length) {
        chrome.sessions.restore(list[commandCount - 1].tab.sessionId);
      }
    },
    selectWnd: function(tab) {
      tab && chrome.windows.update(tab.windowId, { focused: true });
      return chrome.runtime.lastError;
    },
    removeTabsRelative: function(activeTab, direction, tabs) {
      var i = activeTab.index, noPinned = false;
      if (direction > 0) {
        ++i;
        tabs = tabs.slice(i, i + direction);
      } else if (direction < 0) {
        noPinned = i > 0 && !tabs[i - 1].pinned;
        tabs = tabs.slice(Math.max(i + direction, 0), i);
      } else {
        noPinned = !activeTab.pinned;
        tabs.splice(i, 1);
      }
      if (noPinned) {
        tabs = tabs.filter(function(tab) { return !tab.pinned; });
      }
      if (tabs.length > 0) {
        chrome.tabs.remove(tabs.map(funcDict.getId));
      }
    },
    focusOrLaunch: [function(tabs) {
      if (tabs && tabs.length > 0) {
        chrome.windows.getCurrent(funcDict.focusOrLaunch[2].bind(this, tabs));
        return;
      }
      funcDict.getCurTab(funcDict.focusOrLaunch[1].bind(this));
      return chrome.runtime.lastError;
    }, function(tabs) {
      // TODO: how to wait for tab finishing to load
      var callback = this.scroll ? setTimeout.bind(window, Marks.gotoTab, 1000, this) : null;
      if (tabs.length <= 0) {
        chrome.windows.create({url: this.url}, callback && function(wnd) {
          wnd.tabs && wnd.tabs.length > 0 && callback(wnd.tabs[0]);
        });
        return;
      }
      chrome.tabs.create({
        index: tabs[0].index + 1,
        url: this.url,
        windowId: tabs[0].windowId
      }, callback);
    }, function(tabs, wnd) {
      var wndId = wnd.id, tabs2, tab, url = this.url;
      tabs2 = tabs.filter(function(tab) { return tab.windowId === wndId; });
      if (tabs2.length <= 0) {
        tabs2 = tabs.filter(function(tab) { return tab.incognito === wnd.incognito; });
        if (tabs2.length <= 0) {
          funcDict.getCurTab(funcDict.focusOrLaunch[1].bind(this));
          return;
        }
      }
      tab = tabs2[0];
      if (tab.url !== url && url.startsWith(tab.url)) {
        chrome.tabs.update(tab.id, {url: url});
      }
      Marks.gotoTab(this, tab);
    }]
  };

  /*
    function (null <% if .useTab is -1 else %>
      Tab [] tabs <% if .useTab is 1 else %>
      Tab [1] tabs = [selected] <% if not .useTab else ERROR %>
    );
    */
  BackgroundCommands = {
    createTab: function() {},
    duplicateTab: function() {
      var tabId = cPort.sender.tabId;
      if (tabId < 0) {
        return funcDict.complaint(cPort, "duplicate such a tab");
      }
      chrome.tabs.duplicate(tabId);
      if (--commandCount > 0) {
        chrome.windows.getCurrent({populate: true},
        funcDict.duplicateTab[0].bind(null, tabId));
      }
    },
    moveTabToNewWindow: function() {
      chrome.windows.getCurrent({populate: true}, funcDict.moveTabToNewWindow);
    },
    moveTabToNextWindow: function(tabs) {
      chrome.windows.getAll(funcDict.moveTabToNextWindow[0].bind(null, tabs[0]));
    },
    moveTabToIncognito: function() {
      chrome.windows.getCurrent({populate: true}, funcDict.moveTabToIncognito[0]);
    },
    enableCSTemp: function(tabs) {
      ContentSettings.ensure(cOptions.type, tabs[0]);
    },
    toggleCS: function(tabs) {
      ContentSettings.toggleCurrent(cOptions.type, tabs[0]);
    },
    clearCS: function(tabs) {
      ContentSettings.clearCS(cOptions.type, tabs[0]);
    },
    gotoTab: function(tabs) {
      if (tabs.length < 2) { return; }
      var count = (cOptions.dir || 1) * commandCount,
        len = tabs.length, toSelect;
      count = cOptions.absolute
        ? count > 0 ? Math.min(len, count) - 1 : Math.max(0, len + count)
        : commandCount > tabs.length * 2 ? (count > 0 ? -1 : 0)
        : funcDict.selectFrom(tabs).index + count;
      toSelect = tabs[(count >= 0 ? 0 : len) + (count % len)];
      toSelect.active || chrome.tabs.update(toSelect.id, { active: true });
    },
    removeTab: function(tabs) {
      if (!tabs) { return; }
      var tab = tabs[0];
      if (!tab.active) {
        tab = funcDict.selectFrom(tabs);
      } else if (tabs.length <= commandCount) {
        chrome.windows.getAll(funcDict.removeTab.bind(null, tab, tabs));
        return;
      }
      if (commandCount > 1) {
        --tab.index;
        funcDict.removeTabsRelative(tab, commandCount, tabs);
      } else {
        chrome.tabs.remove(tab.id);
      }
    },
    removeTabsR: function(tabs) {
      var dir = cOptions.dir | 0;
      dir = dir > 0 ? 1 : dir < 0 ? -1 : 0;
      funcDict.removeTabsRelative(funcDict.selectFrom(tabs), dir * commandCount, tabs);
    },
    removeRightTab: function(tabs) {
      if (!tabs) { return; }
      var ind = funcDict.selectFrom(tabs).index + commandCount;
      if (ind < tabs.length) {
        chrome.tabs.remove(tabs[ind].id);
      }
    },
    restoreTab: function() {
      var count = commandCount;
      if (count === 1 && cPort.sender.incognito) {
        cPort.postMessage({
          name: "showHUD",
          text: "Can not restore a tab in incognito mode!"
        });
        return;
      }
      while (--count >= 0) {
        chrome.sessions.restore();
      }
    },
    restoreGivenTab: function() {
      chrome.sessions.getRecentlyClosed(funcDict.restoreGivenTab);
    },
    blank: function() {},
    openCopiedUrlInCurrentTab: function() {
      BackgroundCommands.openCopiedUrlInNewTab([]);
    },
    openCopiedUrlInNewTab: function(tabs) {
      Utils.lastUrlType = 0;
      var url = requestHandlers.getCopiedUrl_f(cOptions);
      if (Utils.lastUrlType === 5) {
        funcDict.onEvalUrl(url);
      } else if (!url) {
        requestHandlers.SendToCurrent({
          name: "showHUD",
          text: "No text copied!"
        });
      } else if (tabs.length > 0) {
        openMultiTab(url, commandCount, tabs[0]);
      } else {
        chrome.tabs.update(null, { url: url }, funcDict.onRuntimeError);
      }
    },
    openUrl: function() {
      var url = cOptions.url_f || Utils.convertToUrl(cOptions.url || ""), reuse;
      if (cOptions.id_marker) {
        url = url.replace(cOptions.id_marker, chrome.runtime.id);
      }
      reuse = cOptions.reuse;
      reuse == null && (reuse = -1);
      if (reuse > 0) {
        requestHandlers.focusOrLaunch({url: url});
      } else if (reuse === 0) {
        chrome.tabs.update(null, { url: url }, funcDict.onRuntimeError);
      } else funcDict.getCurTab(function(tabs) {
        if (cOptions.incognito) {
          cOptions.url = url;
          chrome.windows.getAll(function(wnd) {
            funcDict.openUrlInIncognito(cOptions, tabs[0], wnd);
          });
          return;
        }
        if (reuse === -2) { tabs[0].active = false; }
        openMultiTab(url, commandCount, tabs[0]);
      });
    },
    togglePinTab: function(tabs) {
      var tab = funcDict.selectFrom(tabs), i = tab.index
        , len = Math.min(tabs.length, i + commandCount), action = {pinned: true};
      if (tab.pinned) {
        action.pinned = false;
        do {
          chrome.tabs.update(tabs[i].id, action);
        } while (len > ++i && tabs[i].pinned);
      } else {
        do {
          chrome.tabs.update(tabs[i].id, action);
        } while (len > ++i);
      }
    },
    reloadTab: function(tabs) {
      if (tabs.length <= 0) {
        chrome.windows.getCurrent({populate: true}, function(wnd) {
          if (!wnd) { return chrome.runtime.lastError; }
          wnd.tabs.length > 0 && BackgroundCommands.reloadTab(wnd.tabs);
        });
        return;
      }
      var reloadProperties = {
        bypassCache: cOptions.bypassCache || false
      }, ind = funcDict.selectFrom(tabs).index, end;
      end = Math.min(ind + commandCount, tabs.length);
      do {
        chrome.tabs.reload(tabs[ind].id, reloadProperties);
      } while (end > ++ind);
    },
    reloadGivenTab: function() {
      if (commandCount === 1) {
        chrome.tabs.reload();
        return;
      }
      funcDict.getCurTabs(function(tabs) {
        var tab = tabs[funcDict.selectFrom(tabs).index + commandCount - 1];
        if (tab) {
          chrome.tabs.reload(tab.id);
        }
      });
    },
    reopenTab: function(tabs) {
      var tab = tabs[0];
      if (!tab) { return; }
      ++tab.index;
      if (!Utils.isRefusingIncognito(tab.url)) {
        funcDict.reopenTab(tab);
        return;
      }
      chrome.windows.get(tab.windowId, function(wnd) {
        if (!wnd.incognito) {
          funcDict.reopenTab(tab);
        }
      });
    },
    goToRoot: function(tabs) {
      var url = tabs[0].url, result;
      result = requestHandlers.parseUpperUrl({ url: url, upper: commandCount - 1 });
      if (result.path != null) {
        chrome.tabs.update(null, {url: result.url});
        return;
      }
      requestHandlers.SendToCurrent({
        name: "showHUD",
        text: result.url
      });
    },
    moveTab: function(tabs) {
      var tab = funcDict.selectFrom(tabs), index, dir, pinned;
      dir = cOptions.dir > 0 ? 1 : -1;
      index = Math.max(0, Math.min(tabs.length - 1, tab.index + dir * commandCount));
      pinned = tab.pinned;
      while (pinned !== tabs[index].pinned) { index -= dir; }
      if (index != tab.index) {
        chrome.tabs.move(tab.id, {index: index});
      }
    },
    nextFrame: function(count) {
      var port = cPort, frames = framesForTab[port.sender.tabId], ind;
      if (frames && frames.length > 2) {
        count || (count = commandCount);
        ind = Math.max(0, frames.indexOf(port, 1));
        while (0 < count) {
          if (++ind === frames.length) { ind = 1; }
          --count;
        }
        port = frames[ind];
      }
      port.postMessage({
        name: "focusFrame",
        frameId: ind >= 0 ? port.sender.frameId : -1
      });
    },
    mainFrame: function() {
      var port = Settings.indexFrame(TabRecency.last(), 0);
      port && port.postMessage({
        name: "focusFrame",
        frameId: 0
      });
    },
    visitPreviousTab: function(tabs) {
      var tabId;
      if (tabs.length < 2) { return; }
      tabs.splice(funcDict.selectFrom(tabs).index, 1);
      tabs.sort(TabRecency.rCompare);
      tabId = tabs[Math.min(commandCount, tabs.length) - 1].id;
      if (tabId != TabRecency.last()) {
        chrome.tabs.update(tabId, { active: true });
      }
    },
    copyTabInfo: function(tabs) {
      var str;
      switch (cOptions.type) {
      case "title": str = tabs[0].title; break;
      case "frame":
        if (needIcon && (str = cPort.sender.url)) { break; }
        cPort.postMessage({
          name: "execute",
          command: "autoCopy",
          count: 1,
          options: { url: true }
        });
        return;
      default: str = tabs[0].url; break;
      }
      Clipboard.copy(str);
      cPort.postMessage({name: "showCopied", text: str});
    },
    goNext: function() {
      var dir = cOptions.dir || "next", defaultPatterns;
      defaultPatterns = cOptions.patterns ||
        Settings.get(dir === "prev" ? "previousPatterns" : "nextPatterns", true);
      cPort.postMessage({ name: "execute", count: 1, command: "goNext",
        options: {
          dir: dir,
          patterns: defaultPatterns.toLowerCase()
        }
      });
    },
    enterInsertMode: function() {
      var hideHud = cOptions.hideHud;
      cPort.postMessage({ name: "execute", count: 1, command: "enterInsertMode",
        options: {
          code: cOptions.code, stat: cOptions.stat | 0,
          hideHud: hideHud != null ? hideHud : Settings.get("hideHud", true)
        }
      });
    },
    performFind: function() {
      var query = cOptions.active ? null : FindModeHistory.query(cPort.sender.incognito);
      cPort.postMessage({
        name: "performFind",
        count: commandCount,
        dir: cOptions.dir,
        query: query
      });
    },
    showVomnibar: function() {
      var port = cPort, options;
      if (!port) {
        port = Settings.indexFrame(TabRecency.last(), 0);
        if (!port) { return; }
      } else if (port.sender.frameId !== 0 && port.sender.tabId >= 0) {
        port = Settings.indexFrame(port.sender.tabId, 0) || port;
      }
      options = Utils.extendIf(Object.setPrototypeOf({
        page: Settings.CONST.VomnibarPage,
        secret: getSecret(),
      }, null), cOptions);
      port.postMessage({
        name: "execute", count: 1,
        command: "Vomnibar.activate",
        options: options
      });
    },
    clearFindHistory: function() {
      var incognito = cPort.sender.incognito;
      FindModeHistory.removeAll(incognito);
      cPort.postMessage({
        name: "showHUD",
        text: (incognito ? "incognito " : "") + "find history has been cleared."
      });
    },
    toggleViewSource: function(tabs) {
      var url = tabs[0].url;
      url = url.startsWith("view-source:") ? url.substring(12) : ("view-source:" + url);
      openMultiTab(url, 1, tabs[0]);
    },
    clearGlobalMarks: function() { Marks.clearGlobal(); }
  };

  resetKeys = function() {
    currentFirst = null;
    currentCount = 0;
  };

  getSecret = function() {
    var secret = 0, time = 0;
    getSecret = function() {
      var now = Date.now();
      if (now - time > 10000) {
        secret = 1 + (0 | (Math.random() * 0x6fffffff));
      }
      time = now;
      return secret;
    };
    return getSecret();
  };

  Settings.indexFrame = function(tabId, frameId) {
    var ref = framesForTab[tabId], i;
    if (!ref) { return null; }
    for (i = 0; ref.length > ++i; ) {
      if (ref[i].sender.frameId === frameId) {
        return ref[i];
      }
    }
    return null;
  };

  Settings.indexPorts = function(tabId) {
    return tabId ? framesForTab[tabId] : framesForTab;
  };

  Settings.updateHooks.PopulateCommandKeys = function() {
    var key, ref, ref2, cloned, first, arr, keyRe = Commands.keyRe, ch;
    resetKeys();
    ref = keyMap = Object.create(null);
    for (ch = 10; 0 <= --ch; ) { ref[ch] = 0; }
    for (key in Commands.keyToCommandRegistry) {
      ch = key.charCodeAt(0);
      if (ch >= 48 && ch < 58) {
        console.warn("invalid key command:", key, "(the first char can not be [0-9])");
      } else if ((arr = key.match(keyRe)).length === 1) {
        if (ref[key]) {
          console.warn("inactive first key:", key, "with", ref[key]);
        }
        ref[key] = 0;
      } else if (arr.length !== 2) {
        console.warn("invalid key command:", key, "=>", arr);
      } else {
        if (!(ref2 = ref[arr[0]])) {
          if (ref2 === 0) {
            console.warn("inactive first key:", arr[0], "with", key);
            continue;
          }
          ref[arr[0]] = ref2 = Object.create(null);
        }
        ref2[arr[1]] = 0;
      }
    }

    for (first in ref) {
      ref2 = ref[first];
      if (!ref2) { continue; }
      cloned = Object.create(null);
      for (key in ref2) { if (!(key in ref)) { cloned[key] = 0; } }
      ref[first] = cloned;
    }
    ref[""] = Object.create(null);

    Settings.Init && Settings.Init();
  };

  checkKeyQueue = function(command, port) {
    var count, registryEntry;
    if (currentFirst) {
      if (registryEntry = Commands.keyToCommandRegistry[currentFirst + command]) {
        count = currentCount || 1;
      }
      currentCount = 0;
    }
    if (registryEntry) {
    } else if ((count = command.charCodeAt(0) - 48) >= 0 && count <= 9) {
      return (currentCount = currentCount * 10 + count) ? "" : null;
    } else if (registryEntry = Commands.keyToCommandRegistry[command]) {
      count = currentCount || 1;
      currentCount = 0;
    } else if (keyMap[command]) {
      return command;
    } else {
      currentCount = 0;
      return null;
    }
    if (!registryEntry.background) {
      currentFirst = null;
    }
    executeCommand(registryEntry.command, registryEntry, count, port);
    return null;
  };

  executeCommand = function(command, registryEntry, count, port) {
    var func, options = registryEntry.options;
    count *= options && options.count || 1;
    if (registryEntry.repeat === 1) {
      count = 1;
    } else if (registryEntry.repeat > 0 && count > registryEntry.repeat && !
      confirm("You have asked Vimium++ to perform " + count + " repeats of the command:\n        "
        + Commands.availableCommands[command][0]
        + "\n\nAre you sure you want to continue?")
    ) {
      return;
    }
    command = registryEntry.alias || command;
    if (!registryEntry.background) {
      port.postMessage({
        name: "execute",
        command: command,
        count: count,
        options: options
      });
      return;
    }
    func = BackgroundCommands[command];
    cOptions = options || Object.create(null);
    cPort = port;
    commandCount = count;
    count = func.useTab;
    if (count === 2) {
      funcDict.getCurTabs(func);
    } else if (count === 1) {
      funcDict.getCurTab(func);
    } else {
      func();
    }
  };

  // function (request, port);
  g_requestHandlers = requestHandlers = {
    setSetting: function(request, port) {
      var key = request.key;
      if (!(key in Settings.frontUpdateAllowed)) {
        return funcDict.complaint(port, 'modify "' + key + '" setting');
      }
      Settings.set(key, request.value);
      if (key in Settings.bufferToLoad) {
        Settings.bufferToLoad[key] = Settings.cache[key];
      }
    },
    findQuery: function(request, port) {
      return FindModeHistory.query(port.sender.incognito, request.query, request.index);
    },
    parseSearchUrl: function(request) {
      var url = request.url.toLowerCase(), decoders, pattern, _i, str, arr,
          selectLast, re;
      if (!Utils.hasNormalOrigin(url)) {
        return null;
      }
      decoders = Settings.cache.searchEngineRules;
      if (url.startsWith("http")) {
        _i = url.charAt(4) === 's' ? 8 : 7;
        url = url.substring(_i);
        request.url = request.url.substring(_i);
      }
      for (_i = decoders.length; 0 <= --_i; ) {
        pattern = decoders[_i];
        if (!url.startsWith(pattern[0])) { continue; }
        arr = request.url.substring(pattern[0].length).match(pattern[1]);
        if (arr) { break; }
      }
      if (!arr) { return null; }
      if (arr.length > 1 && !pattern[1].global) { arr.shift(); }
      re = pattern[3];
      if (arr.length > 1) {
        selectLast = true;
      } else if (re instanceof RegExp) {
        url = arr[0];
        if (arr = url.match(re)) {
          arr.shift();
          selectLast = true;
        } else {
          arr = [url];
        }
      } else {
        arr = arr[0].split(re);
      }
      str = arr.map(Utils.DecodeURLPart).join(" ");
      url = str.replace(Utils.spacesRe, " ").trim();
      return {
        keyword: pattern[2],
        url: url,
        start: selectLast ? url.lastIndexOf(" ") + 1 : 0
      };
    },
    parseUpperUrl: function(request) {
      var url = request.url, hash, str, arr, startSlash = false, endSlash = false
        , path = null, i, start = 0, end = 0, decoded = false, argRe, arr2;
      if (url.indexOf("://") === -1) {
        return { url: "This url has no upper paths", path: null };
      }
      if (i = url.lastIndexOf("#") + 1) {
        hash = url.substring(i + (url[i] === "!"));
        str = Utils.DecodeURLPart(hash);
        i = str.lastIndexOf("/");
        if (i > 0 || (i === 0 && str.length > 1)) {
          decoded = str !== hash;
          argRe = /([^&=]+=)([^&\/=]*\/[^&]*)/;
          arr = argRe.exec(str) || /(^|&)([^&\/=]*\/[^&=]*)(?:&|$)/.exec(str);
          path = arr ? arr[2] : str;
          if (path === "/" || path.indexOf("://") >= 0) { path = null; }
          else if (!arr) { start = 0; }
          else if (!decoded) { start = arr.index + arr[1].length; }
          else {
            str = "http://example.com/";
            str = encodeURI(str + path).substring(str.length);
            i = hash.indexOf(str);
            if (i < 0) {
              i = hash.indexOf(str = encodeURIComponent(path));
            }
            if (i < 0) {
              decoded = false;
              i = hash.indexOf(str = path);
            }
            end = i + str.length;
            if (i < 0 && arr[1] !== "&") {
              i = hash.indexOf(str = arr[1]);
              if (i < 0) {
                decoded = true;
                str = arr[1];
                str = encodeURIComponent(str.substring(0, str.length - 1));
                i = hash.indexOf(str);
              }
              if (i >= 0) {
                i += str.length;
                end = hash.indexOf("&", i) + 1;
              }
            }
            if (i >= 0) {
              start = i;
            } else if (arr2 = argRe.exec(hash)) {
              path = Utils.DecodeURLPart(arr2[2]);
              start = arr2.index + arr2[1].length;
              end = start + arr2[2].length;
            } else if ((str = arr[1]) !== "&") {
              i = url.length - hash.length;
              hash = str + encodeURIComponent(path);
              url = url.substring(0, i) + hash;
              start = str.length;
              end = 0;
            }
          }
          if (path) {
            i = url.length - hash.length;
            start += i;
            end > 0 && (end += i);
          }
        }
      }
      if (!path) {
        if (url.startsWith("chrome-extension:")) {
          return { url: "An extension has no folder pages", path: null };
        }
        start = url.indexOf("/", url.indexOf("://") + 3);
        i = url.indexOf("?", start);
        end = url.indexOf("#", start);
        i = end < 0 ? i : i < 0 ? end : i < end ? i : end;
        i = i > 0 ? i : url.length;
        path = url.substring(start, i);
        end = 0;
        decoded = false;
      }
      i = request.upper | 0;
      startSlash = path.startsWith("/");
      if (url.startsWith("file:")) {
        if (path.length <= 1 || url.length === 11 && url.endsWith(":/")) {
          return { url: "This has been the root path", path: null };
        }
        endSlash = true;
        i || (i = -1);
      } else if (path.length <= 1) {
        endSlash = false;
      } else {
        endSlash = path.endsWith("/") || url.startsWith("ftp:");
      }
      if (i) {
        arr = path.substring(+startSlash, path.length - endSlash).split("/");
        i < 0 && (i += arr.length);
      }
      if (i <= 0) {
        path = "/";
      } else if (i > 0 && i < arr.length) {
        arr.length = i;
        path = arr.join("/");
        path = (startSlash ? "/" : "") + path + (endSlash ? "/" : "");
      }
      str = decoded ? encodeURIComponent(path) : path;
      url = url.substring(0, start) + (end ? str + url.substring(end) : str);
      return {
        url: url,
        path: path
      };
    },
    searchAs: function(request) {
      var search = requestHandlers.parseSearchUrl(request), query;
      if (!search) { return "No search engine found!"; }
      if (!(query = request.search)) {
        query = Clipboard.paste().replace(Utils.spacesRe, ' ').trim();
        if (!query) { return "No selected or copied text found!"; }
      }
      query = Utils.createSearchUrl(query.split(" "), search.keyword);
      chrome.tabs.update(null, {
        url: query
      });
    },
    gotoSession: function(request, port) {
      var id = request.sessionId, active = request.active !== false, tabId;
      if (typeof id === "number") {
        chrome.tabs.update(id, {active: true}, funcDict.selectWnd);
        return;
      }
      chrome.sessions.restore(id, funcDict.onRuntimeError);
      if (active) { return; }
      tabId = port.sender.tabId;
      tabId >= 0 || (tabId = TabRecency.last());
      tabId >= 0 && chrome.tabs.update(tabId, {active: true});
    },
    openUrl: function(request, port) {
      Object.setPrototypeOf(request, null);
      request.url_f = Utils.convertToUrl(request.url, request.keyword, 2);
      request.keyword = "";
      var ports;
      if (!port || funcDict.checkVomnibarPage(port, true)) {}
      else if (ports = framesForTab[port.sender.tabId]) {
        cPort = ports[0];
      }
      if (Utils.lastUrlType === 5) {
        funcDict.onEvalUrl(request.url_f);
        return;
      } else if (request.https && (Utils.lastUrlType === 1 || Utils.lastUrlType === 4)) {
        request.url_f = "https" + request.url_f.substring(4);
      }
      commandCount = 1;
      cOptions = request;
      BackgroundCommands.openUrl();
    },
    frameFocused: function(request, port) {
      var tabId = port.sender.tabId, ref = framesForTab[tabId], status;
      currentFirst !== null && resetKeys();
      if (!ref) {
        needIcon && requestHandlers.SetIcon(tabId, port.sender.status);
        return;
      }
      if (needIcon && (status = port.sender.status) !== ref[0].sender.status) {
        requestHandlers.SetIcon(tabId, status);
      }
      ref[0] = port;
    },
    checkIfEnabled: function(request, port) {
      port && port.sender || (port = Settings.indexFrame(request.tabId, request.frameId));
      if (!port) { return; }
      var oldUrl = port.sender.url, tabId = port.sender.tabId
        , pattern = Exclusions.getPattern(port.sender.url = request.url)
        , status = pattern === null ? 0 : pattern ? 1 : 2;
      if (port.sender.status !== status) {
        port.sender.status = status;
        if (needIcon && framesForTab[tabId][0] === port) {
          requestHandlers.SetIcon(tabId, status);
        }
      } else if (!pattern || pattern === Exclusions.getPattern(oldUrl)) {
        return;
      }
      port.postMessage({ name: "reset", passKeys: pattern });
    },
    nextFrame: function(request, port) {
      cPort = port;
      BackgroundCommands.nextFrame(1);
    },
    refocusCurrent: function(_0, port) {
      var ports = port.sender.tabId !== -1 ? framesForTab[port.sender.tabId] : null;
      if (ports) {
        return ports[0].postMessage({
          name: "focusFrame",
          highlight: false
        });
      }
      try { port.postMessage({ name: "returnFocus" }); } catch (e) {}
    },
    reg: function(request, port) {
      var key;
      key = Settings.cache.userDefinedOuterCss;
      key && request.visible && port.postMessage({
        name: "insertCSS",
        css: key
      });
    },
    initHelp: function(request, port) {
      Settings.fetchFile("helpDialog", function() {
        var result = {
          name: "showHelpDialog",
          html: HelpDialog.render(request.unbound, request.names, request.title),
          optionUrl: Settings.CONST.OptionsPage,
          advanced: Settings.get("showAdvancedCommands", true)
        };
        port.postMessage(result);
      });
    },
    initInnerCSS: function() {
      return Settings.cache.innerCss;
    },
    omni: function(request, port) {
      if (funcDict.checkVomnibarPage(port)) { return; }
      cPort = port;
      Completers[request.type].filter(request.query, request);
    },
    getCopiedUrl_f: function(request, port) {
      var url = Clipboard.paste().trim(), arr;
      if (!url) {}
      else if (arr = url.match(Utils.filePathRe)) {
        url = arr[1];
      } else {
        url = Utils.convertToUrl(url, request.keyword, port ? null : 2);
        if (port && url.substring(0, 11).toLowerCase() !== "javascript:") {
          requestHandlers.openUrl({ url: url });
          url = null;
        }
      }
      return url;
    },
    copyToClipboard: function(request) {
      Clipboard.copy(request.data);
    },
    esc: resetKeys,
    createMark: function(request, port) { return Marks.createMark(request, port); },
    gotoMark: function(request) { return Marks.gotoMark(request); },
    focusOrLaunch: function(request) {
      // * request.url is guaranteed to be well formatted by frontend
      // * do not limit windowId or windowType
      chrome.tabs.query({
        url: request.url.split("#", 1)[0]
      }, funcDict.focusOrLaunch[0].bind(request));
    },
    secret: function(_0, port) {
      if (funcDict.checkVomnibarPage(port)) { return null; }
      return getSecret();
    },
    PostCompletions: function(list, autoSelect, matchType) {
      try {
      cPort.postMessage({
        name: "omni",
        autoSelect: autoSelect,
        matchType: matchType,
        list: list
      });
      } catch (e) {}
    },
    SetIcon: function() {},
    SendToCurrent: function(request) {
      try {
        cPort && cPort.postMessage(request);
      } catch (e) {
        cPort = null;
      }
    }
  };

  Settings.Init = function() {
    if (3 !== ++Connections.state) { return; }
    Settings.Init = null;
    chrome.runtime.onConnect.addListener(Connections.OnConnect);
    chrome.runtime.onConnectExternal &&
    chrome.runtime.onConnectExternal.addListener(function(port) {
      if (port.sender && port.sender.id in Settings.extWhiteList
          && port.name.startsWith("vimium++")) {
        Connections.OnConnect(port);
      }
    });
  };

  Connections = {
    state: 0,
    _fakeId: -2,
    OnMessage: function(request, port) {
      var key, id;
      if (id = request._msgId) {
        request = request.request;
        port.postMessage({
          _msgId: id,
          response: requestHandlers[request.handler](request, port)
        });
      }
      else if (key = request.handlerKey) {
        // NOTE: here is a race condition which is now ignored totally
        key = checkKeyQueue(key, port);
        if (currentFirst !== key) {
          port.postMessage({ name: "key", key: key });
          currentFirst = key;
        }
      }
      else {
        requestHandlers[request.handler](request, port);
      }
    },
    OnConnect: function(port) {
      Connections.format(port);
      port.onMessage.addListener(Connections.OnMessage);
      var type = port.name[9] | 0, ref, tabId, pass, status;
      tabId = port.sender.tabId;
      if (type === 8) {
        framesForOmni.push(port);
        if (tabId < 0) {
          port.sender.tabId = cPort ? cPort.sender.tabId : TabRecency.last();
        }
        port.onDisconnect.addListener(Connections.OnOmniDisconnect);
        return;
      }
      port.onDisconnect.addListener(Connections.OnDisconnect);
      pass = Exclusions.getPattern(port.sender.url);
      port.postMessage((type & 1) ? {
        name: "init",
        load: Settings.bufferToLoad,
        passKeys: pass,
        keyMap: keyMap
      } : {
        name: "reset",
        passKeys: pass
      });
      status = pass === null ? 0 : pass ? 1 : 2;
      port.sender.status = status;
      if (ref = framesForTab[tabId]) {
        ref.push(port);
        if (type & 2) {
          if (needIcon && ref[0].sender.status !== status) {
            requestHandlers.SetIcon(tabId, status);
          }
          ref[0] = port;
        }
      } else {
        framesForTab[tabId] = [port, port];
        status !== 0 && needIcon && requestHandlers.SetIcon(tabId, status);
      }
      if (Settings.CONST.ChromeVersion < 41) {
        port.sender.frameId = (type & 4) ? 0 : ((Math.random() * 9999997) | 0) + 2;
      }
    },
    OnDisconnect: function(port) {
      var i = port.sender.tabId, ref;
      if (!port.sender.frameId) {
        delete framesForTab[i];
        return;
      }
      if (!(ref = framesForTab[i])) { return; }
      i = ref.indexOf(port, 1);
      if (i === ref.length - 1) {
        --ref.length;
      } else if (i >= 0) {
        ref.splice(i, 1);
      }
      if (port === ref[0]) {
        ref[0] = ref[1];
      }
    },
    OnOmniDisconnect: function(port) {
      var ref = framesForOmni, i = ref.lastIndexOf(port);
      i === ref.length - 1 ? --ref.length : i >= 0 ? ref.splice(i, 1) : 0;
    },
    format: function(port) {
      var sender = port.sender, tab;
      tab = sender.tab || {
        id: this._fakeId--,
        incognito: false
      };
      port.sender = {
        frameId: sender.frameId || 0,
        incognito: tab.incognito,
        status: 0,
        tabId: tab.id,
        url: sender.url
      };
    }
  };

  if (Settings.CONST.ChromeVersion >= 52) {
    funcDict.createTab = [funcDict.createTab[0]];
  }
  Settings.updateHooks.newTabUrl_f = function(url) {
    var f;
    BackgroundCommands.createTab = f = Settings.CONST.ChromeVersion < 52
      && Utils.isRefusingIncognito(url)
    ? chrome.windows.getCurrent.bind(null, {populate: true}
        , funcDict.createTab[1].bind(url))
    : chrome.tabs.query.bind(null, {currentWindow: true, active: true}
        , funcDict.createTab[0].bind(url));
    f.useTab = 0;
  };

  Settings.updateHooks.keyMappings = function(value) {
    Commands.parseKeyMappings(value);
    this.postUpdate("PopulateCommandKeys", null);
    // resetKeys has been called
    this.broadcast({
      name: "keyMap",
      keyMap: keyMap
    });
  };

  Settings.updateHooks.showActionIcon = function (value) {
    needIcon = value && chrome.browserAction ? true : false;
  };

  Settings.globalCommand = function(command, options) {
    var count = 1;
    if (currentFirst !== null) {
      count = currentFirst ? 1 : (currentCount || 1);
      resetKeys();
    }
    options && typeof options === "object" ?
        Object.setPrototypeOf(options, null) : (options = null);
    executeCommand(command, Commands.makeCommand(command, options), count, null);
  };

  chrome.runtime.onMessageExternal && (Settings.postUpdate("extWhiteList"),
  chrome.runtime.onMessageExternal.addListener(function(message, sender, sendResponse) {
    var command;
    if (!(sender.id in Settings.extWhiteList)) { return; }
    if (typeof message === "string") {
      command = message;
      if (command && Commands.availableCommands[command]) {
        Settings.globalCommand(command);
      }
      return;
    }
    if (typeof message !== "object") { return; }
    switch (message.handler) {
    case "command":
      command = message.command;
      if (!(command && Commands.availableCommands[command])) { return; }
      if (message.count) {
        currentFirst = "";
        currentCount = message.count;
      }
      Settings.globalCommand(command, message.options);
      break;
    case "content_scripts":
      return Settings.contentScripts(sendResponse);
    }
  }));

  chrome.tabs.onReplaced &&
  chrome.tabs.onReplaced.addListener(function(addedTabId, removedTabId) {
    var ref = framesForTab, frames, i;
    frames = ref[removedTabId];
    if (!frames) { return; }
    delete ref[removedTabId];
    ref[addedTabId] = frames;
    for (i = frames.length; 0 < --i; ) {
      frames[i].sender.tabId = addedTabId;
    }
  });

  setTimeout(function() {
    Settings.postUpdate("bufferToLoad", null);
    Settings.get("userDefinedOuterCss", true);
    Settings.Init();
  }, 0);

  (function() {
    var ref, i, ref2, key;
    ref2 = BackgroundCommands;
    for (key in ref2) { ref2[key].useTab = 0; }
    ref = ["gotoTab", "removeTab" //
      , "removeTabsR", "removeRightTab" //
      , "moveTab", "togglePinTab" //
      , "reloadTab", "reloadGivenTab", "visitPreviousTab" //
    ];
    for (i = ref.length; 0 <= --i; ) {
      ref2[ref[i]].useTab = 2;
    }
    ref = ["clearCS", "copyTabInfo", "enableCSTemp", "goToRoot", "moveTabToNextWindow"//
      , "openCopiedUrlInNewTab", "reopenTab", "toggleCS", "toggleViewSource" //
    ];
    for (i = ref.length; 0 <= --i; ) {
      ref2[ref[i]].useTab = 1;
    }
  })();

  setTimeout(function() {
    Settings.fetchFile("baseCss");
    Settings.postUpdate("searchUrl", null); // will also update newTabUrl

    localStorage.getItem(ContentSettings.makeKey("images")) != null &&
    setTimeout(ContentSettings.clear, 100, "images");

    document.documentElement.textContent = '';
  }, 34);

  // will run only on <F5>, not on runtime.reload
  window.onunload = function() {
    var ref = framesForTab, tabId, ports, i;
    framesForTab = null;
    ref.omni = framesForOmni;
    for (tabId in ref) {
      ports = ref[tabId];
      for (i = ports.length; 0 <= --i; ) {
        ports[i].disconnect();
      }
    }
  };
})();
