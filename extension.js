/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
/*
    Copyright (C) 2012, 2013  Philippe Normand.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const Tp = imports.gi.TelepathyGLib;

const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const MessageTray = imports.ui.messageTray;
const Search = imports.ui.search;
const Shell = imports.gi.Shell;
const TelepathyClient = imports.ui.components.telepathyClient;

const PopupMenu = imports.ui.popupMenu;
const NotificationDaemon = imports.ui.notificationDaemon;
const Utils = imports.misc.extensionUtils.getCurrentExtension().imports.utils;

const settings = Utils.getSettings();

function wrappedText(text, sender, senderAlias, timestamp, direction) {
    if (!timestamp)
        timestamp = (Date.now()  / 1000);
    let type;
    if (text.slice(0, 4) == '/me ') {
        type = Tp.ChannelTextMessageType.ACTION;
        text = text.slice(4);
        sender = senderAlias;
    } else {
        type = Tp.ChannelTextMessageType.NORMAL;
    }
    return {
        messageType: type,
        text: text,
        sender: sender,
        timestamp: timestamp,
        direction: direction
    };
}

function unpackPhoto(result) {
    for (let param in result)
        result[param] = result[param].deep_unpack();

    if (result['PHOTO']) {
        result['PHOTO']['BINVAL'] = result['PHOTO']['BINVAL'].deep_unpack();
        result['PHOTO']['TYPE'] = result['PHOTO']['TYPE'].deep_unpack();
        result['PHOTO']['SHA'] = result['PHOTO']['SHA'].deep_unpack();
    }
}

const Source = new Lang.Class({
    Name: 'Source',
    Extends: MessageTray.Source,

    _init: function(gajimExtension, accountName, author, initialMessage, avatarUri) {
        this.parent(accountName);
        this.isChat = true;
        this._pendingMessagesCount = 0;

        this._author = author;
        this._gajimExtension = gajimExtension;
        this._accountName = accountName;
        this._initialMessage = initialMessage;
        this._avatarUri = avatarUri;

        // These are set from various DBus calls results.
        this._presence = "online";
        this._avatarUri = null;
        this._myJid = null;
        this._myFullName = null;
        this._lastSentMessage = null;

        this._notification = new TelepathyClient.ChatNotification(this);
        this._notification.setUrgency(MessageTray.Urgency.HIGH);
        this._notification.connect('activated', Lang.bind(this, this.open));
        this._notification.connect('expanded', Lang.bind(this, this._flushPendingMessages));
        this._notification.connect('clicked', Lang.bind(this, this._flushPendingMessages));
        this.connect('summary-item-clicked', Lang.bind(this, this._flushPendingMessages));
        this._notifyTimeoutId = 0;

        let proxy = this._gajimExtension.proxy();
        if (proxy) {
            proxy.list_contactsRemote(accountName, Lang.bind(this,
                function([result], excp) {
                    this._gotContactList(result, excp);
                }));

            proxy.contact_infoRemote(this._accountName, Lang.bind(this,
                function([result], excp) {
                    for (let param in result)
                        result[param] = result[param].deep_unpack();
                    this._gotAccountInfo(result, excp);
                }));

            this._statusChangeId = proxy.connectSignal('ContactStatus',	Lang.bind(this,
                function(emitter, name, [data]) {
                    var status = [new Array(2),new Array(2)];
                    status[1][0] = data[1].get_child_value(0).get_variant().deep_unpack();
                    status[1][1] = data[1].get_child_value(1).get_variant().deep_unpack();
                    this._onStatusChange(emitter, status);
                }));

            this._contactAbsenceId = proxy.connectSignal('ContactAbsence', Lang.bind(this,
                function(emitter, name, [data]) {
                    var status = [new Array(2),new Array(2)];
                    status[1][0] = data[1].get_child_value(0).get_variant().deep_unpack();
                    status[1][1] = data[1].get_child_value(1).get_variant().deep_unpack();
                    this._onStatusChange(emitter, data);
                }));

            this._chatStateId = proxy.connectSignal('ChatState', Lang.bind(this,
                function(emitter, name, [data]) {
                    var ndata = [new Array(6),new Array(6)];
                    var lastIndex = data[1].n_children() - 1;
                    ndata[1][5] = data[1].get_child_value(lastIndex).get_variant().deep_unpack();
                    this._onChatState(emitter, ndata);
                }));

            this._messageSentId = proxy.connectSignal('MessageSent', Lang.bind(this,
                function(emitter, name, [data]) {
                    var ndata = [new Array(4),new Array(4)];
                    ndata[1][0] = data[1].get_child_value(0).get_variant().deep_unpack();
                    ndata[1][1] = data[1].get_child_value(1).get_variant().deep_unpack();
                    ndata[1][3] = data[1].get_child_value(3).get_variant().deep_unpack();
                    this._messageSent(emitter, ndata);
                }));
        }

        Main.messageTray.add(this);
        this.pushNotification(this._notification);
    },

    createBanner: function() {
        this._banner = new TelepathyClient.ChatNotificationBanner(this._notification);

        this._banner.actor.connect('destroy', Lang.bind(this,
                                                        function() {
                                                            this._banner = null;
                                                        }));

        return this._banner;
    },

     _createPolicy: function() {
        return new MessageTray.NotificationApplicationPolicy('empathy');
    },

    destroy: function() {
        if (!this._gajimExtension)
            return;
        let proxy = this._gajimExtension.proxy();
        if (proxy) {
            proxy.disconnectSignal(this._statusChangeId);
            proxy.disconnectSignal(this._contactAbsenceId);
            proxy.disconnectSignal(this._chatStateId);
            proxy.disconnectSignal(this._messageSentId);
        }
        this._gajimExtension = null;
        this.parent();
    },

    _gotAccountInfo: function(result, excp) {
        this._myJid = result['jid'];
        let proxy = this._gajimExtension.proxy();
        if (proxy && this._myJid) {
            proxy.contact_infoRemote(this._myJid.toString(), Lang.bind(this,
                function([result], excp) {
                    for (let param in result)
                         result[param] = result[param].deep_unpack();

                    this._gotMyContactInfos(result, excp);
            }));
        }
    },

    _gotMyContactInfos: function(result, excp) {
        this._myFullName = result['FN'] || result['NICKNAME'] || result['jid'];
    },

    _gotContactList: function(result, excp) {
        for (let i = 0; i < result.length; i++) {
            let contact = result[i];
            if (contact['jid'] == this._author) {
                this._presence = contact['show'];
                break;
            }
        }

        let proxy = this._gajimExtension.proxy();
        if (proxy) {
            proxy.contact_infoRemote(this._author, Lang.bind(this,
                function([result], excp) {
                   unpackPhoto(result);
                   this._gotContactInfos(result, excp);
                }));
        }
    },

    _gotContactInfos: function(result, excp) {

        this.title = result['FN'] || result['NICKNAME'] || result['jid'];

        let avatarUri = null;
        if (result['PHOTO']) {
            let mimeType = result['PHOTO']['TYPE'];
            let avatarData = GLib.base64_decode(result['PHOTO']['BINVAL']);
            let sha = result['PHOTO']['SHA'];
            avatarUri = this._gajimExtension.cacheAvatar(mimeType, sha, avatarData);
        }

        this._avatarUri = avatarUri;
        this.iconUpdated();
        this._notification.update(this._notification.title, null,
                                  {
                                    secondaryGIcon: this.getSecondaryIcon() });

        let message = wrappedText(this._initialMessage, this._author, this.title, null, TelepathyClient.NotificationDirection.RECEIVED);
        this._appendMessage(message, false);

        this.notify();
    },

    getIcon: function() {
        if (this._avatarUri) {
            return new Gio.FileIcon({ file: Gio.File.new_for_uri(this._avatarUri) });
        } else {
            return new Gio.ThemedIcon({ name: 'avatar-default' });
        }
    },

    getSecondaryIcon: function() {
        let iconName;

        switch (this._presence) {
            case Tp.ConnectionPresenceType.AVAILABLE:
            case "online":
                iconName = 'user-available';
                break;
            case Tp.ConnectionPresenceType.BUSY:
            case "dnd":
                iconName = 'user-busy';
                break;
            case Tp.ConnectionPresenceType.OFFLINE:
            case "offline":
                iconName = 'user-offline';
                break;
            case Tp.ConnectionPresenceType.HIDDEN:
            case "invisible":
                iconName = 'user-invisible';
                break;
            case Tp.ConnectionPresenceType.AWAY:
            case "away":
                iconName = 'user-away';
                break;
            case Tp.ConnectionPresenceType.EXTENDED_AWAY:
            case "xa":
                iconName = 'user-idle';
                break;
            default:
                iconName = 'user-offline';
       }
       return new Gio.ThemedIcon({ name: iconName });
    },

    handleSummaryClick: function() {
        // Always let right click pass through.
        let event = Clutter.get_current_event();
        if (event.get_button() == 3)
            return false;

        if (settings.get_boolean("prefer-native-gajim")) {
            this.open(null);
            return true;
        }
        return false;
    },

    open: function(notification) {
        // Lookup for the messages window and display it. In the case where it's not o
        // opened yet fallback to the roster window.
        let windows = global.get_window_actors();
        for (let i = 0; i < windows.length; i++) {
            let metaWindow = windows[i].metaWindow;
            let role = metaWindow.get_role();
            if (metaWindow.get_wm_class_instance() == "gajim" &&
                (["messages", "roster"].indexOf(role) != -1)) {
                Main.activateWindow(metaWindow);
                return;
            }
        }

        let app = Shell.AppSystem.get_default().lookup_app('gajim.desktop');
        app.activate(-1);
    },

    _onChatState: function(emitter, data) {
        let chatstate = data[1][5];
        if (chatstate == 'gone')
            this.destroy();
    },

    _flushPendingMessages: function() {
        this._pendingMessagesCount = 0;
        this.countUpdated();
    },

    get count() {
        return this._pendingMessagesCount;
    },

    get unseenCount() {
        return this.count;
    },

    get countVisible() {
        return this.count > 0;
    },

    _appendMessage: function(message, noTimestamp) {
        if (!this._notification.expanded) {
            this._pendingMessagesCount++;
            this.countUpdated();
        }
        this._notification.appendMessage(message, noTimestamp);
    },

    handleMessageReceived: function(text) {
        let message = wrappedText(text, this._author, this.title, null, TelepathyClient.NotificationDirection.RECEIVED);
        this._appendMessage(message, true);

        // Wait a bit before notifying for the received message, a handler
        // could ack it in the meantime.
        if (this._notifyTimeoutId != 0)
            Mainloop.source_remove(this._notifyTimeoutId);
        this._notifyTimeoutId = Mainloop.timeout_add(500,
            Lang.bind(this, this._notifyTimeout));
    },

    _notifyTimeout: function() {
        this.notify();
        this._notifyTimeoutId = 0;
        return false;
    },

    _messageSent: function(emitter, data) {
        let recipient = data[1][0];
        let text = data[1][1];
        let chatstate = data[1][3];

        if (text && (recipient == this._author)) {
            if ((text.indexOf("?OTR") == 0) && this._lastSentMessage) {
                text = this._lastSentMessage;
                this._lastSentMessage = null;
            }

            let message = wrappedText(text, this._myJid, this._myFullName, null, TelepathyClient.NotificationDirection.SENT);
            this._appendMessage(message, false);
        } else if (chatstate == 'gone')
            this.destroy();
    },

    notify: function() {
        this.parent(this._notification);
    },

    respond: function(text) {
        this._lastSentMessage = text;
        let jid = this._author;
        let keyID = ""; // unencrypted.

        let proxy = this._gajimExtension.proxy();
        if (proxy)
            proxy.send_chat_messageRemote(jid, text, keyID, this._accountName);
    },

    setChatState: function(state) {
        // Gajim DBUS API doesn't support sending chatstate yet.
    },

    _onStatusChange: function(emitter, data) {
        if (!this.title)
            return;

        let jid = data[1][0];
        let presence = data[1][1];

        if (jid != this._author)
            return;

        this._presence = presence;
        this._notification.update(this._notification.title, null,
                                  { secondaryGIcon: this.getSecondaryIcon() });
    }
});


const GajimSearchProvider = new Lang.Class({
    Name: 'GajimSearchProvider',

    _init: function (gajimExtension) {
        this.id = "gajim-contacts";
        this._gajimExtension = gajimExtension;
        this.reset();
    },

    enable: function() {
        let searchSystem = Main.overview._controls.viewSelector._searchResults;
        searchSystem._registerProvider(this);
    },

    disable: function() {
        let searchSystem = Main.overview._controls.viewSelector._searchResults;
        searchSystem._unregisterProvider(this);
    },

    reset: function() {
        this.enable();
        this._accounts = [];
        let proxy = this._gajimExtension.proxy();
        if (proxy) {
            proxy.list_accountsRemote(Lang.bind(this, function(result, exc) {
                     if (exc)
                         return;
                     [accounts] = result;
                     this._gotAccountsList(accounts);
                 }));
            this._subscribedId = proxy.connectSignal('Subscribed', Lang.bind(this,
                function(emitter, name, [data]) {
                    var ndata = ['',new Array(1)];
                    ndata[0] = data.get_child_value(0).get_variant().deep_unpack();
                    ndata[1][0] = data.get_child_value(1).get_variant().deep_unpack();
                    this._onSubscribed(emitter, ndata);
                }));
            this._unsubscribedId = proxy.connectSignal('Unsubscribed', Lang.bind(this,
                function(emitter, name, [data]) {
                    var ndata = ['',new Array(1)];
                    ndata[0] = data.get_child_value(0).get_variant().deep_unpack();
                    ndata[1][0] = data.get_child_value(1).get_variant().deep_unpack();
                    this._onUnsubscribed(emitter, ndata);
                }));
        }
    },

    destroy: function() {
        let proxy = this._gajimExtension.proxy();
        if (proxy) {
            proxy.disconnectSignal(this._subscribedId);
            proxy.disconnectSignal(this._unsubscribedId);
        }
        this.parent();
    },

    _gotAccountsList: function(result) {
        if (!result)
            return;
        let proxy = this._gajimExtension.proxy();
        for (let i = 0; i < result.length; i++) {
            let accountName = result[i];
            if (proxy)
                proxy.list_contactsRemote(accountName, Lang.bind(this, function([r], e) {
                                                                     this._gotContactList(accountName, r, e);
                                                                 }));

        }
    },

    _onSubscribed: function(emitter, data) {
        let accountName = data[0];
        let jid = data[1][0];
        if (accountName in this._accounts)
            delete this._accounts[accountName];

        let proxy = this._gajimExtension.proxy();
        if (proxy)
            proxy.list_contactsRemote(accountName, Lang.bind(this, function([r], e) {
                                                                 this._gotContactList(accountName, r, e);
                                                             }));
    },

    _onUnsubscribed: function(emitter, data) {
        let accountName = data[0];
        let jid = data[1][0];
        if (accountName in this._accounts) {
            let account = this._accounts[accountName];
            for (let i = 0; i < account["contacts"].length; i++) {
                let contact = account["contacts"][i];
                if (contact["jid"] == jid) {
                    account["contacts"].splice(i, 1);
                    return;
                }
            }
        }
    },

    _gotContactList: function(accountName, result, excp) {
        let account = {
            name: accountName,
            contacts: result
        };
        this._accounts.push(account);
    },

    _gotContactInfos: function(contact, result, excp) {
        if (result['PHOTO']) {
            let avatarUri = null;
            let mimeType = result['PHOTO']['TYPE'];
            let avatarData = GLib.base64_decode(result['PHOTO']['BINVAL']);
            let sha = result['PHOTO']['SHA'];
            avatarUri = this._gajimExtension.cacheAvatar(mimeType, sha, avatarData);
            contact.avatarUri = avatarUri;
        }
    },

    filterResults: function(results, maxNumber) {
        return results;
    },

    getInitialResultSet: function(terms, callback, cancellable) {
        let accounts = this._accounts;
        let results = [];
        for (let i = 0; i < accounts.length; i++) {
            let account = accounts[i];
            for (let j = 0; j < account["contacts"].length; j++) {
                let contact = account["contacts"][j];
                let name = contact.name.deep_unpack();
                let jid = contact.jid.deep_unpack();
                if ((jid.toLowerCase().indexOf(terms) != -1)
                    || (name.toLowerCase().indexOf(terms) != -1)) {
                    let proxy = this._gajimExtension.proxy();
                    if (proxy) {
                        let [result] = proxy.contact_infoSync(jid);
                        unpackPhoto(result);
                        this._gotContactInfos(contact, result, null);
                        contact["account"] = account["name"];
                        results.push(contact);
                    }
                }
            }
        }
        callback(results);
    },

    getSubsearchResultSet: function(previousResults, terms, callback, cancellable) {
        this.getInitialResultSet(terms, callback, cancellable);
    },

    _createIconForId: function (id, size) {
        let box = new St.Widget({layout_manager: new Clutter.BinLayout });
        if (id.avatarUri) {
            box.add_actor(new St.Icon({
                              gicon: new Gio.FileIcon({
                                  file: Gio.File.new_for_uri(id.avatarUri)
                              }),
                              icon_size: size
                          }));
        } else {
            let gicon = new Gio.ThemedIcon({ name: 'avatar-default' });
            let icon = new St.Icon({ gicon: gicon,
                                    icon_size: size });
            box.add_actor(icon);
        }
        return box;
    },

    createResultObject: function (metaInfo) {
        return null;
    },

    getResultMetas: function(ids, callback, cancellable) {
        let metas = [];
        for (let i = 0; i < ids.length; i++) {
            let id = ids[i];
            metas.push({ 'id': id,
                         'name': id.name.deep_unpack() + ' (' + id.jid.deep_unpack() + ')',
                         'createIcon': Lang.bind(this, function (size) {
                             return this._createIconForId(id, size);
                       })});
        }
        callback(metas);
    },

    activateResult: function(id) {
        let recipient = id.jid.deep_unpack();
        this._gajimExtension.initiateChat(id.account, recipient, id.avatarUri);
    }
});

const GajimIface = '<node> \
<interface name="org.gajim.dbus.RemoteInterface"> \
<method name="send_chat_message"> \
    <arg type="s" direction="in" /> \
    <arg type="s" direction="in" /> \
    <arg type="s" direction="in" /> \
    <arg type="s" direction="in" /> \
    <arg type="b" direction="out" /> \
</method> \
<method name="contact_info"> \
    <arg type="s" direction="in" /> \
    <arg type="a{sv}" direction="out" /> \
</method> \
<method name="account_info"> \
    <arg type="s" direction="in" /> \
    <arg type="a{ss}" direction="out" /> \
</method> \
<method name="list_contacts"> \
    <arg type="s" direction="in" /> \
    <arg type="aa{sv}" direction="out" /> \
</method> \
<method name="list_accounts"> \
    <arg type="as" direction="out" /> \
</method> \
<method name="open_chat"> \
    <arg type="s" direction="in" /> \
    <arg type="s" direction="in" /> \
    <arg type="s" direction="in" /> \
    <arg type="b" direction="out" /> \
</method> \
<signal name="NewMessage"> \
    <arg type="av" direction="out" /> \
</signal> \
<signal name="ChatState"> \
    <arg type="av" direction="out" /> \
</signal> \
<signal name="ContactStatus"> \
    <arg type="av" direction="out" /> \
</signal> \
<signal name="ContactAbsence"> \
    <arg type="av" direction="out" /> \
</signal> \
<signal name="MessageSent"> \
    <arg type="av" direction="out" /> \
</signal> \
<signal name="Subscribed"> \
    <arg type="av" direction="out" /> \
</signal> \
<signal name="Unsubscribed"> \
    <arg type="av" direction="out" /> \
</signal> \
</interface> \
</node>';

let Gajim = Gio.DBusProxy.makeProxyWrapper(GajimIface);

const GajimExtension = new Lang.Class({
    Name: 'GajimExtension',

    _init: function() {
        this._sources = {};
        this._proxy = null;
        this._provider = null;
    },

    proxy : function() {
        return this._proxy;
    },

    enable: function() {
        this._cacheDir = GLib.get_user_cache_dir() + '/gnome-shell/gajim-avatars';
        let dir = Gio.file_new_for_path(this._cacheDir);
        if (!dir.query_exists(null)) {
            GLib.mkdir_with_parents(this._cacheDir, 0x1c0); // 0x1c0 = octal 0700
        }

        this._proxy = new Gajim(Gio.DBus.session, 'org.gajim.dbus', '/org/gajim/dbus/RemoteObject');
        this._proxy.extension = this;

        if (!this._provider) {
            this._provider = new GajimSearchProvider(this);
        } else {
            this._provider.reset();
        }

        this._proxy.connect('notify::g-name-owner', function(proxy) {
            let extension = proxy.extension;
            extension._sources = { };
            if (proxy.g_name_owner) {
                extension._provider.reset();
            } else {
                extension._provider.disable();
            }
        });

        this._newMessageId = this._proxy.connectSignal('NewMessage', Lang.bind(this,
            function(proxy, sender, [status]) {
                this._messageReceived(null,
                                      status[1].get_child_value(0).get_variant().deep_unpack(),
                                      status[1].get_child_value(1).get_variant().deep_unpack(),
                                      status[0].deep_unpack());
            }));

    },

    disable: function() {
        if (this._provider) {
            this._provider.disable();
            this._provider = null;
        }

        if (this._newMessageId) {
            this._proxy.disconnectSignal(this._newMessageId);
            this._newMessageId = 0;
        }
        this._proxy = null;

        for (let id in this._sources)
            this._sources[id].destroy();

        this._sources = { };
    },

    _messageReceived : function(emitter, author, message, account) {
        author = author.toString().split('/')[0];

        let source = this._sources[author];

        if (!source) {
            source = new Source(this, account, author, message, null);
            source.connect('destroy', Lang.bind(this,
                function() {
                    delete this._sources[author];
                }));
            this._sources[author] = source;
        } else {
            source.handleMessageReceived(message);
        }
    },

    initiateChat : function(account, recipient, avatarUri) {
        if (settings.get_boolean("chat-initiator")) {
            let source = new Source(this, account, recipient, "", avatarUri);
            source.connect('destroy', Lang.bind(this,
                                                function() {
                                                    delete this._sources[recipient];
                                                }));
            this._sources[recipient] = source;
        } else if (this._proxy) {
            this._proxy.open_chatRemote(recipient, account, "");
        }
    },

    cacheAvatar : function(mimeType, sha, avatarData) {
        let ext = mimeType.split('/')[1];
        let file = this._cacheDir + '/' + sha + '.' + ext;
        let uri = GLib.filename_to_uri(file, null);

        if (GLib.file_test(file, GLib.FileTest.EXISTS))
            return uri;

        let success = false;
        try {
            success = GLib.file_set_contents(file, avatarData, avatarData.length);
        } catch (e) {
            logError(e, 'Error caching avatar data');
        }
        return uri;
    }

});

function init() {
    return new GajimExtension();
}
