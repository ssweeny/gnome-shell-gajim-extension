/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const DBus = imports.dbus;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const Tp = imports.gi.TelepathyGLib;

const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const MessageTray = imports.ui.messageTray;
const Shell = imports.gi.Shell;
const TelepathyClient = imports.ui.components.telepathyClient;

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

const Source = new Lang.Class({
    Name: 'Source',
    Extends: MessageTray.Source,

    _init: function(gajimClient, accountName, author, initialMessage) {
        this.parent(author);
        this.isChat = true;
        this._pendingMessagesCount = 0;

        this._author = author;
        this._gajimClient = gajimClient;
        this._accountName = accountName;
        this._initialMessage = initialMessage;
        this._authorJid = this._author.split('/')[0];

        // These are set from various DBus calls results.
        this._presence = "online";
        this._avatarUri = null;
        this._myJid = null;
        this._myFullName = null;

        this._notification = new TelepathyClient.ChatNotification(this);
        this._notification.setUrgency(MessageTray.Urgency.HIGH);
        this._notificationClickedId = this._notification.connect('clicked', Lang.bind(this, this._flushPendingMessages));
        this._summaryClickedId = this.connect('summary-item-clicked', Lang.bind(this, this._flushPendingMessages));
        this._notifyTimeoutId = 0;

        let proxy = this._gajimClient.proxy();
        proxy.list_contactsRemote(this._accountName, Lang.bind(this, this._gotContactList));
        proxy.account_infoRemote(this._accountName, Lang.bind(this, this._gotAccountInfo));
        this._statusChangeId = proxy.connect('ContactStatus',
                                             Lang.bind(this, this._onStatusChange));
        this._contactAbsenceId = proxy.connect('ContactAbsence',
                                               Lang.bind(this, this._onStatusChange));
        this._chatStateId = proxy.connect('ChatState',
                                          Lang.bind(this, this._onChatState));
        this._messageSentId = proxy.connect('MessageSent',
                                            Lang.bind(this, this._messageSent));
        this._newMessageId = proxy.connect('NewMessage',
                                             Lang.bind(this, this._messageReceived));
    },

    destroy: function() {
        let proxy = this._gajimClient.proxy();
        proxy.disconnect(this._statusChangeId);
        proxy.disconnect(this._contactAbsenceId);
        proxy.disconnect(this._chatStateId);
        proxy.disconnect(this._messageSentId);
        proxy.disconnect(this._newMessageId);
        this._notification.disconnect(this._notificationClickedId);
        this.disconnect(this._summaryClickedId);
        this.parent();
    },

    _gotAccountInfo: function(result, excp) {
        let proxy = this._gajimClient.proxy();
        this._myJid = result['jid'];
        proxy.contact_infoRemote(this._myJid, Lang.bind(this, this._gotMyContactInfos));
    },

    _gotMyContactInfos: function(result, excp) {
        this._myFullName = result['FN'] || result['NICKNAME'] || result['jid'];
    },

    _gotContactList: function(result, excp) {
        for (let i = 0; i < result.length; i++) {
            let contact = result[i];
            if (contact['jid'] == this._authorJid) {
                this._presence = contact['show'];
                break;
            }
        }

        let proxy = this._gajimClient.proxy();
        proxy.contact_infoRemote(this._authorJid, Lang.bind(this, this._gotContactInfos));
    },

    _gotContactInfos: function(result, excp) {
        this.title = result['FN'] || result['NICKNAME'] || result['jid'];

        let avatarUri = null;
        if (result['PHOTO']) {
            let mimeType = result['PHOTO']['TYPE'];
            let avatarData = GLib.base64_decode(result['PHOTO']['BINVAL']);
            let sha = result['PHOTO']['SHA'];
            avatarUri = this._gajimClient.cacheAvatar(mimeType, sha, avatarData);
        }

        this._avatarUri = avatarUri;
        this._notification.update(this._notification.title, null,
                                  { customContent: true,
                                    secondaryIcon: this.createSecondaryIcon(),
                                    icon: this.createIcon(MessageTray.NOTIFICATION_ICON_SIZE) });

        let message = wrappedText(this._initialMessage, this._author, this.title, null, TelepathyClient.NotificationDirection.RECEIVED);
        this._appendMessage(message, false);

        if (!Main.messageTray.contains(this))
            Main.messageTray.add(this);

        this.notify();
    },

    createIcon: function(size) {
        this._iconBox = new St.Bin({ style_class: 'avatar-box' });
        this._iconBox._size = size;

        if (this._avatarUri) {
            let textureCache = St.TextureCache.get_default();
            this._iconBox.child = textureCache.load_uri_async(this._avatarUri, this._iconBox._size, this._iconBox._size);
        } else
            this._iconBox.child = new St.Icon({ icon_name: 'avatar-default',
                                                icon_size: this._iconBox._size });
        return this._iconBox;
    },

    createSecondaryIcon: function() {
        let iconBox = new St.Bin();
        iconBox.child = new St.Icon({ style_class: 'secondary-icon' });
        switch (this._presence) {
            case "away":
                iconBox.child.icon_name = 'user-away';
                break;
            case  "offline":
                iconBox.child.icon_name = 'user-offline';
                break;
            case "online":
                iconBox.child.icon_name = 'user-available';
                break;
            case "dnd":
                iconBox.child.icon_name = 'user-busy';
                break;
            default:
                iconBox.child.icon_name = 'user-offline';
        }

        return iconBox;
    },

    open: function(notification) {
        // Lookup for the messages window and display it. In the case where it's not o
        // opened yet fallback to the roster window.
        let windows = global.get_window_actors();
        for (let i = 0; i < windows.length; i++) {
            let metaWindow = windows[i].metaWindow;
            if (metaWindow.get_wm_class_instance() == "gajim" &&
                metaWindow.get_role() == "messages") {
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

    _messageReceived: function(emitter, data) {
        let author = data[1][0];
        let text = data[1][1];
        if (!text || (author != this._author))
            return;

        let message = wrappedText(text, this._author, this.title, null, TelepathyClient.NotificationDirection.RECEIVED);
        this._appendMessage(message, false);

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
            let message = wrappedText(text, this._myJid, this._myFullName, null, TelepathyClient.NotificationDirection.SENT);
            this._appendMessage(message, false);
        } else if (chatstate == 'gone')
            this.destroy();
    },

    notify: function() {
        this.parent(this._notification);
    },

    respond: function(text) {
        let jid = this._author;
        let keyID = ""; // unencrypted.
        this._gajimClient.proxy().send_chat_messageRemote(jid, text, keyID, this._accountName);
    },

    setChatState: function(state) {
        // Gajim DBUS API doesn't support sending chatstate yet.
    },

    _onStatusChange: function(emitter, data) {
        if (!this.title)
            return;

        let jid = data[1][0];
        let presence = data[1][1];

        if (jid != this._author.split('/')[0])
            return;

        this._presence = presence;
        this._notification.update(this._notification.title, null,
                                  { customContent: true,
                                    secondaryIcon: this.createSecondaryIcon() });
    }
});


const GajimIface = {
    name: 'org.gajim.dbus.RemoteInterface',
    properties: [],
    methods: [{ name: 'send_chat_message', inSignature: 'ssss', outSignature: 'b'},
              { name: 'contact_info', inSignature: 's', outSignature: 'a{sv}'},
              { name: 'account_info', inSignature: 's', outSignature: 'a{ss}'},
              { name: 'list_contacts', inSignature: 's', outSignature: 'aa{sv}'}],
    signals: [{ name: 'NewMessage', inSignature: 'av' },
              { name: 'ChatState', inSignature: 'av' },
              { name: 'ContactStatus', inSignature: 'av' },
              { name: 'ContactAbsence', inSignature: 'av' },
              { name: 'MessageSent', inSignature: 'av' }]
};

let Gajim = DBus.makeProxyClass(GajimIface);

const GajimClient = new Lang.Class({
    Name: 'GajimClient',

    _init: function() {
        this._sources = {};
        this._proxy = null;
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

        this._proxy = new Gajim(DBus.session, 'org.gajim.dbus', '/org/gajim/dbus/RemoteObject');
        this._newMessageId = this._proxy.connect('NewMessage', Lang.bind(this, this._messageReceived));
    },

    disable: function() {
        if (this._newMessageId) {
            this._proxy.disconnect(this._newMessageId);
            this._newMessageId = 0;
        }
        this._proxy = null;

        for (let id in this._sources)
            this._sources[id].destroy();

        this._sources = { };
    },

    _messageReceived : function(emitter, data) {
        let author = data[1][0];
        let message = data[1][1];
        let account = data[0];
        let source = this._sources[author];

        if (!source) {
            source = new Source(this, account, author, message);
            source.connect('destroy', Lang.bind(this,
                function() {
                    delete this._sources[author];
                }));
            this._sources[author] = source;
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
    return new GajimClient();
}
