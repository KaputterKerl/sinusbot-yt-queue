registerPlugin({
    name: 'Join Channel',
    version: '0.1.0',
    description: 'Moves the bot into a fixed channel after connecting (TS6 ignores the channel from the connect URL).',
    author: 'KaputterKerl',
    vars: [
        { name: 'channelName', title: 'Channel name (empty = use the instance start channel)', type: 'string' },
        { name: 'channelPassword', title: 'Channel password (optional)', type: 'password' }
    ]
}, function (_, config) {
    var event = require('event');
    var backend = require('backend');
    var engine = require('engine');

    function join(attempt) {
        var target = config.channelName
            ? backend.getChannelByName(config.channelName)
            : backend.getChannelByID(String(engine.getDefaultChannelID()));
        if (!target) {
            if (attempt < 10) return setTimeout(function () { join(attempt + 1); }, 1000);
            engine.log('[join-channel] channel not found: ' + (config.channelName || 'default channel'));
            return;
        }
        var me = backend.getCurrentChannel();
        if (me && me.id() === target.id()) return;
        if (attempt >= 8) return engine.log('[join-channel] giving up, still not in ' + target.name());
        engine.log('[join-channel] moving to ' + target.name() + ' (' + target.id() + ') attempt ' + attempt);
        backend.getBotClient().moveTo(target, config.channelPassword || '');
        // verify afterwards: moveTo returns true even if the server refuses (e.g. missing join power)
        setTimeout(function () { join(attempt + 1); }, 3000);
    }

    event.on('connect', function () { setTimeout(function () { join(0); }, 2000); });
    if (backend.isConnected()) join(0);
});
