/* Tidal resolver for Tomahawk.
 *
 * Written in 2015 by Anton Romanov, and Will Stott
 *
 * To the extent possible under law, the author(s) have dedicated all
 * copyright and related and neighboring rights to this software to
 * the public domain worldwide. This software is distributed without
 * any warranty.
 *
 * You should have received a copy of the CC0 Public Domain Dedication
 * along with this software. If not, see:
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

var TidalResolver = Tomahawk.extend( Tomahawk.Resolver.Promise, {
    apiVersion: 0.9,

    /* This can also be used with WiMP service if you change next 2 lines */
    api_location : 'https://listen.tidalhifi.com/v1/',
    api_token : 'P5Xbeo5LFvESeDy6',

    logged_in: null, // null, = not yet tried, 0 = pending, 1 = success, 2 = failed

    settings: {
        cacheTime: 300,
        name: 'TIDAL',
        icon: '../images/icon.png',
        weight: 91,
        timeout: 8
    },

    strQuality: ['LOW', 'HIGH', 'LOSSLESS'],
    numQuality: [ 64,    320,    1411     ],

    getConfigUi: function() {
        return {
            "widget": Tomahawk.readBase64( "config.ui" ),
            fields: [{
                name: "email",
                widget: "email_edit",
                property: "text"
            }, {
                name: "password",
                widget: "password_edit",
                property: "text"
            },{
                name: "quality",
                widget: "quality",
                property: "currentIndex"
            }]
        };
    },

    newConfigSaved: function() {
        var config = this.getUserConfig();

        var changed =
            this._email !== config.email ||
            this._password !== config.password ||
            this._quality != config.quality;

        if (changed) {
            this.init();
        }
    },

    testConfig: function (config) {
        return this._getLoginPromise(config).then(function () {
            return {result: Tomahawk.ConfigTestResultType.Success};
        }, function (xhr) {
            if (xhr.status == 401) {
                return {result: Tomahawk.ConfigTestResultType.InvalidCredentials};
            } else {
                return {result: Tomahawk.ConfigTestResultType.CommunicationError};
            }
        });
    },

    init: function() {
        var config = this.getUserConfig();

        this._email = config.email;
        this._password = config.password;
        this._quality = config.quality;

        if (!this._email || !this._password) {
            Tomahawk.reportCapabilities(TomahawkResolverCapability.NullCapability);
            //This is being called even for disabled ones
            //throw new Error( "Invalid configuration." );
            Tomahawk.log("Invalid Configuration");
            return;
        }

        Tomahawk.reportCapabilities(TomahawkResolverCapability.UrlLookup);
        Tomahawk.addCustomUrlHandler( 'tidal', 'getStreamUrl', true );

        return this._login(config);
    },

    _convertTracks: function (entries) {
        return entries.filter(function (entry) {
            return entry.allowStreaming;
        }).map(this._convertTrack, this);
    },

    _convertTrack: function (entry) {
        return {
            artist:     entry.artist.name,
            album:      entry.album.title,
            track:      entry.title,
            title:      entry.title,
            year:       entry.year,

            albumpos:   entry.trackNumber,
            discnumber: entry.volumeNumber,

            duration:   entry.duration,

            url:        'tidal://track/' + entry.id,
            hint:       'tidal://track/' + entry.id,
            checked:    true,
            bitrate:    this.numQuality[this._quality],
            type:       "track",
        };
    },

    _convertAlbum: function (entry) {
        return {
            artist:     entry.artist.name,
            name:       entry.title,
            url:        entry.url,
            type:       "album",
        };
    },

    _convertArtist: function (entry) {
        return {
            name: entry.name,
            type: "artist",
        };
    },

    _convertPlaylist: function (entry) {
        return {
            title:      entry.title,
            guid:       "tidal-playlist-" + entry.uuid,
            info:       entry.description + " (from TidalHiFi)",
            creator:    "tidal-user-" + entry.creator.id,
            // TODO: Perhaps use tidal://playlist/uuid
            url:        entry.url,
            type:       "playlist"
        };
    },

    search: function (params) {
        var query = params.query;
        var limit = params.limit;

        if (!this.logged_in) {
            return this._defer(this.search, [query], this);
        } else if (this.logged_in ===2) {
            throw new Error('Failed login, cannot search.');
        }

        var that = this;
        var settings = {
            data: {
                limit: limit || 9999,
                query: query.replace(/[ \-]+/g, ' ').toLowerCase(),

                sessionId: this._sessionId,
                countryCode: this._countryCode
            }
        };
        return Tomahawk.get(this.api_location + "search/tracks", settings)
            .then(function (response) {
                return that._convertTracks(response.items);
            });
    },

    resolve: function (params) {
        var artist = params.artist;
        var album = params.album;
        var track = params.track;

        var query = [ artist, album, track ].join(' ');

        return this.search({
            query: query,
            limit: 5
        });
    },

    _parseUrlPrefix: function (url) {
        var match = url.match( /(?:https?:\/\/)?(?:listen|play|www)\.(tidalhifi|wimpmusic)\.com\/(?:v1\/)?([a-z]{3,}?)s?\/([\w\-]+)[\/?]?/ );
        // http://www.regexr.com/3ahue
        // 1: 'tidalhifi' or 'wimpmusic'
        // 2: 'artist' or 'album' or 'track' or 'playlist' (removes the s)
        // 3: ID of resource (seems to be the same for both services!)
        return match;
    },

    canParseUrl: function (params) {
        var url = params.url;
        var type = params.type;

        return new RSVP.Promise(function (resolve, reject) {
            url = this._parseUrlPrefix(url);
            if (!url) {
                reject("Couldn't parse URL. Invalid format?");
                return;
            }
            var result;
            switch (type) {
                case TomahawkUrlType.Album:
                    result = url[2] == 'album';
                    break;
                case TomahawkUrlType.Artist:
                    result = url[2] == 'artist';
                    break;
                case TomahawkUrlType.Track:
                    result = url[2] == 'track';
                    break;
                case TomahawkUrlType.Playlist:
                    result = url[2] == 'playlist';
                    break;
            }
            resolve({
                isParseable: result
            });
        });
    },

    _debugPrint: function (obj, spaces) {
        spaces = spaces || '';

        var str = '';
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                var b = ["{", "}"];
                if (obj[key].constructor == Array) {
                    b = ["[", "]"];
                }
                str += spaces + key + ": " + b[0] + "\n" + this._debugPrint(obj[key],
                        spaces + '    ') + "\n" + spaces + b[1] + '\n';
            } else {
                str += spaces + key + ": " + obj[key] + "\n";
            }
        }
        if (spaces != '') {
            return str;
        } else {
            str.split('\n').map(Tomahawk.log, Tomahawk);
        }
    },

    lookupUrl: function (params) {
        var url = params.url;

        return this._getLookupUrlPromise(url);
    },

    _getLookupUrlPromise: function (url) {
        if (!this.logged_in) {
            return this._defer(this.lookupUrl, [url], this);
        } else if (this.logged_in === 2) {
            throw new Error('Failed login, cannot lookupUrl');
        }

        var match = this._parseUrlPrefix(url);

        Tomahawk.log(url + " -> " + match[1] + " " + match[2] + " " + match[3]);

        if (!match[1])
            throw new Error("Couldn't parse given URL: " + url);

        var that = this;

        var params = {
            countryCode: this._countryCode,
            sessionId: this._sessionId,
            limit:  9999,
        };

        if (match[2] == 'album') {
            var rqUrl = this.api_location + 'albums/' + match[3];

            var getInfo = Tomahawk.get(rqUrl, { data: params } );
            var getTracks = Tomahawk.get(rqUrl + "/tracks", { data: params });

            Tomahawk.log(rqUrl);

            return RSVP.Promise.all([getInfo, getTracks]).then(function (response) {
                var result = that._convertAlbum(response[0]);
                result.tracks = that._convertTracks(response[1].items);
                return result;
            });

        } else if (match[2] == 'artist') {
            var rqUrl = this.api_location + 'artists/' + match[3];

            return Tomahawk.get(rqUrl, {
                data: params
            }).then(function (response) {
                return that._convertArtist(response);
            });

        } else if (match[2] == 'track') {
            var rqUrl = this.api_location + 'tracks/' + match[3];
            // I can't find any link on the site for tracks.
            return Tomahawk.get(rqUrl, {
                data: params
            }).then(function (response) {
                return that._convertTrack(response);
            });

        } else if (match[2] == 'playlist') {
            var rqUrl = this.api_location + 'playlists/' + match[3];

            var getInfo = Tomahawk.get(rqUrl, { data: params } );
            var getTracks = Tomahawk.get(rqUrl + "/tracks", { data: params });

            return RSVP.Promise.all([getInfo, getTracks]).then( function (response) {
                var result = that._convertPlaylist(response[0]);
                result.tracks = that._convertTracks(response[1].items);
                return result;
            });
        }
    },

    _parseUrn: function (urn) {
        // "tidal://track/18692667"
        var match = urn.match( /^tidal:\/\/([a-z]+)\/(.+)$/ );
        if (!match) return null;

        return {
            type: match[ 1 ],
            id:   match[ 2 ]
        };
    },

    getStreamUrl: function(params) {
        var url = params.url;

        if (!this.logged_in) {
            return this._defer(this.getStreamUrl, [url], this);
        } else if (this.logged_in === 2) {
            throw new Error('Failed login, cannot getStreamUrl.');
        }

        var parsedUrn = this._parseUrn( url );

        if (!parsedUrn || parsedUrn.type != 'track') {
            Tomahawk.log( "Failed to get stream. Couldn't parse '" + url + "'" );
            return;
        }

        var settings = {
            data: {
                token: this.api_token,
                countryCode: this._countryCode,
                soundQuality: this.strQuality[this._quality],
                sessionId: this._sessionId
            }
        };

        return Tomahawk.get(this.api_location + "tracks/" + parsedUrn.id + "/streamUrl", settings)
            .then(function (response) {
                return {
                    url: response.url
                };
            });
    },

    _defer: function (callback, args, scope) {
        if (typeof this._loginPromise !== 'undefined' && 'then' in this._loginPromise) {
            args = args || [];
            scope = scope || this;
            Tomahawk.log('Deferring action with ' + args.length + ' arguments.');
            return this._loginPromise.then(function () {
                Tomahawk.log('Performing deferred action with ' + args.length + ' arguments.');
                callback.call(scope, args);
            });
        }
    },

    _getLoginPromise: function (config) {
        var settings = {
            type: 'POST', // backwards compatibility for old versions of tomahawk.js
            data: {
                "username": config.email.trim(),
                "password": config.password.trim()
            },
            headers: {'Origin': 'http://listen.tidalhifi.com'}
        };
        return Tomahawk.post(this.api_location + "login/username?token=" + this.api_token,
            settings);
    },

    _login: function (config) {
        // If a login is already in progress don't start another!
        if (this.logged_in === 0) return;
        this.logged_in = 0;

        var that = this;

        this._loginPromise = this._getLoginPromise(config).then(
            function (resp) {
                Tomahawk.log(that.settings.name + " successfully logged in.");

                that._countryCode = resp.countryCode;
                that._sessionId = resp.sessionId;
                that._userId = resp.userId;

                that.logged_in = 1;
            },
            function (error) {
                Tomahawk.log(that.settings.name + " failed login.");

                delete that._countryCode;
                delete that._sessionId;
                delete that._userId;

                that.logged_in = 2;
            }
        );
        return this._loginPromise;
    }
});

Tomahawk.resolver.instance = TidalResolver;
