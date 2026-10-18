registerPlugin({
    name: 'YT Queue',
    version: '0.1.0',
    description: 'YouTube search (!ys), pick (!1-!5), own queue and playlist import. Needs a YouTube Data API v3 key.',
    author: 'KaputterKerl',
    requiredModules: ['http'],
    vars: [
        { name: 'apiKey', title: 'YouTube Data API v3 key', type: 'string' },
        { name: 'prefix', title: 'Command prefix', type: 'string', placeholder: '!' },
        { name: 'maxPlaylist', title: 'Max videos per playlist import', type: 'number', placeholder: '200' },
        { name: 'startTimeout', title: 'Seconds to wait for playback start before retry/skip', type: 'number', placeholder: '25' },
        { name: 'download', title: 'Download instead of stream (more stable, uses disk)', type: 'select', options: ['Stream', 'Download'] }
    ]
}, function (_, config) {
    var event = require('event');
    var media = require('media');
    var audio = require('audio');
    var http = require('http');
    var engine = require('engine');
    var backend = require('backend');

    var prefix = config.prefix || '!';
    var maxPlaylist = config.maxPlaylist || 200;
    var startTimeout = (config.startTimeout || 25) * 1000;
    var download = Number(config.download) === 1;

    var queue = [];          // {id, title, channel}
    var results = {};        // client uid -> last search results
    var current = null;
    var startTimer = null;
    var retried = false;
    var stopping = false;
    var lastPlay = 0;        // time of the last play() call

    function log(msg) { engine.log('[yt-queue] ' + msg); }

    function reply(ev, text) {
        if (ev.mode === 1 && ev.client) ev.client.chat(text);
        else if (ev.channel) ev.channel.chat(text);
        else if (ev.client) ev.client.chat(text);
    }

    function api(path, params, cb) {
        if (!config.apiKey) return cb('No API key configured');
        var q = [];
        for (var k in params) q.push(k + '=' + encodeURIComponent(params[k]));
        q.push('key=' + encodeURIComponent(config.apiKey));
        http.simpleRequest({
            method: 'GET',
            url: 'https://www.googleapis.com/youtube/v3/' + path + '?' + q.join('&'),
            timeout: 10000
        }, function (err, res) {
            if (err || !res || res.statusCode !== 200) {
                log('API ' + path + ' failed: ' + (err || (res && res.statusCode)) + ' ' + (res && res.data ? res.data.toString().substr(0, 300) : ''));
                return cb('API error: ' + (err || (res && res.statusCode)));
            }
            try { cb(null, JSON.parse(res.data.toString())); }
            catch (e) { cb('Bad API response'); }
        });
    }

    function videoUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

    // ---- playback ----

    function clearTimer() {
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    }

    function play(item) {
        current = item;
        stopping = false;
        lastPlay = Date.now();
        clearTimer();
        log('play ' + item.id + ' ' + item.title);
        var url = videoUrl(item.id);
        var ok = download ? media.ytdl(url, true) : media.yt(url);
        log('play call returned ' + ok);
        if (ok === false) return failed('play call rejected');
        startTimer = setTimeout(function () { failed('no start after ' + startTimeout / 1000 + 's'); }, startTimeout);
    }

    function failed(reason) {
        clearTimer();
        log('failed: ' + reason);
        if (!current) return;
        if (!retried) {
            retried = true;
            return play(current);
        }
        backend.chat('Skipping "' + current.title + '": ' + reason);
        next();
    }

    function next() {
        retried = false;
        current = null;
        clearTimer();
        var item = queue.shift();
        if (item) play(item);
    }

    function enqueue(items) {
        queue = queue.concat(items);
        if (!current && !audio.isPlaying()) next();
    }

    event.on('ytdl.success', function (ev) { log('ytdl.success ' + ev.url + ' job=' + ev.jobId); });

    event.on('track', function (track) {
        log('track event ' + (track && track.title ? track.title() : ''));
        // a youtube job that finished after !stop would start playing anyway
        if (stopping) { media.stop(); return; }
        if (current) { clearTimer(); retried = false; }
    });

    event.on('trackEnd', function (track) {
        // the track we just replaced (skip) also reports its end: ignore that one
        var recent = Date.now() - lastPlay < 8000;
        log('trackEnd ' + (track && track.url ? track.url() : '') + (recent ? ' (ignored, new track just started)' : ''));
        if (stopping || recent) return;
        if (current || queue.length) next();
    });

    event.on('ytdl.error', function (ev, message) {
        if (current) failed('youtube-dl: ' + message);
    });

    // ---- commands ----

    function search(ev, term) {
        api('search', { part: 'snippet', type: 'video', maxResults: 5, q: term }, function (err, data) {
            if (err) return reply(ev, err);
            var items = data.items.map(function (i) {
                return { id: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle };
            });
            if (!items.length) return reply(ev, 'Nothing found.');
            results[ev.client.uid()] = items;
            var lines = items.map(function (i, n) {
                return '[b]' + (n + 1) + '[/b] ' + i.title + ' - ' + i.channel;
            });
            reply(ev, '\n' + lines.join('\n') + '\nPick with ' + prefix + '1 - ' + prefix + items.length);
        });
    }

    function importPlaylist(ev, arg) {
        var m = /[?&]list=([\w-]+)/.exec(arg) || /^([\w-]{10,})$/.exec(arg);
        if (!m) return reply(ev, 'No playlist id found.');
        var listId = m[1], items = [];
        function page(token) {
            var params = { part: 'snippet', playlistId: listId, maxResults: 50 };
            if (token) params.pageToken = token;
            api('playlistItems', params, function (err, data) {
                if (err) return reply(ev, err);
                data.items.forEach(function (i) {
                    var s = i.snippet;
                    if (!s.resourceId || s.title === 'Private video' || s.title === 'Deleted video') return;
                    items.push({ id: s.resourceId.videoId, title: s.title, channel: s.videoOwnerChannelTitle || '' });
                });
                if (data.nextPageToken && items.length < maxPlaylist) return page(data.nextPageToken);
                items = items.slice(0, maxPlaylist);
                reply(ev, 'Queued ' + items.length + ' videos from playlist.');
                enqueue(items);
            });
        }
        page();
    }

    function addUrl(ev, arg) {
        var m = /(?:v=|youtu\.be\/)([\w-]{11})/.exec(arg);
        if (!m) return reply(ev, 'No video id found.');
        api('videos', { part: 'snippet', id: m[1] }, function (err, data) {
            if (err || !data.items.length) return reply(ev, err || 'Video not found.');
            var v = data.items[0];
            enqueue([{ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle }]);
            reply(ev, 'Queued: ' + v.snippet.title);
        });
    }

    function showHelp(ev) {
        var p = prefix;
        reply(ev, [
            '',
            '[b]YouTube[/b]',
            p + 'ys <term>  - search, shows 5 results',
            p + '1 - ' + p + '5  - queue a result of your last search',
            p + 'y <link>  - queue a video or playlist link',
            p + 'yp <link>  - queue a whole playlist (max ' + maxPlaylist + ')',
            '[b]Queue[/b]',
            p + 'q  - show queue',
            p + 'np  - now playing',
            p + 'skip / ' + p + 'next  - next track',
            p + 'remove <n>  - remove entry n',
            p + 'shuffle  - shuffle queue',
            p + 'clear  - empty queue',
            p + 'stop  - stop and empty queue'
        ].join('\n'));
    }

    function showQueue(ev) {
        var lines = [];
        if (current) lines.push('Now: ' + current.title);
        queue.slice(0, 15).forEach(function (i, n) { lines.push((n + 1) + '. ' + i.title); });
        if (queue.length > 15) lines.push('... +' + (queue.length - 15) + ' more');
        reply(ev, lines.length ? '\n' + lines.join('\n') : 'Queue empty.');
    }

    event.on('chat', function (ev) {
        if (!ev.client || ev.client.isSelf()) return;
        var text = (ev.text || '').trim();
        if (text.indexOf(prefix) !== 0) return;
        log('chat mode=' + ev.mode + ' from=' + ev.client.name() + ': ' + text);
        var parts = text.substr(prefix.length).split(/\s+/);
        var cmd = parts.shift().toLowerCase(), arg = parts.join(' ');

        if (/^[1-5]$/.test(cmd)) {
            var list = results[ev.client.uid()];
            var pick = list && list[+cmd - 1];
            if (!pick) return reply(ev, 'No search results. Use ' + prefix + 'ys <term>.');
            enqueue([pick]);
            return reply(ev, 'Queued: ' + pick.title);
        }
        switch (cmd) {
            case 'yh': return showHelp(ev);
            case 'ys': return arg ? search(ev, arg) : reply(ev, 'Usage: ' + prefix + 'ys <term>');
            case 'yp': return importPlaylist(ev, arg);
            case 'y': case 'yt':
                if (!arg) return reply(ev, 'Usage: ' + prefix + 'y <YouTube video or playlist link>');
                // playlist link without a video id -> whole playlist, otherwise single video
                if (/[?&]list=/.test(arg) && !/[?&]v=|youtu\.be\//.test(arg)) return importPlaylist(ev, arg);
                return addUrl(ev, arg);
            case 'q': case 'queue': return showQueue(ev);
            case 'skip': case 'next': return next();
            case 'clear': queue = []; return reply(ev, 'Queue cleared.');
            case 'remove':
                var n = parseInt(arg, 10);
                if (n >= 1 && n <= queue.length) return reply(ev, 'Removed: ' + queue.splice(n - 1, 1)[0].title);
                return reply(ev, 'Usage: ' + prefix + 'remove <number>');
            case 'shuffle':
                for (var i = queue.length - 1; i > 0; i--) {
                    var j = Math.floor(Math.random() * (i + 1)), t = queue[i]; queue[i] = queue[j]; queue[j] = t;
                }
                return reply(ev, 'Queue shuffled.');
            case 'stop':
                stopping = true; queue = []; current = null; clearTimer(); media.stop();
                return;
            case 'np':
                return reply(ev, current ? 'Now: ' + current.title + ' - ' + current.channel + ' ' + videoUrl(current.id) : 'Nothing playing.');
        }
    });
});
