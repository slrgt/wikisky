// Storage abstraction layer - pure JavaScript, uses localStorage and Bluesky PDS
class WikiStorage {
    constructor() {
        this.blueskyClient = null;
        this.storageMode = 'local';
        this.articles = {};
        this.history = [];
        this.comments = {}; // Store comments by article key: { articleKey: [comments] }
    }

    async init() {
        try {
            this.loadFromLocalStorage();
        } catch (error) {
            console.error('LocalStorage load error:', error);
        }
        
        // Try to automatically get directory access to current directory
        await this.autoRequestArchiveDirectory();
        
        // Check for OAuth callback first
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('code') && urlParams.get('state')) {
            // OAuth callback - handle it
            await this.handleOAuthCallback();
            return; // Don't load existing connection if we just completed OAuth
        }
        
        try {
            await this.loadBlueskyConnection();
            // When logged into Bluesky, artboards (archive + albums) load from PDS so they sync across devices
            if (this.storageMode === 'bluesky' && this.blueskyClient) {
                await this.loadArchiveFromBluesky();
            }
        } catch (error) {
            console.error('Bluesky connection error:', error);
        }
    }

    // Artboard lexicons: store media links and albums on PDS
    static ARTBOARD_COLLECTION = 'app.wikisky.artboard';
    static ARTBOARD_ALBUM_COLLECTION = 'app.wikisky.artboardAlbum';

    _artboardItemToRecord(item) {
        const postText = (item.postText || item.textSnippet || '').slice(0, 2000);
        return {
            $type: 'app.wikisky.artboard',
            imageUrl: item.imageUrl && item.imageUrl.startsWith('http') ? item.imageUrl : '',
            videoUrl: (item.videoUrl && item.videoUrl.startsWith('http')) ? item.videoUrl : undefined,
            type: item.type === 'video' ? 'video' : 'image',
            source: item.source && item.source.startsWith('http') ? item.source : undefined,
            name: (item.name || 'Image').slice(0, 512),
            createdAt: item.createdAt || new Date().toISOString(),
            authorHandle: item.authorHandle ? String(item.authorHandle).slice(0, 256) : undefined,
            authorDid: item.authorDid ? String(item.authorDid).slice(0, 128) : undefined,
            authorDisplayName: item.authorDisplayName ? String(item.authorDisplayName).slice(0, 256) : undefined,
            postText: postText || undefined,
            albumIds: Array.isArray(item.albumIds) ? item.albumIds.slice(0, 50).map(s => String(s).slice(0, 128)) : [],
            articleIds: Array.isArray(item.articleIds) ? item.articleIds.slice(0, 50).map(s => String(s).slice(0, 256)) : undefined,
            habitDays: Array.isArray(item.habitDays) ? item.habitDays.slice(0, 50).map(s => String(s).slice(0, 32)) : undefined,
            assignmentType: item.assignmentType || 'albums'
        };
    }

    _recordToArtboardItem(rkey, value) {
        if (!value || typeof value !== 'object') return null;
        return {
            id: rkey,
            name: value.name || 'Image',
            type: value.type || 'image',
            source: value.source || null,
            imageUrl: value.imageUrl || null,
            videoUrl: value.videoUrl || null,
            createdAt: value.createdAt || new Date().toISOString(),
            authorHandle: value.authorHandle || null,
            authorDid: value.authorDid || null,
            authorDisplayName: value.authorDisplayName || null,
            postText: value.postText || null,
            albumIds: Array.isArray(value.albumIds) ? value.albumIds : [],
            articleIds: Array.isArray(value.articleIds) ? value.articleIds : [],
            habitDays: Array.isArray(value.habitDays) ? value.habitDays : [],
            assignmentType: value.assignmentType || 'albums'
        };
    }

    async _loadArtboardFromLexicon() {
        const did = this.blueskyClient.did;
        const archive = [];
        let url = `${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${WikiStorage.ARTBOARD_COLLECTION}&limit=100`;
        let cursor;
        do {
            const u = cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
            const res = await this._pdsFetch(u);
            if (!res.ok) break;
            const data = await res.json();
            (data.records || []).forEach(r => {
                const item = this._recordToArtboardItem(r.rkey || r.key, r.value);
                if (item) archive.push(item);
            });
            cursor = data.cursor || null;
        } while (cursor);

        const albums = [];
        url = `${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${WikiStorage.ARTBOARD_ALBUM_COLLECTION}&limit=100`;
        cursor = undefined;
        do {
            const u = cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
            const res = await this._pdsFetch(u);
            if (!res.ok) break;
            const data = await res.json();
            (data.records || []).forEach(r => {
                const v = r.value;
                if (v && v.name) albums.push({ id: r.rkey || r.key, name: v.name, createdAt: v.createdAt || new Date().toISOString() });
            });
            cursor = data.cursor || null;
        } while (cursor);

        return { archive, albums };
    }

    async _createArtboardItemOnPDS(item) {
        const rkey = String(item.id).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128) || item.id;
        const record = this._artboardItemToRecord(item);
        const body = { repo: this.blueskyClient.did, collection: WikiStorage.ARTBOARD_COLLECTION, rkey, record };
        const res = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (err.error !== 'InvalidRequest' && err.message && !err.message.includes('already exists')) throw new Error(err.message || err.error || 'createRecord failed');
        }
    }

    async _putArtboardItemOnPDS(item) {
        const rkey = String(item.id).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128) || item.id;
        const record = this._artboardItemToRecord(item);
        const body = { repo: this.blueskyClient.did, collection: WikiStorage.ARTBOARD_COLLECTION, rkey, record };
        const res = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.putRecord`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || err.error || 'putRecord failed');
        }
    }

    async _deleteArtboardItemOnPDS(rkey) {
        if (!this.blueskyClient?.accessJwt) return;
        const resolvedPds = await this._resolvePdsUrlForDid(this.blueskyClient.did);
        this.blueskyClient.pdsUrl = resolvedPds;
        const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
        session.pdsUrl = resolvedPds;
        localStorage.setItem('bluesky-session', JSON.stringify(session));
        await this.ensureValidToken();
        const safeRkey = String(rkey).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128) || rkey;
        const base = this._pdsBaseForRepo();
        const url = `${base.replace(/\/$/, '')}/xrpc/com.atproto.repo.deleteRecord`;
        const res = await this._pdsFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: this.blueskyClient.did, collection: WikiStorage.ARTBOARD_COLLECTION, rkey: safeRkey })
        });
        if (!res.ok && res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || err.error || 'Failed to delete from PDS');
        }
    }

    async _createArtboardAlbumOnPDS(album) {
        const rkey = String(album.id).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128) || album.id;
        const record = { $type: 'app.wikisky.artboardAlbum', name: (album.name || '').slice(0, 256), createdAt: album.createdAt || new Date().toISOString() };
        const body = { repo: this.blueskyClient.did, collection: WikiStorage.ARTBOARD_ALBUM_COLLECTION, rkey, record };
        const res = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (err.error !== 'InvalidRequest' && err.message && !err.message.includes('already exists')) throw new Error(err.message || err.error);
        }
    }

    async _deleteArtboardAlbumOnPDS(rkey) {
        if (!this.blueskyClient?.accessJwt) return;
        const resolvedPds = await this._resolvePdsUrlForDid(this.blueskyClient.did);
        this.blueskyClient.pdsUrl = resolvedPds;
        const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
        session.pdsUrl = resolvedPds;
        localStorage.setItem('bluesky-session', JSON.stringify(session));
        await this.ensureValidToken();
        const safeRkey = String(rkey).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128) || rkey;
        const base = this._pdsBaseForRepo();
        const url = `${base.replace(/\/$/, '')}/xrpc/com.atproto.repo.deleteRecord`;
        const res = await this._pdsFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: this.blueskyClient.did, collection: WikiStorage.ARTBOARD_ALBUM_COLLECTION, rkey: safeRkey })
        });
        if (!res.ok && res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || err.error || 'Failed to delete album from PDS');
        }
    }

    async loadArchiveFromBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            await this.ensureValidToken();
            const localArchive = this.getArchive();
            const localAlbums = this.getAlbums();

            try {
                const { archive: lexiconArchive, albums: lexiconAlbums } = await this._loadArtboardFromLexicon();
                if (lexiconArchive.length > 0 || lexiconAlbums.length > 0) {
                    const pdsIds = new Set(lexiconArchive.map(a => a.id));
                    const onlyLocal = localArchive.filter(a => !pdsIds.has(a.id));
                    const merged = [...lexiconArchive, ...onlyLocal];
                    localStorage.setItem('xoxowiki-archive', JSON.stringify(merged));
                    for (const it of onlyLocal) {
                        try { await this._createArtboardItemOnPDS(it); } catch (_) {}
                    }
                    const pdsAlbumIds = new Set(lexiconAlbums.map(a => a.id));
                    const onlyLocalAlbums = localAlbums.filter(a => !pdsAlbumIds.has(a.id));
                    const mergedAlbums = [...lexiconAlbums, ...onlyLocalAlbums];
                    localStorage.setItem('xoxowiki-albums', JSON.stringify(mergedAlbums));
                    for (const al of onlyLocalAlbums) {
                        try { await this._createArtboardAlbumOnPDS(al); } catch (_) {}
                    }
                    if (onlyLocal.length > 0 || onlyLocalAlbums.length > 0) await this.syncArchiveToBlueskyIfConnected();
                    return;
                }
            } catch (e) {
                console.warn('Load artboard from lexicon failed, trying legacy:', e);
            }

            const res = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=xoxowiki-archive`);
            if (!res.ok) {
                if (localArchive.length > 0) await this.syncArchiveToBlueskyIfConnected();
                return;
            }
            const data = await res.json();
            const content = data.value?.content;
            if (typeof content === 'string') {
                const payload = JSON.parse(content);
                if (payload.archive && Array.isArray(payload.archive)) {
                    const pdsIds = new Set(payload.archive.map(a => a.id));
                    const onlyLocal = localArchive.filter(a => !pdsIds.has(a.id));
                    const merged = [...payload.archive, ...onlyLocal];
                    localStorage.setItem('xoxowiki-archive', JSON.stringify(merged));
                    if (onlyLocal.length > 0) await this.syncArchiveToBlueskyIfConnected();
                } else if (localArchive.length > 0) {
                    await this.syncArchiveToBlueskyIfConnected();
                } else {
                    localStorage.setItem('xoxowiki-archive', JSON.stringify([]));
                }
                if (payload.albums && Array.isArray(payload.albums)) {
                    const pdsAlbumIds = new Set((payload.albums || []).map(a => a.id));
                    const onlyLocalAlbums = localAlbums.filter(a => !pdsAlbumIds.has(a.id));
                    const mergedAlbums = [...(payload.albums || []), ...onlyLocalAlbums];
                    localStorage.setItem('xoxowiki-albums', JSON.stringify(mergedAlbums));
                    if (onlyLocalAlbums.length > 0) await this.syncArchiveToBlueskyIfConnected();
                }
            }
            await this.loadBookmarksAndHabitsFromBluesky();
            // Push any articles or archive items created offline to the logged-in Bluesky account
            await this.syncLocalArticlesToBluesky();
            await this.syncLocalArchiveItemsToBluesky();
        } catch (e) {
            console.warn('Load archive from Bluesky failed:', e);
        }
    }

    /** Push all local articles to the PDS (for articles created while offline). */
    async syncLocalArticlesToBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            await this.ensureValidToken();
            const local = this.getAllArticlesFromLocal();
            for (const key of Object.keys(local)) {
                const article = local[key];
                if (!article || !article.title) continue;
                try {
                    await this.saveArticleToBluesky(key, article.title, article.content || '');
                } catch (e) {
                    console.warn('Sync article to Bluesky failed:', key, e);
                }
            }
        } catch (e) {
            console.warn('Sync local articles to Bluesky failed:', e);
        }
    }

    /** Upload local-only archive items (images stored in IndexedDB or fetchable URLs) to PDS and create artboard records. */
    async syncLocalArchiveItemsToBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            await this.ensureValidToken();
            const archive = this.getArchive();
            let updated = false;
            for (const item of archive) {
                if (item.atBlobRef) {
                    try { await this._createArtboardItemOnPDS(item); } catch (_) {}
                    continue;
                }
                let blob = null;
                if (item.filename) {
                    blob = await this.getFileFromIndexedDB(item.filename);
                    if (blob && !(blob instanceof Blob)) blob = null;
                }
                if (!blob && item.imageUrl && typeof item.imageUrl === 'string' && item.imageUrl.startsWith('http')) {
                    try {
                        const res = await fetch(item.imageUrl, { mode: 'cors' });
                        if (res.ok) blob = await res.blob();
                    } catch (_) {}
                }
                if (!blob) continue;
                const mimeType = blob.type || 'image/jpeg';
                try {
                    const blobResult = await this.uploadBlobToAtProtocol(blob, mimeType);
                    item.atBlobRef = blobResult.ref;
                    item.atBlobRefDid = this.blueskyClient.did;
                    item.imageUrl = this.getAtProtocolBlobUrl(blobResult.ref?.$link || blobResult.ref, this.blueskyClient.did);
                    await this._createArtboardItemOnPDS(item);
                    updated = true;
                } catch (e) {
                    console.warn('Sync archive item to Bluesky failed:', item.id, e);
                }
            }
            if (updated) {
                localStorage.setItem('xoxowiki-archive', JSON.stringify(archive));
                await this.syncArchiveToBlueskyIfConnected();
            }
        } catch (e) {
            console.warn('Sync local archive items to Bluesky failed:', e);
        }
    }

    /** Fetch a generic com.atproto.repo.record by rkey; returns parsed content object or null. */
    async _getRepoRecord(rkey) {
        if (!this.blueskyClient?.accessJwt) return null;
        const res = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=${encodeURIComponent(rkey)}`);
        if (!res.ok) return null;
        const data = await res.json();
        const content = data.value?.content;
        if (typeof content !== 'string') return null;
        try { return JSON.parse(content); } catch (_) { return null; }
    }

    /** Create or update a generic com.atproto.repo.record with string content (payload will be JSON.stringified). */
    async _putRepoRecord(rkey, payload) {
        if (!this.blueskyClient?.accessJwt) return;
        await this.ensureValidToken();
        const record = {
            $type: 'com.atproto.repo.record',
            key: rkey,
            title: rkey,
            content: JSON.stringify(payload),
            createdAt: new Date().toISOString()
        };
        const body = { repo: this.blueskyClient.did, collection: 'com.atproto.repo.record', rkey, record };
        const getRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=${encodeURIComponent(rkey)}`);
        if (getRes.ok) {
            const putRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.putRecord`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!putRes.ok) {
                const err = await putRes.json().catch(() => ({}));
                throw new Error(err.message || err.error || 'putRecord failed');
            }
        } else {
            const createRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!createRes.ok) {
                const err = await createRes.json().catch(() => ({}));
                throw new Error(err.message || err.error || 'createRecord failed');
            }
        }
    }

    async loadBookmarksAndHabitsFromBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            await this.ensureValidToken();
            const [bookmarksPayload, habitsPayload, habitLogPayload] = await Promise.all([
                this._getRepoRecord('xoxowiki-bookmarks'),
                this._getRepoRecord('xoxowiki-habits'),
                this._getRepoRecord('xoxowiki-habit-log')
            ]);
            if (bookmarksPayload && Array.isArray(bookmarksPayload.bookmarks)) {
                const local = this.getBookmarks();
                const pdsSet = new Set(bookmarksPayload.bookmarks);
                const onlyLocal = local.filter(b => !pdsSet.has(b));
                const merged = [...bookmarksPayload.bookmarks, ...onlyLocal];
                localStorage.setItem('xoxowiki-bookmarks', JSON.stringify(merged));
                if (onlyLocal.length > 0) this.syncBookmarksToBluesky().catch(() => {});
            }
            if (habitsPayload && Array.isArray(habitsPayload.habits)) {
                const local = this.getHabits();
                const pdsSet = new Set(habitsPayload.habits);
                const onlyLocal = local.filter(h => !pdsSet.has(h));
                const merged = [...habitsPayload.habits, ...onlyLocal];
                localStorage.setItem('xoxowiki-habits', JSON.stringify(merged));
                if (onlyLocal.length > 0) this.syncHabitsToBluesky().catch(() => {});
            }
            if (habitLogPayload && habitLogPayload.log && typeof habitLogPayload.log === 'object') {
                const local = this.getHabitLog();
                const merged = { ...habitLogPayload.log, ...local };
                localStorage.setItem('xoxowiki-habit-log', JSON.stringify(merged));
                this.syncHabitLogToBluesky().catch(() => {});
            }
        } catch (e) {
            console.warn('Load bookmarks/habits from Bluesky failed:', e);
        }
    }

    async syncBookmarksToBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            const bookmarks = this.getBookmarks();
            await this._putRepoRecord('xoxowiki-bookmarks', { bookmarks, updatedAt: new Date().toISOString() });
        } catch (e) {
            console.warn('Sync bookmarks to Bluesky failed:', e);
        }
    }

    async syncHabitsToBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            const habits = this.getHabits();
            await this._putRepoRecord('xoxowiki-habits', { habits, updatedAt: new Date().toISOString() });
        } catch (e) {
            console.warn('Sync habits to Bluesky failed:', e);
        }
    }

    async syncHabitLogToBluesky() {
        if (!this.blueskyClient?.accessJwt) return;
        try {
            const log = this.getHabitLog();
            await this._putRepoRecord('xoxowiki-habit-log', { log, updatedAt: new Date().toISOString() });
        } catch (e) {
            console.warn('Sync habit log to Bluesky failed:', e);
        }
    }

    // Load from localStorage
    loadFromLocalStorage() {
        try {
            const stored = localStorage.getItem('xoxowiki-articles');
            if (stored) {
                this.articles = JSON.parse(stored);
            }
            
            const storedHistory = localStorage.getItem('xoxowiki-history');
            if (storedHistory) {
                this.history = JSON.parse(storedHistory);
            }
            
            const storedComments = localStorage.getItem('xoxowiki-comments');
            if (storedComments) {
                this.comments = JSON.parse(storedComments);
            }
        } catch (error) {
            console.error('Error loading from localStorage:', error);
            this.articles = {};
            this.history = [];
            this.comments = {};
        }
    }

    // Save to localStorage
    saveToLocalStorage() {
        try {
            localStorage.setItem('xoxowiki-articles', JSON.stringify(this.articles));
            localStorage.setItem('xoxowiki-history', JSON.stringify(this.history));
            localStorage.setItem('xoxowiki-comments', JSON.stringify(this.comments));
        } catch (error) {
            console.error('Error saving to localStorage:', error);
        }
    }

    // Load saved Bluesky connection (refresh token or OAuth)
    async loadBlueskyConnection() {
        try {
            const saved = localStorage.getItem('bluesky-session');
            if (saved) {
                const session = JSON.parse(saved);
                if (session.refreshJwt) {
                    try {
                        if (session.oauth && localStorage.getItem('bluesky-oauth-dpop-private-jwk')) {
                            // One-time migration: public JWK was previously saved under wrong key
                            if (!localStorage.getItem('bluesky-oauth-dpop-public-jwk') && localStorage.getItem('bluesky-dpop-public-jwk')) {
                                localStorage.setItem('bluesky-oauth-dpop-public-jwk', localStorage.getItem('bluesky-dpop-public-jwk'));
                            }
                            await this._oauthRefresh();
                        } else {
                            const response = await fetch('https://bsky.social/xrpc/com.atproto.server.refreshSession', {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${session.refreshJwt}` }
                            });
                            if (response.ok) {
                                const data = await response.json();
                                this.blueskyClient = {
                                    did: session.did,
                                    handle: session.handle,
                                    accessJwt: data.accessJwt,
                                    refreshJwt: data.refreshJwt,
                                    tokenTimestamp: Date.now(),
                                    pdsUrl: session.pdsUrl || null
                                };
                                this.storageMode = 'bluesky';
                                session.refreshJwt = data.refreshJwt;
                                localStorage.setItem('bluesky-session', JSON.stringify(session));
                            }
                        }
                    } catch (error) {
                        console.error('Error refreshing session:', error);
                        // Don't clear session on refresh failure (e.g. network) so user stays "logged in" and we can retry on next load
                        const isInvalidGrant = (error.message || '').toLowerCase().includes('invalid_grant') || (error.message || '').toLowerCase().includes('expired');
                        if (session.oauth && isInvalidGrant) {
                            localStorage.removeItem('bluesky-oauth-dpop-private-jwk');
                            localStorage.removeItem('bluesky-oauth-dpop-public-jwk');
                            localStorage.removeItem('bluesky-session');
                        }
                        this.blueskyClient = null;
                        this.storageMode = 'local';
                    }
                }
            }
            if (this.blueskyClient && !this.blueskyClient.pdsUrl) {
                this.blueskyClient.pdsUrl = await this._resolvePdsUrlForDid(this.blueskyClient.did);
                const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
                session.pdsUrl = this.blueskyClient.pdsUrl;
                localStorage.setItem('bluesky-session', JSON.stringify(session));
            }
        } catch (error) {
            console.error('Error loading Bluesky connection:', error);
        }
    }

    async _oauthRefresh() {
        const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
        const tokenEndpoint = 'https://bsky.social/oauth/token';
        const clientId = this._oauthClientId();
        const privateJwk = localStorage.getItem('bluesky-oauth-dpop-private-jwk');
        const publicJwk = localStorage.getItem('bluesky-oauth-dpop-public-jwk');
        if (!session.refreshJwt || !privateJwk || !publicJwk) throw new Error('OAuth session incomplete');
        const privateKey = await this._importPrivateKeyJwk(JSON.parse(privateJwk));
        const publicKeyJwk = JSON.parse(publicJwk);
        let nonce = localStorage.getItem('bluesky-dpop-nonce') || '';
        let dpopProof = await this._buildDpopProof('POST', tokenEndpoint, nonce || undefined, privateKey, publicKeyJwk);
        let res = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'DPoP': dpopProof },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: session.refreshJwt,
                client_id: clientId
            }).toString()
        });
        if (res.status === 401) {
            const err = await res.json().catch(() => ({}));
            nonce = res.headers.get('dpop-nonce') || res.headers.get('DPoP-Nonce') || '';
            if (err.error === 'use_dpop_nonce' && nonce) {
                localStorage.setItem('bluesky-dpop-nonce', nonce);
                dpopProof = await this._buildDpopProof('POST', tokenEndpoint, nonce, privateKey, publicKeyJwk);
                res = await fetch(tokenEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'DPoP': dpopProof },
                    body: new URLSearchParams({
                        grant_type: 'refresh_token',
                        refresh_token: session.refreshJwt,
                        client_id: clientId
                    }).toString()
                });
            }
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err.error_description || err.error || 'Token refresh failed';
            throw new Error(msg);
        }
        const data = await res.json();
        const newNonce = res.headers.get('dpop-nonce') || res.headers.get('DPoP-Nonce');
        if (newNonce) localStorage.setItem('bluesky-dpop-nonce', newNonce);
        const pdsUrl = session.pdsUrl || await this._resolvePdsUrlForDid(session.did);
        this.blueskyClient = {
            did: session.did,
            handle: session.handle,
            accessJwt: data.access_token,
            refreshJwt: data.refresh_token,
            tokenTimestamp: Date.now(),
            pdsUrl
        };
        session.refreshJwt = data.refresh_token;
        session.pdsUrl = pdsUrl;
        localStorage.setItem('bluesky-session', JSON.stringify(session));
        this.storageMode = 'bluesky';
    }

    // --- AT Protocol OAuth (PAR + PKCE + DPoP) ---
    // Published app URL for OAuth (must match redirect_uris in oauth-client-metadata.json).
    // When not on this origin (e.g. file:// or localhost), we still use it so login redirects to the published app.
    _oauthBaseUrl() {
        const published = 'https://slrgt.github.io/wikisky';
        const origin = window.location.origin;
        if (!origin || origin === 'null' || origin === 'file:') return published;
        if (origin === 'https://slrgt.github.io' && (window.location.pathname || '').startsWith('/wikisky')) {
            return published;
        }
        return published;
    }
    _oauthClientId() {
        return this._oauthBaseUrl() + '/oauth-client-metadata.json';
    }
    _oauthRedirectUri() {
        const base = this._oauthBaseUrl();
        return base.endsWith('/') ? base : base + '/';
    }
    async _sha256Bytes(data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return new Uint8Array(hash);
    }
    _base64urlEncode(bytes) {
        const bin = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
        let binary = '';
        for (let i = 0; i < bin.length; i++) binary += String.fromCharCode(bin[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async _pkceChallenge(verifier) {
        const hash = await this._sha256Bytes(verifier);
        return this._base64urlEncode(hash);
    }
    async _generateDpopKeypair() {
        return await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify']
        );
    }
    async _exportKeyJwk(key) {
        const jwk = await crypto.subtle.exportKey('jwk', key);
        delete jwk.key_ops;
        delete jwk.ext;
        return jwk;
    }
    async _importPrivateKeyJwk(jwk) {
        return await crypto.subtle.importKey(
            'jwk',
            { ...jwk, key_ops: ['sign'] },
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign']
        );
    }
    async _signJwtEs256(header, payload, privateKey) {
        const enc = (obj) => this._base64urlEncode(JSON.stringify(obj));
        const headerB64 = enc(header);
        const payloadB64 = enc(payload);
        const message = new TextEncoder().encode(headerB64 + '.' + payloadB64);
        const sig = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            privateKey,
            message
        );
        return headerB64 + '.' + payloadB64 + '.' + this._base64urlEncode(new Uint8Array(sig));
    }
    async _buildDpopProof(htm, htu, nonce, privateKey, publicKeyJwk, accessTokenHash = null) {
        if (!publicKeyJwk || !publicKeyJwk.crv) throw new Error('DPoP requires public key JWK');
        const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicKeyJwk };
        const payload = {
            jti: crypto.randomUUID(),
            htm,
            htu,
            iat: Math.floor(Date.now() / 1000),
            ...(nonce ? { nonce } : {}),
            ...(accessTokenHash ? { ath: accessTokenHash } : {})
        };
        return await this._signJwtEs256(header, payload, privateKey);
    }

    async startBlueskyOAuth(handle) {
        const clientId = this._oauthClientId();
        const redirectUri = this._oauthRedirectUri();
        const resHandle = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
        if (!resHandle.ok) throw new Error('Could not resolve handle');
        const { did } = await resHandle.json();
        const resPlc = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
        if (!resPlc.ok) throw new Error('Could not resolve DID');
        const didDoc = await resPlc.json();
        const pdsUrl = didDoc.service?.[0]?.serviceEndpoint || 'https://bsky.social';
        const resResource = await fetch(pdsUrl.replace(/\/$/, '') + '/.well-known/oauth-protected-resource');
        if (!resResource.ok) throw new Error('Could not get PDS metadata');
        const resourceMeta = await resResource.json();
        const authServerUrl = resourceMeta.authorization_servers?.[0] || 'https://bsky.social';
        const resAuth = await fetch(authServerUrl.replace(/\/$/, '') + '/.well-known/oauth-authorization-server');
        if (!resAuth.ok) throw new Error('Could not get OAuth server metadata');
        const authMeta = await resAuth.json();
        const parEndpoint = authMeta.pushed_authorization_request_endpoint;
        const authEndpoint = authMeta.authorization_endpoint;
        const tokenEndpoint = authMeta.token_endpoint;
        const issuer = authMeta.issuer;

        const stateArr = new Uint8Array(28);
        crypto.getRandomValues(stateArr);
        const state = Array.from(stateArr, b => ('0' + b.toString(16)).slice(-2)).join('');
        const verifierArr = new Uint8Array(32);
        crypto.getRandomValues(verifierArr);
        const codeVerifier = this._base64urlEncode(verifierArr);
        const codeChallenge = await this._pkceChallenge(codeVerifier);

        const keypair = await this._generateDpopKeypair();
        const privateJwk = await this._exportKeyJwk(keypair.privateKey);
        const publicJwk = await this._exportKeyJwk(keypair.publicKey);

        const scopePreferred = 'atproto repo:site.standard.document repo:com.atproto.repo.record rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app%23bsky_appview';
        const scopeFallback = 'atproto transition:generic';
        let parBody = new URLSearchParams({
            response_type: 'code',
            code_challenge_method: 'S256',
            scope: scopePreferred,
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: codeChallenge,
            state,
            login_hint: handle
        });
        let parRes = await fetch(parEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: parBody.toString()
        });
        let dpopNonce = parRes.headers.get('dpop-nonce') || parRes.headers.get('DPoP-Nonce');
        if (parRes.status === 401) {
            const errBody = await parRes.json().catch(() => ({}));
            if (errBody.error === 'use_dpop_nonce') dpopNonce = parRes.headers.get('dpop-nonce') || parRes.headers.get('DPoP-Nonce');
            if (!dpopNonce) throw new Error('PAR requires DPoP');
            const privateKey = await this._importPrivateKeyJwk(privateJwk);
            const dpopProof = await this._buildDpopProof('POST', parEndpoint, dpopNonce, privateKey, publicJwk);
            parRes = await fetch(parEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'DPoP': dpopProof
                },
                body: parBody.toString()
            });
        }
        if (!parRes.ok) {
            const err = await parRes.json().catch(() => ({}));
            const errMsg = (err.error_description || err.error || '').toLowerCase();
            if ((err.error === 'invalid_scope' || errMsg.includes('scope')) && scopePreferred.includes('repo:')) {
                parBody = new URLSearchParams({
                    response_type: 'code',
                    code_challenge_method: 'S256',
                    scope: scopeFallback,
                    client_id: clientId,
                    redirect_uri: redirectUri,
                    code_challenge: codeChallenge,
                    state,
                    login_hint: handle
                });
                parRes = await fetch(parEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: parBody.toString()
                });
                if (parRes.status === 401 && parRes.headers.get('dpop-nonce')) {
                    const privateKey = await this._importPrivateKeyJwk(privateJwk);
                    const dpopProof = await this._buildDpopProof('POST', parEndpoint, parRes.headers.get('dpop-nonce'), privateKey, publicJwk);
                    parRes = await fetch(parEndpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'DPoP': dpopProof },
                        body: parBody.toString()
                    });
                }
            }
            if (!parRes.ok) {
                const err2 = await parRes.json().catch(() => ({}));
                throw new Error(err2.error_description || err2.error || 'PAR failed');
            }
        }
        const parData = await parRes.json();
        const requestUri = parData.request_uri;
        if (!requestUri) throw new Error('No request_uri from PAR');
        dpopNonce = parRes.headers.get('dpop-nonce') || parRes.headers.get('DPoP-Nonce') || dpopNonce;

        sessionStorage.setItem('bluesky-oauth-state', state);
        sessionStorage.setItem('bluesky-oauth-code-verifier', codeVerifier);
        sessionStorage.setItem('bluesky-oauth-handle', handle);
        sessionStorage.setItem('bluesky-oauth-token-endpoint', tokenEndpoint);
        sessionStorage.setItem('bluesky-oauth-issuer', issuer);
        sessionStorage.setItem('bluesky-oauth-dpop-nonce', dpopNonce || '');
        sessionStorage.setItem('bluesky-oauth-dpop-private-jwk', JSON.stringify(privateJwk));
        sessionStorage.setItem('bluesky-oauth-dpop-public-jwk', JSON.stringify(publicJwk));

        const redirectUrl = authEndpoint + '?client_id=' + encodeURIComponent(clientId) + '&request_uri=' + encodeURIComponent(requestUri);
        window.location.href = redirectUrl;
    }

    async handleOAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');
        const iss = urlParams.get('iss');
        const storedState = sessionStorage.getItem('bluesky-oauth-state');
        const codeVerifier = sessionStorage.getItem('bluesky-oauth-code-verifier');
        const handle = sessionStorage.getItem('bluesky-oauth-handle');
        const tokenEndpoint = sessionStorage.getItem('bluesky-oauth-token-endpoint');
        const issuer = sessionStorage.getItem('bluesky-oauth-issuer');
        const dpopNonce = sessionStorage.getItem('bluesky-oauth-dpop-nonce');
        const privateJwk = sessionStorage.getItem('bluesky-oauth-dpop-private-jwk');

        if (code || state) {
            window.history.replaceState({}, document.title, window.location.pathname || '/');
        }
        if (!code || !state || state !== storedState || !codeVerifier || !tokenEndpoint || !privateJwk) {
            if (code || state) console.error('OAuth callback: missing or invalid state/params');
            return false;
        }
        if (iss && iss !== issuer) {
            console.error('OAuth callback: issuer mismatch');
            return false;
        }

        try {
            const clientId = this._oauthClientId();
            const redirectUri = this._oauthRedirectUri();
            const privateKey = await this._importPrivateKeyJwk(JSON.parse(privateJwk));
            const publicJwk = JSON.parse(sessionStorage.getItem('bluesky-oauth-dpop-public-jwk') || '{}');
            localStorage.setItem('bluesky-oauth-dpop-public-jwk', JSON.stringify(publicJwk));
            const dpopProof = await this._buildDpopProof('POST', tokenEndpoint, dpopNonce || undefined, privateKey, publicJwk);

            const tokenBody = new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                code_verifier: codeVerifier
            });
            const tokenRes = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'DPoP': dpopProof
                },
                body: tokenBody.toString()
            });
            if (!tokenRes.ok) {
                const err = await tokenRes.json().catch(() => ({}));
                throw new Error(err.error_description || err.error || 'Token exchange failed');
            }
            const data = await tokenRes.json();
            const accessToken = data.access_token;
            const refreshToken = data.refresh_token;
            const sub = data.sub;
            if (!accessToken || !refreshToken || !sub) throw new Error('Invalid token response');

            localStorage.setItem('bluesky-oauth-dpop-private-jwk', privateJwk);
            const pdsUrl = await this._resolvePdsUrlForDid(sub);
            this.blueskyClient = {
                did: sub,
                handle: handle || sub,
                accessJwt: accessToken,
                refreshJwt: refreshToken,
                tokenTimestamp: Date.now(),
                pdsUrl
            };
            localStorage.setItem('bluesky-session', JSON.stringify({
                handle: this.blueskyClient.handle,
                did: this.blueskyClient.did,
                refreshJwt: this.blueskyClient.refreshJwt,
                oauth: true,
                pdsUrl
            }));
            sessionStorage.removeItem('bluesky-oauth-state');
            sessionStorage.removeItem('bluesky-oauth-code-verifier');
            sessionStorage.removeItem('bluesky-oauth-handle');
            sessionStorage.removeItem('bluesky-oauth-token-endpoint');
            sessionStorage.removeItem('bluesky-oauth-issuer');
            sessionStorage.removeItem('bluesky-oauth-dpop-nonce');
            sessionStorage.removeItem('bluesky-oauth-dpop-private-jwk');
            sessionStorage.removeItem('bluesky-oauth-dpop-public-jwk');
            this.storageMode = 'bluesky';
            await this.loadArchiveFromBluesky();
            return true;
        } catch (error) {
            console.error('OAuth callback error:', error);
            sessionStorage.removeItem('bluesky-oauth-state');
            sessionStorage.removeItem('bluesky-oauth-code-verifier');
            sessionStorage.removeItem('bluesky-oauth-handle');
            sessionStorage.removeItem('bluesky-oauth-token-endpoint');
            sessionStorage.removeItem('bluesky-oauth-issuer');
            sessionStorage.removeItem('bluesky-oauth-dpop-nonce');
            sessionStorage.removeItem('bluesky-oauth-dpop-private-jwk');
            sessionStorage.removeItem('bluesky-oauth-dpop-public-jwk');
            return false;
        }
    }

    // Legacy method for app password (kept for fallback)
    async connectBluesky(handle, password, saveCredentials = true) {
        try {
            // Use AT Protocol's createSession endpoint (same as pckt.blog)
            const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    identifier: handle,
                    password: password // App password recommended
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                if (response.status === 401) {
                    throw new Error('Invalid handle or app password. Please check your credentials.');
                }
                throw new Error(errorData.message || 'Failed to connect to Bluesky');
            }

            const data = await response.json();
            const pdsUrl = await this._resolvePdsUrlForDid(data.did);
            this.blueskyClient = {
                did: data.did,
                handle: data.handle,
                accessJwt: data.accessJwt,
                refreshJwt: data.refreshJwt,
                email: data.email || null,
                pdsUrl
            };

            if (saveCredentials) {
                localStorage.setItem('bluesky-session', JSON.stringify({
                    handle: handle,
                    did: data.did,
                    refreshJwt: data.refreshJwt,
                    pdsUrl
                }));
            }

            this.storageMode = 'bluesky';
            return true;
        } catch (error) {
            console.error('Bluesky connection error:', error);
            throw error;
        }
    }

    // Refresh access token (OAuth or legacy Bearer)
    async refreshSession() {
        const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
        if (!session.refreshJwt) throw new Error('No refresh token available');
        try {
            if (session.oauth && localStorage.getItem('bluesky-oauth-dpop-private-jwk')) {
                await this._oauthRefresh();
            } else {
                const response = await fetch('https://bsky.social/xrpc/com.atproto.server.refreshSession', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${session.refreshJwt}` }
                });
                if (!response.ok) throw new Error('Failed to refresh session');
                const data = await response.json();
                this.blueskyClient.accessJwt = data.accessJwt;
                this.blueskyClient.refreshJwt = data.refreshJwt;
                session.refreshJwt = data.refreshJwt;
                localStorage.setItem('bluesky-session', JSON.stringify(session));
            }
            return true;
        } catch (error) {
            console.error('Session refresh error:', error);
            this.disconnectBluesky();
            throw error;
        }
    }

    // Ensure we have a valid access token
    async ensureValidToken() {
        if (!this.blueskyClient) return false;
        
        // Try to refresh if token might be expired (simple check - refresh if older than 1 hour)
        const tokenAge = Date.now() - (this.blueskyClient.tokenTimestamp || 0);
        if (tokenAge > 3600000) { // 1 hour
            try {
                await this.refreshSession();
            } catch (error) {
                console.error('Token refresh failed:', error);
                return false;
            }
        }
        return true;
    }

    /**
     * Fetch a summary of what's stored on the PDS (for "View data on PDS").
     * Uses: site.standard.document (articles), com.atproto.repo.record rkey xoxowiki-archive (artboards).
     */
    async getPDSStorageSummary() {
        if (!this.blueskyClient?.accessJwt) {
            return { error: 'Not connected to Bluesky' };
        }
        try {
            await this.ensureValidToken();
            const did = this.blueskyClient.did;
            const handle = this.blueskyClient.handle || did;

            const articleRkeys = [];
            let cursor = undefined;
            do {
                let url = `${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=site.standard.document&limit=100`;
                if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
                const res = await this._pdsFetch(url);
                if (!res.ok) break;
                const data = await res.json();
                if (data.records) {
                    data.records.forEach(r => {
                        const rkey = r.value?.path || r.rkey;
                        if (rkey) articleRkeys.push(rkey);
                    });
                }
                cursor = data.cursor || null;
            } while (cursor);

            let archiveHasRecord = false;
            let archiveItemCount = 0;
            let archiveAlbumCount = 0;
            const archiveRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=com.atproto.repo.record&rkey=xoxowiki-archive`);
            if (archiveRes.ok) {
                const archiveData = await archiveRes.json();
                const content = archiveData.value?.content;
                if (typeof content === 'string') {
                    try {
                        const payload = JSON.parse(content);
                        archiveHasRecord = true;
                        if (payload.archive && Array.isArray(payload.archive)) archiveItemCount = payload.archive.length;
                        if (payload.albums && Array.isArray(payload.albums)) archiveAlbumCount = payload.albums.length;
                    } catch (_) {}
                }
            }

            return {
                did,
                handle,
                articles: { count: articleRkeys.length, rkeys: articleRkeys },
                archive: { hasRecord: archiveHasRecord, itemCount: archiveItemCount, albumCount: archiveAlbumCount }
            };
        } catch (e) {
            console.warn('getPDSStorageSummary failed', e);
            return { error: (e.message || String(e)) };
        }
    }

    // Disconnect from Bluesky
    disconnectBluesky() {
        this.blueskyClient = null;
        this.storageMode = 'local';
        localStorage.removeItem('bluesky-session');
        localStorage.removeItem('bluesky-oauth-dpop-private-jwk');
        localStorage.removeItem('bluesky-oauth-dpop-public-jwk');
        localStorage.removeItem('bluesky-dpop-nonce');
    }

    _isOAuthSession() {
        const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
        return !!session.oauth && !!localStorage.getItem('bluesky-oauth-dpop-private-jwk');
    }

    /** PDS base URL for the current user (OAuth tokens are valid only for this resource). */
    _pdsBase() {
        const base = this.blueskyClient?.pdsUrl || 'https://bsky.social';
        return base.replace(/\/$/, '');
    }

    /** PDS base URL for repo operations only. Never use App View (api.bsky.app); use bsky.social for repo. */
    _pdsBaseForRepo() {
        const base = this._pdsBase();
        if (base === 'https://api.bsky.app' || base.startsWith('https://api.bsky.app/')) return 'https://bsky.social';
        return base;
    }

    /** Resolve PDS URL from DID document (required for OAuth: token is bound to this resource). */
    async _resolvePdsUrlForDid(did) {
        try {
            const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
            if (!res.ok) return 'https://bsky.social';
            const didDoc = await res.json();
            const services = didDoc.service;
            if (Array.isArray(services)) {
                const pds = services.find(s => s?.type === 'AtpPersonalDataServer');
                if (pds && typeof pds.serviceEndpoint === 'string') {
                    return pds.serviceEndpoint.replace(/\/$/, '');
                }
                if (services[0] && typeof services[0].serviceEndpoint === 'string') {
                    return services[0].serviceEndpoint.replace(/\/$/, '');
                }
            }
            return 'https://bsky.social';
        } catch (_) {
            return 'https://bsky.social';
        }
    }

    async _pdsFetch(url, options = {}) {
        if (!this.blueskyClient?.accessJwt) throw new Error('Not connected');
        await this.ensureValidToken();
        if (!this._isOAuthSession()) {
            const headers = { ...options.headers, 'Authorization': `Bearer ${this.blueskyClient.accessJwt}` };
            return fetch(url, { ...options, headers });
        }
        const privateJwk = localStorage.getItem('bluesky-oauth-dpop-private-jwk');
        const publicJwk = localStorage.getItem('bluesky-oauth-dpop-public-jwk');
        if (!privateJwk || !publicJwk) throw new Error('OAuth DPoP key missing');
        const privateKey = await this._importPrivateKeyJwk(JSON.parse(privateJwk));
        const publicKeyJwk = JSON.parse(publicJwk);
        const accessToken = this.blueskyClient.accessJwt;
        const accessTokenHash = this._base64urlEncode(await this._sha256Bytes(accessToken));
        let nonce = localStorage.getItem('bluesky-dpop-nonce') || '';
        const method = (options.method || 'GET').toUpperCase();
        const htu = url.split('#')[0];
        let dpopProof = await this._buildDpopProof(method, htu, nonce || undefined, privateKey, publicKeyJwk, accessTokenHash);
        let headers = {
            ...options.headers,
            'Authorization': `DPoP ${accessToken}`,
            'DPoP': dpopProof
        };
        let res = await fetch(url, { ...options, headers });
        if (res.status === 401) {
            const newNonce = res.headers.get('dpop-nonce') || res.headers.get('DPoP-Nonce');
            if (newNonce) {
                localStorage.setItem('bluesky-dpop-nonce', newNonce);
                dpopProof = await this._buildDpopProof(method, htu, newNonce, privateKey, publicKeyJwk, accessTokenHash);
                headers = { ...options.headers, 'Authorization': `DPoP ${accessToken}`, 'DPoP': dpopProof };
                res = await fetch(url, { ...options, headers });
            }
        }
        return res;
    }

    // Get all articles
    async getAllArticles() {
        if (this.storageMode === 'bluesky' && this.blueskyClient) {
            return await this.getAllArticlesFromBluesky();
        } else {
            return await this.getAllArticlesFromLocal();
        }
    }

    // Get articles from localStorage
    async getAllArticlesFromLocal() {
        return { ...this.articles };
    }

    // Get articles from Bluesky PDS (site.standard.document lexicon, same as standard.site / pckt.blog)
    async getAllArticlesFromBluesky() {
        try {
            const articles = {};
            let cursor = undefined;
            do {
                let url = `${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.listRecords?repo=${this.blueskyClient.did}&collection=site.standard.document&limit=100`;
                if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
                const response = await this._pdsFetch(url);
                if (!response.ok) return Object.keys(articles).length ? articles : {};
                const data = await response.json();
                if (data.records) {
                    data.records.forEach(record => {
                        const val = record.value;
                        const path = val?.path || record.rkey;
                        if (path) {
                            articles[path] = {
                                title: val.title || '',
                                content: val.content || ''
                            };
                        }
                    });
                }
                cursor = data.cursor || null;
            } while (cursor);
            return articles;
        } catch (error) {
            console.error('Error fetching from Bluesky:', error);
            return await this.getAllArticlesFromLocal();
        }
    }

    // Get single article
    async getArticle(key) {
        if (this.storageMode === 'bluesky' && this.blueskyClient) {
            return await this.getArticleFromBluesky(key);
        } else {
            return await this.getArticleFromLocal(key);
        }
    }

    async getArticleFromLocal(key) {
        const article = this.articles[key];
        if (article) {
            return {
                title: article.title,
                content: article.content
            };
        }
        return null;
    }

    /** AT Protocol record key for site.standard.document: slug format, 1–80 chars, [a-z0-9-] only. */
    _toValidArticleRkey(key) {
        const raw = key != null ? String(key).trim() : '';
        let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
        if (s === '' || s === '.' || s === '..') {
            s = 'article-' + (raw ? Math.abs([].reduce.call(raw, (a, c) => ((a << 5) - a) + c.charCodeAt(0), 0)).toString(36) : Date.now().toString(36));
        }
        return s || 'article';
    }

    async getArticleFromBluesky(key) {
        try {
            const rkey = this._toValidArticleRkey(key);
            const response = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=site.standard.document&rkey=${encodeURIComponent(rkey)}`);

            if (!response.ok) {
                return null;
            }

            const data = await response.json();
            const val = data.value;
            return {
                title: val.title || '',
                content: val.content || ''
            };
        } catch (error) {
            console.error('Error fetching article from Bluesky:', error);
            return null;
        }
    }

    // Save article
    async saveArticle(key, title, content) {
        // Always save locally first for offline access
        await this.saveArticleToLocal(key, title, content);

        // Then sync to Bluesky if connected
        if (this.storageMode === 'bluesky' && this.blueskyClient) {
            await this.saveArticleToBluesky(key, title, content);
        }
    }

    async saveArticleToLocal(key, title, content) {
        // Save history if article exists
        const existing = this.articles[key];
        if (existing) {
            this.history.push({
                articleKey: key,
                title: existing.title,
                content: existing.content,
                timestamp: existing.updatedAt || Date.now(),
                editedAt: Date.now()
            });
        }
        
        // Save article
        this.articles[key] = {
            title: title,
            content: content,
            updatedAt: Date.now()
        };
        
        // Persist to localStorage
        this.saveToLocalStorage();
    }

    async saveArticleToBluesky(key, title, content) {
        const rkey = this._toValidArticleRkey(key);
        const recordData = {
            $type: 'site.standard.document',
            path: rkey,
            title: title,
            content: content,
            createdAt: new Date().toISOString()
        };

        const existing = await this.getArticleFromBluesky(key);

        if (existing) {
            const putRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.putRecord`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repo: this.blueskyClient.did,
                    collection: 'site.standard.document',
                    rkey,
                    record: recordData
                })
            });
            if (!putRes.ok) {
                const err = await putRes.json().catch(() => ({}));
                throw new Error(err.message || err.error || 'Failed to save to Bluesky');
            }
        } else {
            const createRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repo: this.blueskyClient.did,
                    collection: 'site.standard.document',
                    record: recordData
                })
            });
            if (!createRes.ok) {
                const err = await createRes.json().catch(() => ({}));
                throw new Error(err.message || err.error || 'Failed to save to Bluesky');
            }
        }
    }

    // Delete article (from PDS first so it fully deletes, then local)
    async deleteArticle(key) {
        if (this.storageMode === 'bluesky' && this.blueskyClient) {
            try {
                await this.deleteArticleFromBluesky(key);
            } catch (e) {
                // Only treat as "already gone" if error clearly says record not found; otherwise do NOT delete locally
                const msg = (e && e.message) || '';
                const isRecordNotFound = /RecordNotFound|record not found|404/i.test(msg) && !/still exists|accepted but/i.test(msg);
                if (!isRecordNotFound) throw e;
            }
        }
        await this.deleteArticleFromLocal(key);
    }

    async deleteArticleFromLocal(key) {
        delete this.articles[key];
        this.history = this.history.filter(h => h.articleKey !== key);
        this.saveToLocalStorage();
    }

    async deleteArticleFromBluesky(key) {
        // Resolve PDS from DID first so token refresh (if any) and all requests use the correct server
        const resolvedPds = await this._resolvePdsUrlForDid(this.blueskyClient.did);
        this.blueskyClient.pdsUrl = resolvedPds;
        const session = JSON.parse(localStorage.getItem('bluesky-session') || '{}');
        session.pdsUrl = resolvedPds;
        localStorage.setItem('bluesky-session', JSON.stringify(session));

        await this.ensureValidToken();

        const rkey = this._toValidArticleRkey(key);
        const baseUrl = this._pdsBaseForRepo();
        const body = {
            repo: this.blueskyClient.did,
            collection: 'site.standard.document',
            rkey
        };
        const deleteUrl = `${baseUrl.replace(/\/$/, '')}/xrpc/com.atproto.repo.deleteRecord`;
        const getRecordUrl = `${baseUrl.replace(/\/$/, '')}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=site.standard.document&rkey=${encodeURIComponent(rkey)}`;

        const doDelete = () => this._pdsFetch(deleteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const verifyGone = async () => {
            const res = await this._pdsFetch(getRecordUrl);
            if (res.status === 404) return true; // record not found = gone
            if (!res.ok) return false; // 401, 5xx, etc. = don't assume gone
            const data = await res.json().catch(() => null);
            return !(data && data.value);
        };

        // Pre-warm: one getRecord before delete so first request in session (e.g. DPoP nonce) is handled here, not on delete
        try {
            const preCheck = await this._pdsFetch(getRecordUrl);
            if (preCheck.status === 404) return; // already gone
        } catch (_) {
            // proceed to delete anyway (e.g. network blip on pre-check)
        }

        let res = await doDelete();
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err.message || err.error || '';
            const errCode = err.error || '';
            const isRecordNotFound = res.status === 404 || errCode === 'RecordNotFound' || (typeof msg === 'string' && /RecordNotFound|record not found/i.test(msg) && res.status >= 400 && res.status < 500);
            if (isRecordNotFound) return;
            const pdsHost = baseUrl.replace(/^https?:\/\//, '').split('/')[0];
            throw new Error(`PDS (${pdsHost}) returned ${res.status}: ${msg || errCode || 'Could not delete record'}. rkey: ${rkey}`);
        }

        // Verify the record is gone; some PDS (e.g. discina) have replication lag so we retry with backoff
        const backoffMs = [400, 800, 1600, 3200];
        let gone = await verifyGone();
        for (const delay of backoffMs) {
            if (gone) break;
            await new Promise(r => setTimeout(r, delay));
            gone = await verifyGone();
        }
        if (!gone) {
            res = await doDelete();
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || err.error || `Delete failed (${res.status}). rkey: ${rkey}`);
            }
            gone = await verifyGone();
            for (const delay of backoffMs) {
                if (gone) break;
                await new Promise(r => setTimeout(r, delay));
                gone = await verifyGone();
            }
        }
        // Delete was accepted (2xx); if verification still fails, treat as success and rely on eventual consistency
        if (!gone) {
            console.warn(`Delete accepted for rkey ${rkey} but getRecord still sees it (PDS replication lag?). Record should disappear shortly.`, baseUrl);
        }
    }

    // Export all articles as JSON
    async exportArticles() {
        const articles = await this.getAllArticles();
        return JSON.stringify(articles, null, 2);
    }

    // Import articles from JSON
    async importArticles(jsonString) {
        const articles = JSON.parse(jsonString);
        for (const [key, article] of Object.entries(articles)) {
            await this.saveArticle(key, article.title, article.content);
        }
    }

    // Get edit history for an article
    async getArticleHistory(articleKey) {
        return this.history
            .filter(h => h.articleKey === articleKey)
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(entry => ({
                title: entry.title,
                content: entry.content,
                timestamp: entry.timestamp,
                editedAt: entry.editedAt
            }));
    }

    // Restore article from history
    async restoreFromHistory(articleKey, historyTimestamp) {
        const entry = this.history.find(h => h.articleKey === articleKey && h.timestamp === historyTimestamp);
        if (entry) {
            await this.saveArticle(articleKey, entry.title, entry.content);
            return true;
        }
        return false;
    }

    // Comments system
    addComment(articleKey, commentText, author = 'Anonymous', parentId = null) {
        if (!this.comments[articleKey]) {
            this.comments[articleKey] = [];
        }
        
        const comment = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            articleKey: articleKey,
            text: commentText,
            author: author,
            timestamp: Date.now(),
            parentId: parentId, // null for top-level comments, comment ID for replies
            replies: []
        };
        
        if (parentId) {
            // Find parent comment and add as reply
            const parent = this.findCommentById(articleKey, parentId);
            if (parent) {
                if (!parent.replies) {
                    parent.replies = [];
                }
                parent.replies.push(comment);
            } else {
                // If parent not found, add as top-level comment
                this.comments[articleKey].push(comment);
            }
        } else {
            // Top-level comment
            this.comments[articleKey].push(comment);
        }
        
        this.saveToLocalStorage();
        return comment;
    }

    findCommentById(articleKey, commentId) {
        if (!this.comments[articleKey]) return null;
        
        const findInComments = (comments) => {
            for (const comment of comments) {
                if (comment.id === commentId) return comment;
                if (comment.replies && comment.replies.length > 0) {
                    const found = findInComments(comment.replies);
                    if (found) return found;
                }
            }
            return null;
        };
        
        return findInComments(this.comments[articleKey]);
    }

    getComments(articleKey) {
        return this.comments[articleKey] || [];
    }

    // Get all articles with comments, sorted by most recent comment timestamp
    getArticlesWithComments(articles) {
        const articlesWithComments = [];
        
        for (const [key, article] of Object.entries(articles)) {
            const comments = this.getComments(key);
            if (comments.length > 0) {
                // Find the most recent comment timestamp (including replies)
                let mostRecentTimestamp = 0;
                
                const findMostRecent = (commentList) => {
                    for (const comment of commentList) {
                        if (comment.timestamp > mostRecentTimestamp) {
                            mostRecentTimestamp = comment.timestamp;
                        }
                        if (comment.replies && comment.replies.length > 0) {
                            findMostRecent(comment.replies);
                        }
                    }
                };
                
                findMostRecent(comments);
                
                articlesWithComments.push({
                    key: key,
                    title: article.title,
                    mostRecentCommentTime: mostRecentTimestamp,
                    commentCount: comments.length
                });
            }
        }
        
        // Sort by most recent comment (newest first)
        articlesWithComments.sort((a, b) => b.mostRecentCommentTime - a.mostRecentCommentTime);
        
        return articlesWithComments;
    }

    deleteComment(articleKey, commentId) {
        if (!this.comments[articleKey]) return false;
        
        const removeFromComments = (comments) => {
            for (let i = 0; i < comments.length; i++) {
                if (comments[i].id === commentId) {
                    comments.splice(i, 1);
                    return true;
                }
                if (comments[i].replies && comments[i].replies.length > 0) {
                    if (removeFromComments(comments[i].replies)) {
                        return true;
                    }
                }
            }
            return false;
        };
        
        const removed = removeFromComments(this.comments[articleKey]);
        if (removed) {
            this.saveToLocalStorage();
        }
        return removed;
    }

    // Bookmark management
    getBookmarks() {
        try {
            const stored = localStorage.getItem('xoxowiki-bookmarks');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('Error loading bookmarks:', error);
            return [];
        }
    }

    saveBookmarks(bookmarks) {
        try {
            localStorage.setItem('xoxowiki-bookmarks', JSON.stringify(bookmarks));
            if (this.blueskyClient?.accessJwt) this.syncBookmarksToBluesky().catch(() => {});
        } catch (error) {
            console.error('Error saving bookmarks:', error);
        }
    }

    addBookmark(articleKey) {
        const bookmarks = this.getBookmarks();
        if (!bookmarks.includes(articleKey)) {
            bookmarks.push(articleKey);
            this.saveBookmarks(bookmarks);
        }
    }

    removeBookmark(articleKey) {
        const bookmarks = this.getBookmarks();
        const filtered = bookmarks.filter(key => key !== articleKey);
        this.saveBookmarks(filtered);
    }

    isBookmarked(articleKey) {
        const bookmarks = this.getBookmarks();
        return bookmarks.includes(articleKey);
    }

    // Read tracking for bookmarks
    getReadArticles() {
        try {
            const stored = localStorage.getItem('xoxowiki-read-articles');
            return stored ? JSON.parse(stored) : {};
        } catch (error) {
            console.error('Error loading read articles:', error);
            return {};
        }
    }

    markAsRead(articleKey) {
        const readArticles = this.getReadArticles();
        readArticles[articleKey] = Date.now();
        try {
            localStorage.setItem('xoxowiki-read-articles', JSON.stringify(readArticles));
        } catch (error) {
            console.error('Error saving read articles:', error);
        }
    }

    isRead(articleKey) {
        const readArticles = this.getReadArticles();
        return readArticles.hasOwnProperty(articleKey);
    }

    getLastReadTime(articleKey) {
        const readArticles = this.getReadArticles();
        return readArticles[articleKey] || 0;
    }

    // Webcomic storage methods
    getWebcomicPages() {
        try {
            const stored = localStorage.getItem('xoxowiki-webcomic-pages');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('Error loading webcomic pages:', error);
            return [];
        }
    }

    saveWebcomicPages(pages) {
        try {
            localStorage.setItem('xoxowiki-webcomic-pages', JSON.stringify(pages));
            // Also sync to Bluesky if connected
            if (this.storageMode === 'bluesky' && this.blueskyClient) {
                this.saveWebcomicPagesToBluesky(pages);
            }
        } catch (error) {
            console.error('Error saving webcomic pages:', error);
        }
    }

    async saveWebcomicPagesToBluesky(pages) {
        try {
            await this.ensureValidToken();
            const recordData = {
                $type: 'com.atproto.repo.record',
                pages: pages,
                updatedAt: new Date().toISOString()
            };

            // Check if record exists
            try {
                await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=webcomic-pages`);

                // Update existing
                await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.putRecord`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        repo: this.blueskyClient.did,
                        collection: 'com.atproto.repo.record',
                        rkey: 'webcomic-pages',
                        record: recordData
                    })
                });
            } catch (e) {
                // Create new
                await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        repo: this.blueskyClient.did,
                        collection: 'com.atproto.repo.record',
                        record: recordData
                    })
                });
            }
        } catch (error) {
            console.error('Error saving webcomic pages to Bluesky:', error);
        }
    }

    async loadWebcomicPagesFromBluesky() {
        try {
            await this.ensureValidToken();
            const response = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=webcomic-pages`);

            if (response.ok) {
                const data = await response.json();
                if (data.value && data.value.pages) {
                    return data.value.pages;
                }
            }
        } catch (error) {
            console.error('Error loading webcomic pages from Bluesky:', error);
        }
        return null;
    }

    addWebcomicPage(imageData, title = '', pageNumber = null) {
        const pages = this.getWebcomicPages();
        const newPage = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            imageData: imageData, // Base64 encoded image
            title: title,
            pageNumber: pageNumber !== null ? pageNumber : pages.length + 1,
            createdAt: Date.now()
        };
        pages.push(newPage);
        // Sort by page number
        pages.sort((a, b) => a.pageNumber - b.pageNumber);
        this.saveWebcomicPages(pages);
        return newPage;
    }

    deleteWebcomicPage(pageId) {
        const pages = this.getWebcomicPages();
        const filtered = pages.filter(p => p.id !== pageId);
        // Renumber pages
        filtered.forEach((page, index) => {
            page.pageNumber = index + 1;
        });
        this.saveWebcomicPages(filtered);
    }

    // Read progress tracking (per user via Bluesky DID)
    getWebcomicReadProgress() {
        try {
            const stored = localStorage.getItem('xoxowiki-webcomic-progress');
            return stored ? JSON.parse(stored) : {};
        } catch (error) {
            console.error('Error loading webcomic progress:', error);
            return {};
        }
    }

    saveWebcomicReadProgress(progress) {
        try {
            localStorage.setItem('xoxowiki-webcomic-progress', JSON.stringify(progress));
            // Also sync to Bluesky if connected
            if (this.storageMode === 'bluesky' && this.blueskyClient) {
                this.saveWebcomicProgressToBluesky(progress);
            }
        } catch (error) {
            console.error('Error saving webcomic progress:', error);
        }
    }

    async saveWebcomicProgressToBluesky(progress) {
        try {
            await this.ensureValidToken();
            const userId = this.blueskyClient.did;
            const recordData = {
                $type: 'com.atproto.repo.record',
                userId: userId,
                progress: progress,
                updatedAt: new Date().toISOString()
            };

            const rkey = `webcomic-progress-${userId}`;
            
            try {
                await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=${rkey}`);

                // Update existing
                await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.putRecord`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        repo: this.blueskyClient.did,
                        collection: 'com.atproto.repo.record',
                        rkey: rkey,
                        record: recordData
                    })
                });
            } catch (e) {
                // Create new
                await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        repo: this.blueskyClient.did,
                        collection: 'com.atproto.repo.record',
                        record: recordData
                    })
                });
            }
        } catch (error) {
            console.error('Error saving webcomic progress to Bluesky:', error);
        }
    }

    async loadWebcomicProgressFromBluesky() {
        try {
            await this.ensureValidToken();
            const userId = this.blueskyClient.did;
            const rkey = `webcomic-progress-${userId}`;
            const response = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=${rkey}`);

            if (response.ok) {
                const data = await response.json();
                if (data.value && data.value.progress) {
                    return data.value.progress;
                }
            }
        } catch (error) {
            console.error('Error loading webcomic progress from Bluesky:', error);
        }
        return null;
    }

    markWebcomicPageAsRead(pageId) {
        const progress = this.getWebcomicReadProgress();
        const userId = this.storageMode === 'bluesky' && this.blueskyClient ? this.blueskyClient.did : 'local';
        
        if (!progress[userId]) {
            progress[userId] = [];
        }
        
        if (!progress[userId].includes(pageId)) {
            progress[userId].push(pageId);
            this.saveWebcomicReadProgress(progress);
        }
    }

    getReadWebcomicPages() {
        const progress = this.getWebcomicReadProgress();
        const userId = this.storageMode === 'bluesky' && this.blueskyClient ? this.blueskyClient.did : 'local';
        return progress[userId] || [];
    }

    isWebcomicPageRead(pageId) {
        const readPages = this.getReadWebcomicPages();
        return readPages.includes(pageId);
    }

    // ===== HABIT TRACKER =====
    getHabits() {
        try {
            const stored = localStorage.getItem('xoxowiki-habits');
            return stored ? JSON.parse(stored) : ['Workout', 'Game Dev', 'Blender', 'Drawing'];
        } catch { return ['Workout', 'Game Dev', 'Blender', 'Drawing']; }
    }

    saveHabits(habits) {
        localStorage.setItem('xoxowiki-habits', JSON.stringify(habits));
        if (this.blueskyClient?.accessJwt) this.syncHabitsToBluesky().catch(() => {});
    }

    getHabitLog() {
        try {
            const stored = localStorage.getItem('xoxowiki-habit-log');
            return stored ? JSON.parse(stored) : {};
        } catch { return {}; }
    }

    saveHabitLog(log) {
        localStorage.setItem('xoxowiki-habit-log', JSON.stringify(log));
        if (this.blueskyClient?.accessJwt) this.syncHabitLogToBluesky().catch(() => {});
    }

    toggleHabit(date, habit) {
        const log = this.getHabitLog();
        if (!log[date]) log[date] = [];
        const idx = log[date].indexOf(habit);
        if (idx === -1) log[date].push(habit);
        else log[date].splice(idx, 1);
        this.saveHabitLog(log);
        return log;
    }

    getStreak(habit) {
        const log = this.getHabitLog();
        let streak = 0;
        const today = new Date();
        for (let i = 0; i < 365; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            if (log[key]?.includes(habit)) streak++;
            else if (i > 0) break;
        }
        return streak;
    }

    // ===== DRAFTS =====
    getDraft(key) {
        try {
            const stored = localStorage.getItem('xoxowiki-drafts');
            const drafts = stored ? JSON.parse(stored) : {};
            return drafts[key] || null;
        } catch { return null; }
    }

    saveDraft(key, data) {
        try {
            const stored = localStorage.getItem('xoxowiki-drafts');
            const drafts = stored ? JSON.parse(stored) : {};
            drafts[key || '_new'] = { ...data, savedAt: new Date().toISOString() };
            localStorage.setItem('xoxowiki-drafts', JSON.stringify(drafts));
        } catch (e) { console.error('Error saving draft:', e); }
    }

    deleteDraft(key) {
        try {
            const stored = localStorage.getItem('xoxowiki-drafts');
            const drafts = stored ? JSON.parse(stored) : {};
            delete drafts[key || '_new'];
            localStorage.setItem('xoxowiki-drafts', JSON.stringify(drafts));
        } catch (e) { console.error('Error deleting draft:', e); }
    }

    getAllDrafts() {
        try {
            const stored = localStorage.getItem('xoxowiki-drafts');
            return stored ? JSON.parse(stored) : {};
        } catch { return {}; }
    }

    // ===== FILE SYSTEM ACCESS =====
    archiveDirectoryHandle = null;

    async autoRequestArchiveDirectory() {
        // Try to automatically get directory access without user interaction
        // This will only work if we have a previously granted permission
        // For new access, user interaction is required
        if (!('showDirectoryPicker' in window)) {
            return false;
        }
        
        // Check if we have a stored directory preference
        const storedDirName = localStorage.getItem('xoxowiki-archive-dir-name');
        if (!storedDirName) {
            return false; // No previous selection
        }
        
        // Try to get the directory handle (this requires user interaction on first use)
        // We can't automatically get it, but we can prepare for it
        return false;
    }

    async requestArchiveDirectory() {
        // Check if File System Access API is available (Chrome/Edge)
        if ('showDirectoryPicker' in window) {
            try {
                // Try to get the directory containing the current HTML file
                let startIn = 'documents';
                
                // If running from file:// protocol, try to suggest current directory
                if (window.location.protocol === 'file:') {
                    startIn = 'documents';
                }
                
                this.archiveDirectoryHandle = await window.showDirectoryPicker({
                    mode: 'readwrite',
                    startIn: startIn
                });
                
                // Store the directory name for reference (can't store the handle itself)
                try {
                    const dirName = this.archiveDirectoryHandle.name;
                    localStorage.setItem('xoxowiki-archive-dir-name', dirName);
                } catch (e) {
                    // Directory handle might not have name property in all browsers
                }
                
                return true;
            } catch (error) {
                if (error.name === 'AbortError') {
                    return false; // User cancelled
                }
                throw error;
            }
        } else {
            // For browsers without File System Access API (Firefox/Safari)
            // We'll use a file input with directory selection simulation
            return await this.requestArchiveDirectoryFallback();
        }
    }
    
    async requestArchiveDirectoryFallback() {
        // For browsers without File System Access API, we can't actually select a folder for writing
        // But we can use showSaveFilePicker for each file to let user choose location
        // Just mark that we're using per-file selection mode
        localStorage.setItem('xoxowiki-uses-per-file-picker', 'true');
        localStorage.setItem('xoxowiki-archive-dir-name', 'Per-file selection');
        this.archiveDirectoryHandle = null;
        return true;
    }
    
    async requestCurrentDirectory() {
        // Try to get access to the directory containing the HTML file
        // This is a best-effort attempt - browsers require user permission
        if (!('showDirectoryPicker' in window)) {
            // Browser doesn't support File System Access API
            // Will use IndexedDB + download fallback
            return false;
        }
        
        try {
            // For file:// URLs, we can't directly access the parent directory
            // But we can try to use a file picker that suggests the current location
            // The browser will handle suggesting the appropriate directory
            
            // Check if we're running from a file:// URL
            if (window.location.protocol === 'file:') {
                // Try to get a file handle first, then get its directory
                // This is a workaround to get directory access
                try {
                    // Request a file picker, then get its directory
                    // Actually, we can't do this - we need directory picker
                    // So we'll just use the directory picker with a helpful message
                    const handle = await window.showDirectoryPicker({
                        mode: 'readwrite',
                        // Browser will suggest appropriate location
                    });
                    
                    this.archiveDirectoryHandle = handle;
                    return true;
                } catch (e) {
                    return false;
                }
            } else {
                // For http/https, we can't access local file system automatically
                return false;
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                return false;
            }
            return false;
        }
    }

    async saveFileToDisk(filename, data, isBase64 = false) {
        // Check if File System Access API is available (Chrome/Edge)
        if ('showDirectoryPicker' in window) {
            return await this.saveFileWithFileSystemAPI(filename, data, isBase64);
        } else {
            // Fallback for other browsers: use download API
            return await this.saveFileWithDownloadAPI(filename, data, isBase64);
        }
    }

    async saveFileWithFileSystemAPI(filename, data, isBase64 = false) {
        if (!this.archiveDirectoryHandle) {
            // Try to automatically get directory access
            // First, try to get the current directory if we're in a file:// context
            let granted = false;
            
            if (window.location.protocol === 'file:') {
                // For file:// URLs, try to request the current directory
                // This will prompt the user but only once
                granted = await this.requestCurrentDirectory();
            }
            
            // If that didn't work, use the standard directory picker
            if (!granted) {
                granted = await this.requestArchiveDirectory();
            }
            
            if (!granted) {
                throw new Error('Directory access not granted. Please select an archive folder.');
            }
        }

        try {
            // Create archive subdirectory if it doesn't exist
            let archiveDirHandle;
            try {
                archiveDirHandle = await this.archiveDirectoryHandle.getDirectoryHandle('archive', { create: true });
            } catch (error) {
                throw new Error('Failed to create archive directory');
            }

            // Get or create file handle
            const fileHandle = await archiveDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            
            if (isBase64) {
                // Convert base64 to blob
                const base64Data = data.split(',')[1] || data;
                const binaryString = atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                await writable.write(bytes);
            } else {
                await writable.write(data);
            }
            
            await writable.close();
            return true;
        } catch (error) {
            console.error('Error saving file to disk:', error);
            throw error;
        }
    }

    async saveFileWithDownloadAPI(filename, data, isBase64 = false) {
        // Fallback for browsers without File System Access API
        // Use showSaveFilePicker to let user choose where to save each file
        try {
            // Convert to blob
            let blob;
            if (isBase64) {
                const base64Data = data.split(',')[1] || data;
                const mimeMatch = data.match(/data:([^;]+);/);
                const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
                const binaryString = atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                blob = new Blob([bytes], { type: mimeType });
            } else {
                blob = new Blob([data]);
            }
            
            // Store in IndexedDB for later retrieval
            await this.storeFileInIndexedDB(filename, blob);
            
            // Try to use showSaveFilePicker to let user choose location
            // This works in Chrome/Edge, and prompts user to choose where to save
            if ('showSaveFilePicker' in window) {
                try {
                    // Determine file types based on extension
                    const ext = filename.split('.').pop().toLowerCase();
                    let types = [];
                    
                    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
                        types = [{
                            description: 'Image files',
                            accept: { 'image/*': [`.${ext}`] }
                        }];
                    } else if (['mp4', 'webm', 'mov'].includes(ext)) {
                        types = [{
                            description: 'Video files',
                            accept: { 'video/*': [`.${ext}`] }
                        }];
                    }
                    
                    // Suggest saving to an archive subfolder
                    const suggestedName = `archive/${filename}`;
                    
                    const fileHandle = await window.showSaveFilePicker({
                        suggestedName: suggestedName,
                        types: types.length > 0 ? types : undefined
                    });
                    
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    return true;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        // User cancelled - file is still in IndexedDB
                        return true;
                    }
                    console.warn('showSaveFilePicker failed, falling back to download:', error);
                    // Fall through to download
                }
            }
            
            // Fallback: trigger download to Downloads folder
            // This happens if showSaveFilePicker is not available (Firefox/Safari)
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            return true;
        } catch (error) {
            console.error('Error saving file with download API:', error);
            throw error;
        }
    }

    async storeFileInIndexedDB(filename, blob) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('xoxowiki-files', 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction(['files'], 'readwrite');
                const store = transaction.objectStore('files');
                const fileRequest = store.put({ filename, blob, timestamp: Date.now() });
                fileRequest.onsuccess = () => resolve();
                fileRequest.onerror = () => reject(fileRequest.error);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'filename' });
                }
            };
        });
    }

    async getFileFromIndexedDB(filename) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('xoxowiki-files', 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction(['files'], 'readonly');
                const store = transaction.objectStore('files');
                const fileRequest = store.get(filename);
                fileRequest.onsuccess = () => {
                    const result = fileRequest.result;
                    resolve(result ? result.blob : null);
                };
                fileRequest.onerror = () => reject(fileRequest.error);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'filename' });
                }
            };
        });
    }

    async getFileFromDisk(filename) {
        // Try disk first if user previously selected an archive folder
        if ('showDirectoryPicker' in window && this.archiveDirectoryHandle) {
            try {
                const archiveDirHandle = await this.archiveDirectoryHandle.getDirectoryHandle('archive');
                const fileHandle = await archiveDirHandle.getFileHandle(filename);
                const file = await fileHandle.getFile();
                return file;
            } catch (error) {
                // File not on disk (e.g. uploads stored only in IndexedDB) – fall through to IndexedDB
            }
        }
        // Use IndexedDB (uploads are stored here only – no download or disk copy)
        try {
            const blob = await this.getFileFromIndexedDB(filename);
            if (blob) {
                return new File([blob], filename, { type: blob.type });
            }
            return null;
        } catch (error) {
            console.error('Error reading file from IndexedDB:', error);
            return null;
        }
    }

    async deleteFileFromDisk(filename) {
        if ('showDirectoryPicker' in window && this.archiveDirectoryHandle) {
            try {
                const archiveDirHandle = await this.archiveDirectoryHandle.getDirectoryHandle('archive');
                await archiveDirHandle.removeEntry(filename);
                return true;
            } catch (error) {
                // File may exist only in IndexedDB (uploads) – fall through
            }
        }
        try {
            const request = indexedDB.open('xoxowiki-files', 1);
            return new Promise((resolve) => {
                request.onsuccess = () => {
                    const db = request.result;
                    const transaction = db.transaction(['files'], 'readwrite');
                    const store = transaction.objectStore('files');
                    const deleteRequest = store.delete(filename);
                    deleteRequest.onsuccess = () => resolve(true);
                    deleteRequest.onerror = () => resolve(false);
                };
                request.onerror = () => resolve(false);
            });
        } catch (error) {
            console.error('Error deleting file from IndexedDB:', error);
            return false;
        }
    }

    // ===== AT PROTOCOL BLOB (images/videos on Bluesky PDS) =====
    _blobExtensionFromMime(mimeType) {
        if (!mimeType || typeof mimeType !== 'string') return 'bin';
        const m = mimeType.split('/')[1] || '';
        if (m === 'jpeg' || m === 'jpg' || m === 'png' || m === 'gif' || m === 'webp') return m === 'jpeg' ? 'jpg' : m;
        if (mimeType.startsWith('video/')) return m || 'mp4';
        return m || 'bin';
    }

    async uploadBlobToAtProtocol(blob, mimeType) {
        if (!this.blueskyClient || !this.blueskyClient.accessJwt) {
            throw new Error('Connect to Bluesky first to upload media to the AT Protocol.');
        }
        await this.ensureValidToken();
        const ext = this._blobExtensionFromMime(mimeType);
        const formData = new FormData();
        formData.append('file', blob, `media.${ext}`);
        const response = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.uploadBlob`, {
            method: 'POST',
            body: formData
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.message || 'Failed to upload media to AT Protocol');
        }
        const data = await response.json();
        return data.blob; // { $type, ref: { $link: "cid:..." }, mimeType, size }
    }

    getAtProtocolBlobUrl(cidOrRef, did = null) {
        const cid = typeof cidOrRef === 'string'
            ? (cidOrRef.startsWith('cid:') ? cidOrRef : `cid:${cidOrRef}`)
            : (cidOrRef?.$link || cidOrRef?.cid || '');
        const repoDid = did || this.blueskyClient?.did;
        if (!cid || !repoDid) return null;
        const cidOnly = String(cid).replace(/^cid:/, '');
        const base = (repoDid === this.blueskyClient?.did) ? this._pdsBaseForRepo() : 'https://bsky.social';
        return `${base}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(repoDid)}&cid=${encodeURIComponent(cidOnly)}`;
    }

    // Parse a bsky.app post URL to get handle and rkey. Returns null if not a valid post URL.
    _parseBskyPostUrl(url) {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();
        // https://bsky.app/profile/handle/post/rkey or https://bsky.app/profile/handle.bsky.social/post/rkey
        const m = trimmed.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i);
        if (!m) return null;
        return { handle: m[1], rkey: m[2], url: trimmed };
    }

    // Fetch a single post by bsky.app URL and return archive-ready items (images/videos with imageUrl, source).
    async fetchPostMediaFromUrl(bskyAppUrl) {
        const parsed = this._parseBskyPostUrl(bskyAppUrl);
        if (!parsed) return { items: [], error: 'Not a valid Bluesky post URL (e.g. https://bsky.app/profile/handle.bsky.social/post/...)' };
        const { handle, rkey, url: sourceUrl } = parsed;
        let did;
        try {
            const res = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
            if (!res.ok) throw new Error('Could not resolve handle');
            const data = await res.json();
            did = data.did;
        } catch (e) {
            return { items: [], error: 'Could not resolve Bluesky handle: ' + (e.message || 'Unknown error') };
        }
        const atUri = `at://${did}/app.bsky.feed.post/${rkey}`;
        let posts;
        try {
            const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`);
            if (!res.ok) throw new Error('Failed to load post');
            const data = await res.json();
            posts = data.posts || [];
        } catch (e) {
            return { items: [], error: 'Could not load post: ' + (e.message || 'Unknown error') };
        }
        const postView = posts[0];
        if (!postView) return { items: [], error: 'Post not found or unavailable' };
        const author = postView.author || {};
        const didAuthor = author.did || did;
        const handleDisplay = author.displayName || author.handle || handle;
        const embed = postView.embed;
        const items = [];
        const postText = (postView.record?.text || '').trim();
        if (embed) {
            // App View returns images in view format: { thumb: url, fullsize: url, alt } (URI strings)
            const imagesList = embed.images && Array.isArray(embed.images) ? embed.images : (embed.media && embed.media.images && Array.isArray(embed.media.images) ? embed.media.images : null);
            if (imagesList) {
                for (let i = 0; i < imagesList.length; i++) {
                    const img = imagesList[i];
                    let imageUrl = null;
                    if (typeof img?.fullsize === 'string' && img.fullsize.startsWith('http')) {
                        imageUrl = img.fullsize;
                    } else if (typeof img?.thumb === 'string' && img.thumb.startsWith('http')) {
                        imageUrl = img.thumb;
                    } else {
                        const ref = img?.image?.ref || img?.ref;
                        const cid = ref?.$link || ref;
                        if (cid) imageUrl = this.getAtProtocolBlobUrl(cid, didAuthor);
                    }
                    if (imageUrl) {
                        items.push({
                            type: 'image',
                            imageUrl,
                            name: imagesList.length > 1 ? `Image ${i + 1} from @${handleDisplay}` : `Image from @${handleDisplay}`,
                            source: sourceUrl,
                            postText: postText || undefined,
                            authorHandle: author.handle,
                            authorDid: author.did,
                            authorDisplayName: author.displayName,
                            alt: img.alt || ''
                        });
                    }
                }
            }
            // Video: can be embed.media (recordWithMedia) or direct embed (video#view: embed.playlist)
            const media = embed.media;
            const directPlaylist = typeof embed.playlist === 'string' && embed.playlist.startsWith('http') ? embed.playlist : null;
            const directThumb = typeof embed.thumbnail === 'string' && embed.thumbnail.startsWith('http') ? embed.thumbnail : null;
            const directCid = embed.cid;
            // Prefer blob URL over playlist: playlist is often HLS (.m3u8) which only Safari plays natively; blob URL returns raw MP4 for all browsers
            const directBlobUrl = directCid ? this.getAtProtocolBlobUrl(directCid, didAuthor) : null;
            const videoFromDirect = directBlobUrl || directPlaylist;

            if (videoFromDirect) {
                const thumbUrl = directThumb || null;
                let imageUrl = thumbUrl;
                if (!imageUrl && embed.thumbnail && typeof embed.thumbnail === 'object') {
                    const tr = embed.thumbnail?.ref || embed.thumbnail;
                    const tc = tr?.$link || tr;
                    if (tc) imageUrl = this.getAtProtocolBlobUrl(tc, didAuthor);
                }
                if (!imageUrl && directCid) imageUrl = this.getAtProtocolBlobUrl(directCid, didAuthor);
                items.push({
                    type: 'video',
                    imageUrl: imageUrl || videoFromDirect,
                    videoUrl: videoFromDirect,
                    name: `Video from @${handleDisplay}`,
                    source: sourceUrl,
                    postText: postText || undefined,
                    authorHandle: author.handle,
                    authorDid: author.did,
                    authorDisplayName: author.displayName,
                    alt: embed.alt || ''
                });
            } else if (media) {
                const playlistUrl = typeof media.playlist === 'string' && media.playlist.startsWith('http') ? media.playlist : null;
                const thumbUrl = typeof media.thumbnail === 'string' && media.thumbnail.startsWith('http') ? media.thumbnail : null;
                const ref = media.image?.ref || media.image;
                const cid = ref?.$link || ref;
                const videoUrlFromRef = cid ? this.getAtProtocolBlobUrl(cid, didAuthor) : null;
                // Prefer blob URL over playlist so we get raw MP4 (playlist is often HLS, which Chrome/Firefox don't play in <video>)
                const finalVideoUrl = videoUrlFromRef || playlistUrl;
                if (finalVideoUrl) {
                    let imageUrl = thumbUrl || null;
                    if (!imageUrl && media.thumbnail && typeof media.thumbnail === 'object') {
                        const tr = media.thumbnail?.ref || media.thumbnail;
                        const tc = tr?.$link || tr;
                        if (tc) imageUrl = this.getAtProtocolBlobUrl(tc, didAuthor);
                    }
                    if (!imageUrl && cid) imageUrl = this.getAtProtocolBlobUrl(cid, didAuthor);
                    items.push({
                        type: 'video',
                        imageUrl: imageUrl || finalVideoUrl,
                        videoUrl: finalVideoUrl,
                        name: `Video from @${handleDisplay}`,
                        source: sourceUrl,
                        postText: postText || undefined,
                        authorHandle: author.handle,
                        authorDid: author.did,
                        authorDisplayName: author.displayName,
                        alt: media.alt || ''
                    });
                } else if (media.image) {
                    const ref2 = media.image.ref || media.image;
                    const cid2 = ref2?.$link || ref2;
                    if (cid2) {
                        const videoUrl = this.getAtProtocolBlobUrl(cid2, didAuthor);
                        const thumbRef = media.thumbnail && (media.thumbnail.ref || media.thumbnail);
                        const imageUrl = thumbRef ? this.getAtProtocolBlobUrl(thumbRef.$link || thumbRef, didAuthor) : videoUrl;
                        items.push({
                            type: 'video',
                            imageUrl,
                            videoUrl,
                            name: `Video from @${handleDisplay}`,
                            source: sourceUrl,
                            postText: postText || undefined,
                            authorHandle: author.handle,
                            authorDid: author.did,
                            authorDisplayName: author.displayName,
                            alt: ''
                        });
                    }
                }
            }
        }
        if (items.length === 0) return { items: [], error: 'No images or videos found in this post' };
        return { items };
    }

    // Parse feed array (getFeed or getTimeline response) into browse items with images/videos.
    // App View returns view format (thumb/fullsize URLs); also support record format (image.ref).
    // Filters out own posts (only shows posts from people you follow).
    _parseFeedToBrowseItems(feed) {
        const items = [];
        const list = feed || [];
        const myDid = this.blueskyClient?.did;
        let ownPostsSkipped = 0;
        let postsWithoutMedia = 0;
        let postsProcessed = 0;
        console.log('Parsing feed items:', { totalFeedItems: list.length, myDid });
        for (const item of list) {
            const post = item.post;
            const author = post?.author;
            const did = author?.did;
            const handle = author?.handle || 'unknown';
            const postText = (post?.record?.text || '').trim();
            const postUri = post?.uri || '';
            const embed = post?.embed;
            const authorDisplayName = author?.displayName;
            postsProcessed++;
            if (!embed || !did) {
                postsWithoutMedia++;
                continue;
            }
            // Skip own posts - browse should show posts from people you follow, not your own
            if (myDid && did === myDid) {
                ownPostsSkipped++;
                console.log('Skipping own post:', { handle, did, myDid, match: did === myDid });
                continue;
            }
            console.log('Processing post from:', { handle, did, myDid, isOwn: myDid && did === myDid });
            const imagesList = embed.images && Array.isArray(embed.images) ? embed.images : (embed.media && embed.media.images && Array.isArray(embed.media.images) ? embed.media.images : null);
            if (imagesList) {
                for (let i = 0; i < imagesList.length; i++) {
                    const img = imagesList[i];
                    let imageUrl = null;
                    if (typeof img?.fullsize === 'string' && img.fullsize.startsWith('http')) {
                        imageUrl = img.fullsize;
                    } else if (typeof img?.thumb === 'string' && img.thumb.startsWith('http')) {
                        imageUrl = img.thumb;
                    } else {
                        const ref = img?.image?.ref || img?.ref;
                        const cid = ref?.$link || ref;
                        if (cid) imageUrl = this.getAtProtocolBlobUrl(cid, did);
                    }
                    if (imageUrl) {
                        items.push({
                            type: 'image',
                            imageUrl,
                            authorHandle: handle,
                            authorDid: did,
                            authorDisplayName: authorDisplayName,
                            postUri,
                            textSnippet: postText,
                            postText: postText,
                            alt: img.alt || ''
                        });
                    }
                }
            }
            const media = embed.media;
            const directPlaylist = typeof embed.playlist === 'string' && embed.playlist.startsWith('http') ? embed.playlist : null;
            const directThumb = typeof embed.thumbnail === 'string' && embed.thumbnail.startsWith('http') ? embed.thumbnail : null;
            const directCid = embed.cid || (embed.video && (embed.video.ref || embed.video.$link));
            if (directPlaylist || directCid) {
                const videoUrl = directCid ? this.getAtProtocolBlobUrl(directCid, did) : directPlaylist;
                let thumbUrl = directThumb;
                if (!thumbUrl && embed.thumbnail && typeof embed.thumbnail === 'object') {
                    const tr = embed.thumbnail?.ref || embed.thumbnail;
                    thumbUrl = tr ? this.getAtProtocolBlobUrl(tr?.$link || tr, did) : null;
                }
                if (videoUrl) {
                    items.push({
                        type: 'video',
                        imageUrl: thumbUrl || videoUrl,
                        videoUrl,
                        authorHandle: handle,
                        authorDid: did,
                        authorDisplayName: authorDisplayName,
                        postUri,
                        textSnippet: postText,
                        postText: postText,
                        alt: embed.alt || ''
                    });
                }
            }
            if (media) {
                let videoUrl = null;
                let thumbUrl = null;
                if (typeof media.playlist === 'string' && media.playlist.startsWith('http')) videoUrl = media.playlist;
                if (typeof media.thumbnail === 'string' && media.thumbnail.startsWith('http')) thumbUrl = media.thumbnail;
                else if (media.thumbnail && (media.thumbnail.ref || media.thumbnail.$link)) {
                    const tr = media.thumbnail.ref || media.thumbnail;
                    thumbUrl = this.getAtProtocolBlobUrl(tr?.$link || tr, did);
                }
                if (!videoUrl && media.image) {
                    const ref = media.image?.ref || media.image;
                    const cid = ref?.$link || ref;
                    if (cid) videoUrl = this.getAtProtocolBlobUrl(cid, did);
                }
                if (videoUrl) {
                    items.push({
                        type: 'video',
                        imageUrl: thumbUrl || videoUrl,
                        videoUrl,
                        authorHandle: handle,
                        authorDid: did,
                        authorDisplayName: authorDisplayName,
                        postUri,
                        textSnippet: postText,
                        postText: postText,
                        alt: media.alt || ''
                    });
                }
            } else if (embed.media && embed.media.image) {
                const ref = embed.media.image.ref || embed.media.image;
                const cid = ref?.$link || ref;
                if (cid) {
                    const imageUrl = this.getAtProtocolBlobUrl(cid, did);
                    if (imageUrl) {
                        items.push({
                            type: 'video',
                            imageUrl: embed.media.thumbnail ? this.getAtProtocolBlobUrl(embed.media.thumbnail.ref || embed.media.thumbnail, did) : imageUrl,
                            videoUrl: imageUrl,
                            authorHandle: handle,
                            authorDid: did,
                            authorDisplayName: authorDisplayName,
                            postUri,
                            textSnippet: postText,
                            postText: postText,
                            alt: ''
                        });
                    }
                }
            }
        }
        console.log('Feed parsing complete:', { 
            totalFeedItems: list.length, 
            itemsFound: items.length, 
            ownPostsSkipped, 
            postsWithoutMedia, 
            postsProcessed 
        });
        return items;
    }

    // Fetch feed from AT Protocol. When logged in, uses your Bluesky timeline; otherwise public "what's hot".
    // getTimeline is an App View API — use api.bsky.app first so custom PDS users still get a feed.
    async fetchBrowseFeed(cursor = null, limit = 30) {
        if (this.blueskyClient?.accessJwt) {
            const buildUrl = (base) => {
                let u = `${base}/xrpc/app.bsky.feed.getTimeline?limit=${limit}`;
                if (cursor) u += `&cursor=${encodeURIComponent(cursor)}`;
                return u;
            };
            // Prefer App View for getTimeline (custom PDS often doesn't implement it or returns empty).
            let response = await this._pdsFetch(buildUrl('https://api.bsky.app'));
            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                const errMsg = errBody.message || errBody.error || `HTTP ${response.status}`;
                if (this._pdsBase() !== 'https://api.bsky.app') {
                    try {
                        response = await this._pdsFetch(buildUrl(this._pdsBase()));
                        if (response.ok) {
                            const data = await response.json();
                            const items = this._parseFeedToBrowseItems(data.feed || []);
                            return { items, cursor: data.cursor || null };
                        }
                    } catch (_) {}
                }
                throw new Error(errMsg);
            }
            const data = await response.json();
            console.log('Feed response:', { 
                feedLength: data.feed?.length || 0, 
                hasCursor: !!data.cursor,
                samplePost: data.feed?.[0] ? {
                    author: data.feed[0].post?.author?.handle,
                    hasEmbed: !!data.feed[0].post?.embed
                } : null
            });
            const items = this._parseFeedToBrowseItems(data.feed || []);
            return { items, cursor: data.cursor || null };
        }
        const feedUri = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
        let url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feedUri)}&limit=${limit}`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to load feed');
        const data = await response.json();
        const items = this._parseFeedToBrowseItems(data.feed || []);
        return { items, cursor: data.cursor || null };
    }

    /** Fetch a single Bluesky post by at-uri. Returns { uri, cid, record, author, embed } or null. */
    async getBlueskyPost(uri) {
        if (!uri || !uri.startsWith('at://')) return null;
        try {
            const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            const post = (data.posts || [])[0];
            if (!post) return null;
            return {
                uri: post.uri,
                cid: post.cid,
                record: post.record,
                author: post.author,
                embed: post.embed
            };
        } catch (e) {
            console.warn('getBlueskyPost failed:', e);
            return null;
        }
    }

    /** Fetch post thread with replies. Returns thread data with replies nested. */
    async getBlueskyPostThread(uri) {
        if (!uri || !uri.startsWith('at://')) return null;
        try {
            const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            return data.thread || null;
        } catch (e) {
            console.warn('getBlueskyPostThread failed:', e);
            return null;
        }
    }

    /** Post a reply to a Bluesky post. parentUri is the at-uri of the post to reply to. */
    async postBlueskyReply(parentUri, text) {
        if (!this.blueskyClient?.accessJwt) throw new Error('Not connected to Bluesky');
        const trimmed = (text || '').trim();
        if (!trimmed) throw new Error('Reply text is required');
        await this.ensureValidToken();
        const parent = await this.getBlueskyPost(parentUri);
        if (!parent || !parent.uri || !parent.cid) throw new Error('Could not load the post to reply to');
        const ref = { uri: parent.uri, cid: parent.cid };
        const record = {
            $type: 'app.bsky.feed.post',
            text: trimmed,
            createdAt: new Date().toISOString(),
            reply: { parent: ref, root: ref }
        };
        const res = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo: this.blueskyClient.did,
                collection: 'app.bsky.feed.post',
                record
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || err.error || 'Failed to post reply');
        }
        const data = await res.json();
        return { uri: data.uri, cid: data.cid };
    }

    // Fetch a getBlob URL with auth and return an object URL so <img>/<video> can display it (no auth in browser requests)
    static _blobObjectUrlCache = new Map();
    async _fetchBlobUrlWithAuth(url) {
        if (!url || typeof url !== 'string' || !url.includes('getBlob') && !url.includes('sync.getBlob')) return url;
        if (!this.blueskyClient?.accessJwt) return url;
        const cached = WikiStorage._blobObjectUrlCache.get(url);
        if (cached) return cached;
        try {
            await this.ensureValidToken();
            const res = await this._pdsFetch(url);
            if (!res.ok) return url;
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            WikiStorage._blobObjectUrlCache.set(url, objectUrl);
            return objectUrl;
        } catch (e) {
            console.warn('Failed to fetch blob with auth:', e);
            return url;
        }
    }

    // Get image data URL - AT Protocol URL, imageUrl, disk/IndexedDB, or imageData. Resolves getBlob URLs with auth when logged in.
    async getArchiveItemImageData(item) {
        let imageUrl = null;
        if (item.imageUrl) {
            imageUrl = item.imageUrl;
        } else if (item.atBlobRef) {
            const ref = item.atBlobRef;
            const cid = (typeof ref === 'string' ? ref : ref?.$link ?? ref?.cid) || '';
            const did = item.atBlobRefDid ?? this.blueskyClient?.did;
            if (cid && did) {
                const cidOnly = typeof cid === 'string' ? cid.replace(/^cid:/, '') : String(cid);
                const base = (did === this.blueskyClient?.did) ? this._pdsBaseForRepo() : 'https://bsky.social';
                imageUrl = `${base}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cidOnly)}`;
            }
        }
        if (imageUrl) {
            if (imageUrl.includes('getBlob') && this.blueskyClient?.accessJwt) {
                return await this._fetchBlobUrlWithAuth(imageUrl);
            }
            return imageUrl;
        }
        if (item.filename) {
            try {
                const file = await this.getFileFromDisk(item.filename);
                if (file) {
                    return new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = (e) => resolve(e.target.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                    });
                }
            } catch (error) {
                console.warn('Failed to load file, trying fallback:', error);
            }
        }
        return item.imageData || null;
    }

    // Video URL for archive item; resolves getBlob URLs with auth when logged in so video embeds work after re-login.
    async getArchiveItemVideoUrl(item) {
        const url = item.videoUrl || null;
        if (!url) return null;
        if (url.includes('getBlob') && this.blueskyClient?.accessJwt) {
            return await this._fetchBlobUrlWithAuth(url);
        }
        return url;
    }

    // ===== STORAGE MANAGEMENT =====
    getStorageUsage() {
        let totalSize = 0;
        const usage = {};
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('xoxowiki-')) {
                const value = localStorage.getItem(key);
                const size = new Blob([value]).size;
                totalSize += size;
                usage[key] = {
                    size: size,
                    sizeMB: (size / (1024 * 1024)).toFixed(2)
                };
            }
        }
        
        return {
            total: totalSize,
            totalMB: (totalSize / (1024 * 1024)).toFixed(2),
            breakdown: usage
        };
    }
    
    getArchiveSize() {
        try {
            const stored = localStorage.getItem('xoxowiki-archive');
            if (!stored) return { size: 0, sizeMB: '0.00', itemCount: 0 };
            const size = new Blob([stored]).size;
            const archive = JSON.parse(stored);
            return {
                size: size,
                sizeMB: (size / (1024 * 1024)).toFixed(2),
                itemCount: archive.length
            };
        } catch {
            return { size: 0, sizeMB: '0.00', itemCount: 0 };
        }
    }
    
    deleteOldestArchiveItems(count = 10) {
        const archive = this.getArchive();
        if (archive.length <= count) {
            // Don't delete everything, keep at least 5 items
            const keepCount = Math.max(5, archive.length - count);
            const toKeep = archive.slice(0, keepCount);
            localStorage.setItem('xoxowiki-archive', JSON.stringify(toKeep));
            return archive.length - toKeep.length;
        }
        const toKeep = archive.slice(0, archive.length - count);
        localStorage.setItem('xoxowiki-archive', JSON.stringify(toKeep));
        return count;
    }

    // ===== ARCHIVE (Images) =====
    getArchive() {
        try {
            const stored = localStorage.getItem('xoxowiki-archive');
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    }

    async saveArchiveItem(item) {
        try {
            const hasUrl = item.imageUrl && item.imageUrl.startsWith('http');
            const hasData = item.imageData;
            if (!hasUrl && !hasData) {
                throw new Error('Provide an image URL or image data.');
            }
            
            item.id = item.id || (Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9));
            item.createdAt = item.createdAt || new Date().toISOString();
            
            // Option A: External URL (AT Protocol / Bluesky CDN / any URL)
            // Always store the URLs so they sync to PDS and embed when you log in. Optionally try to copy blobs to your PDS.
            if (hasUrl) {
                const metadata = {
                    id: item.id,
                    name: item.name || 'Image',
                    type: item.type || 'image',
                    source: item.source,
                    createdAt: item.createdAt,
                    imageUrl: item.imageUrl,
                    videoUrl: item.videoUrl || null,
                    albumIds: item.albumIds || [],
                    articleIds: item.articleIds || [],
                    habitDays: item.habitDays || [],
                    assignmentType: item.assignmentType || 'albums'
                };
                if (item.authorHandle) metadata.authorHandle = item.authorHandle;
                if (item.authorDid) metadata.authorDid = item.authorDid;
                if (item.authorDisplayName) metadata.authorDisplayName = item.authorDisplayName;
                const pt = item.postText ?? item.textSnippet;
                if (pt) metadata.postText = pt;
                if (item.userNote) metadata.userNote = item.userNote;

                if (this.blueskyClient && this.blueskyClient.accessJwt) {
                    try {
                        await this.ensureValidToken();
                        const imageRes = await fetch(item.imageUrl, { mode: 'cors' });
                        if (imageRes.ok) {
                            const imageBlob = await imageRes.blob();
                            const imageMime = imageBlob.type || 'image/jpeg';
                            const imageBlobResult = await this.uploadBlobToAtProtocol(imageBlob, imageMime);
                            metadata.atBlobRef = imageBlobResult.ref;
                            metadata.atBlobRefDid = this.blueskyClient.did;
                            metadata.imageUrl = this.getAtProtocolBlobUrl(imageBlobResult.ref?.$link || imageBlobResult.ref, this.blueskyClient.did);
                        }
                        if (item.type === 'video' && item.videoUrl && typeof item.videoUrl === 'string' && item.videoUrl.startsWith('http')) {
                            const videoRes = await fetch(item.videoUrl, { mode: 'cors' });
                            if (videoRes.ok) {
                                const videoBlob = await videoRes.blob();
                                const videoMime = videoBlob.type || 'video/mp4';
                                const videoBlobResult = await this.uploadBlobToAtProtocol(videoBlob, videoMime);
                                metadata.videoUrl = this.getAtProtocolBlobUrl(videoBlobResult.ref?.$link || videoBlobResult.ref, this.blueskyClient.did);
                            }
                        }
                    } catch (e) {
                        console.warn('Copy media to PDS failed; URLs are stored and will sync:', e);
                    }
                }

                const archive = this.getArchive();
                archive.unshift(metadata);
                localStorage.setItem('xoxowiki-archive', JSON.stringify(archive));
                if (this.blueskyClient?.accessJwt) {
                    try { await this._createArtboardItemOnPDS(metadata); } catch (e) { console.warn('Artboard lexicon create failed:', e); }
                }
                await this.syncArchiveToBlueskyIfConnected();
                return item;
            }
            
            // Option B: Upload to AT Protocol when Bluesky is connected (for GitHub Pages – images live on Bluesky)
            if (hasData && this.blueskyClient && this.blueskyClient.accessJwt) {
                let blob;
                let mimeType = 'image/jpeg';
                if (item.imageData.startsWith('data:')) {
                    const match = item.imageData.match(/data:([^;]+);base64,(.+)/);
                    if (match) {
                        mimeType = match[1];
                        const bin = atob(match[2]);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                        blob = new Blob([bytes], { type: mimeType });
                    }
                }
                if (blob) {
                    const blobResult = await this.uploadBlobToAtProtocol(blob, mimeType);
                    const blobUrl = this.getAtProtocolBlobUrl(blobResult.ref?.$link || blobResult.ref, this.blueskyClient.did);
                    const archive = this.getArchive();
                    const metadata = {
                        id: item.id,
                        name: item.name,
                        type: item.type || 'image',
                        source: item.source,
                        createdAt: item.createdAt,
                        atBlobRef: blobResult.ref,
                        atBlobRefDid: this.blueskyClient.did,
                        albumIds: item.albumIds || [],
                        articleIds: item.articleIds || [],
                        habitDays: item.habitDays || [],
                        assignmentType: item.assignmentType || 'albums'
                    };
                    if (item.type === 'video' && blobUrl) metadata.videoUrl = blobUrl;
                    if (item.authorHandle) metadata.authorHandle = item.authorHandle;
                    if (item.authorDid) metadata.authorDid = item.authorDid;
                    if (item.authorDisplayName) metadata.authorDisplayName = item.authorDisplayName;
                    const pt = item.postText ?? item.textSnippet;
                    if (pt) metadata.postText = pt;
                    archive.unshift(metadata);
                    localStorage.setItem('xoxowiki-archive', JSON.stringify(archive));
                    if (this.blueskyClient?.accessJwt) {
                        try { await this._createArtboardItemOnPDS(metadata); } catch (e) { console.warn('Artboard lexicon create failed:', e); }
                    }
                    await this.syncArchiveToBlueskyIfConnected();
                    return item;
                }
            }
            
            // Option C: Store in IndexedDB only (no disk write, no download) when not using AT Protocol
            let extension = 'bin';
            let mimeType = 'application/octet-stream';
            if (item.imageData.startsWith('data:')) {
                const match = item.imageData.match(/data:([^;]+);base64,(.+)/);
                if (match) {
                    mimeType = match[1];
                    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) extension = 'jpg';
                    else if (mimeType.includes('png')) extension = 'png';
                    else if (mimeType.includes('gif')) extension = 'gif';
                    else if (mimeType.includes('webp')) extension = 'webp';
                    else if (mimeType.includes('video')) extension = 'mp4';
                }
            }
            const filename = `${item.id}.${extension}`;
            let blob;
            if (item.imageData.startsWith('data:')) {
                const base64Data = item.imageData.split(',')[1] || item.imageData;
                const binaryString = atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
                blob = new Blob([bytes], { type: mimeType });
            } else {
                blob = new Blob([item.imageData]);
            }
            await this.storeFileInIndexedDB(filename, blob);
            item.filename = filename;
            
            const archive = this.getArchive();
            const metadata = {
                id: item.id,
                name: item.name,
                type: item.type,
                source: item.source,
                createdAt: item.createdAt,
                filename,
                albumIds: item.albumIds || [],
                articleIds: item.articleIds || [],
                habitDays: item.habitDays || [],
                assignmentType: item.assignmentType || 'albums'
            };
            if (item.authorHandle) metadata.authorHandle = item.authorHandle;
            if (item.authorDid) metadata.authorDid = item.authorDid;
            if (item.authorDisplayName) metadata.authorDisplayName = item.authorDisplayName;
            const pt = item.postText ?? item.textSnippet;
            if (pt) metadata.postText = pt;
            archive.unshift(metadata);
            localStorage.setItem('xoxowiki-archive', JSON.stringify(archive));
            if (this.blueskyClient?.accessJwt) {
                try { await this._createArtboardItemOnPDS(metadata); } catch (e) { console.warn('Artboard lexicon create failed:', e); }
            }
            return item;
        } catch (error) {
            console.error('Error saving archive item:', error);
            if (error.name === 'QuotaExceededError' || error.code === 22) {
                throw new Error('Storage quota exceeded. Connect to Bluesky to store images on the AT Protocol, or select a folder.');
            }
            throw error;
        }
    }

    async syncArchiveToBlueskyIfConnected() {
        if (!this.blueskyClient || !this.blueskyClient.accessJwt) return;
        try {
            await this.ensureValidToken();
            const archive = this.getArchive();
            const albums = this.getAlbums();
            const POST_TEXT_MAX = 2000;
            const payload = {
                archive: archive.map(a => {
                    const rawPostText = a.postText || a.textSnippet || '';
                    const postText = typeof rawPostText === 'string' && rawPostText.length > POST_TEXT_MAX
                        ? rawPostText.slice(0, POST_TEXT_MAX) + '…'
                        : rawPostText || undefined;
                    const blobRef = a.atBlobRef;
                    const atBlobRef = blobRef == null ? null : (typeof blobRef === 'object' && blobRef !== null && (blobRef.$link || blobRef.cid))
                        ? { $link: blobRef.$link || blobRef.cid }
                        : (typeof blobRef === 'string' ? { $link: blobRef } : null);
                    return {
                        id: a.id,
                        name: a.name,
                        type: a.type,
                        source: a.source || null,
                        createdAt: a.createdAt,
                        imageUrl: (a.imageUrl && typeof a.imageUrl === 'string' && a.imageUrl.startsWith('http')) ? a.imageUrl : null,
                        videoUrl: (a.videoUrl && typeof a.videoUrl === 'string' && a.videoUrl.startsWith('http')) ? a.videoUrl : null,
                        atBlobRef,
                        atBlobRefDid: a.atBlobRefDid || null,
                        albumIds: Array.isArray(a.albumIds) ? a.albumIds : [],
                        articleIds: Array.isArray(a.articleIds) ? a.articleIds : [],
                        habitDays: Array.isArray(a.habitDays) ? a.habitDays : [],
                        assignmentType: a.assignmentType || 'albums',
                        ...(a.authorHandle && { authorHandle: a.authorHandle }),
                        ...(a.authorDid && { authorDid: a.authorDid }),
                        ...(a.authorDisplayName && { authorDisplayName: a.authorDisplayName }),
                        ...(postText && { postText })
                    };
                }),
                albums,
                updatedAt: new Date().toISOString()
            };
            const record = {
                $type: 'com.atproto.repo.record',
                key: 'xoxowiki-archive',
                title: 'Archive',
                content: JSON.stringify(payload),
                createdAt: new Date().toISOString()
            };
            const getRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.getRecord?repo=${this.blueskyClient.did}&collection=com.atproto.repo.record&rkey=xoxowiki-archive`);
            const body = { repo: this.blueskyClient.did, collection: 'com.atproto.repo.record', rkey: 'xoxowiki-archive', record };
            if (getRes.ok) {
                const putRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.putRecord`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!putRes.ok) {
                    const err = await putRes.json().catch(() => ({}));
                    throw new Error(err.message || err.error || `putRecord ${putRes.status}`);
                }
            } else {
                const createRes = await this._pdsFetch(`${this._pdsBaseForRepo()}/xrpc/com.atproto.repo.createRecord`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!createRes.ok) {
                    const err = await createRes.json().catch(() => ({}));
                    throw new Error(err.message || err.error || `createRecord ${createRes.status}`);
                }
            }
        } catch (e) {
            console.warn('Sync archive to Bluesky failed:', e);
        }
    }

    async deleteArchiveItem(id) {
        if (this.blueskyClient?.accessJwt) {
            await this._deleteArtboardItemOnPDS(id);
        }
        const archive = this.getArchive();
        const item = archive.find(a => a.id === id);
        if (item && item.filename) {
            await this.deleteFileFromDisk(item.filename);
        }
        const filtered = archive.filter(a => a.id !== id);
        localStorage.setItem('xoxowiki-archive', JSON.stringify(filtered));
        await this.syncArchiveToBlueskyIfConnected();
    }

    updateArchiveItem(id, updates) {
        const archive = this.getArchive();
        const idx = archive.findIndex(a => a.id === id);
        if (idx !== -1) {
            archive[idx] = { ...archive[idx], ...updates };
            localStorage.setItem('xoxowiki-archive', JSON.stringify(archive));
            if (this.blueskyClient?.accessJwt) {
                this._putArtboardItemOnPDS(archive[idx]).catch(e => console.warn('Artboard lexicon update failed:', e));
            }
            this.syncArchiveToBlueskyIfConnected().catch(() => {});
        }
    }

    getArchiveByAlbum(albumId) {
        return this.getArchive().filter(a => {
            // Support both old single albumId and new albumIds array
            const itemAlbums = a.albumIds || (a.albumId ? [a.albumId] : []);
            return itemAlbums.includes(albumId);
        });
    }

    // ===== ALBUMS =====
    getAlbums() {
        try {
            const stored = localStorage.getItem('xoxowiki-albums');
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    }

    saveAlbum(album) {
        const albums = this.getAlbums();
        album.id = Date.now().toString();
        album.createdAt = new Date().toISOString();
        albums.push(album);
        localStorage.setItem('xoxowiki-albums', JSON.stringify(albums));
        if (this.blueskyClient?.accessJwt) {
            this._createArtboardAlbumOnPDS(album).catch(e => console.warn('Artboard album lexicon create failed:', e));
        }
        this.syncArchiveToBlueskyIfConnected().catch(() => {});
        return album;
    }

    async deleteAlbum(id) {
        if (this.blueskyClient?.accessJwt) {
            await this._deleteArtboardAlbumOnPDS(id);
        }
        const albums = this.getAlbums().filter(a => a.id !== id);
        localStorage.setItem('xoxowiki-albums', JSON.stringify(albums));
        const archive = this.getArchive().map(a => {
            if (a.albumId === id) a.albumId = null;
            if (a.albumIds && Array.isArray(a.albumIds)) a.albumIds = a.albumIds.filter(albumId => albumId !== id);
            return a;
        });
        localStorage.setItem('xoxowiki-archive', JSON.stringify(archive));
        await this.syncArchiveToBlueskyIfConnected();
    }

    // ===== SECTION ORDER =====
    getSectionOrder() {
        try {
            const stored = localStorage.getItem('xoxowiki-section-order');
            return stored ? JSON.parse(stored) : null;
        } catch { return null; }
    }

    saveSectionOrder(order) {
        localStorage.setItem('xoxowiki-section-order', JSON.stringify(order));
    }

    getBentoSizes() {
        try {
            const stored = localStorage.getItem('xoxowiki-bento-sizes');
            return stored ? JSON.parse(stored) : {};
        } catch { return {}; }
    }

    saveBentoSize(section, size) {
        const sizes = this.getBentoSizes();
        sizes[section] = size;
        localStorage.setItem('xoxowiki-bento-sizes', JSON.stringify(sizes));
    }

    // ===== PINNED ARTICLES =====
    getPinnedArticles() {
        try {
            const stored = localStorage.getItem('xoxowiki-pinned');
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    }

    togglePinArticle(key) {
        const pinned = this.getPinnedArticles();
        const idx = pinned.indexOf(key);
        if (idx === -1) pinned.unshift(key);
        else pinned.splice(idx, 1);
        localStorage.setItem('xoxowiki-pinned', JSON.stringify(pinned));
        return pinned;
    }

    // ===== ACTIVITY FEED =====
    getActivityFeed() {
        try {
            const stored = localStorage.getItem('xoxowiki-activity');
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    }

    logActivity(type, data) {
        const feed = this.getActivityFeed();
        feed.unshift({ type, data, timestamp: new Date().toISOString() });
        if (feed.length > 50) feed.pop();
        localStorage.setItem('xoxowiki-activity', JSON.stringify(feed));
    }

    // ===== ARTICLE METADATA =====
    getArticleMeta(key) {
        try {
            const stored = localStorage.getItem('xoxowiki-meta');
            const meta = stored ? JSON.parse(stored) : {};
            return meta[key] || { isPublic: true, source: '', remixedFrom: null };
        } catch { return { isPublic: true, source: '', remixedFrom: null }; }
    }

    saveArticleMeta(key, data) {
        try {
            const stored = localStorage.getItem('xoxowiki-meta');
            const meta = stored ? JSON.parse(stored) : {};
            meta[key] = { ...this.getArticleMeta(key), ...data };
            localStorage.setItem('xoxowiki-meta', JSON.stringify(meta));
        } catch (e) { console.error('Error saving meta:', e); }
    }

    getBacklinks(key) {
        const backlinks = [];
        for (const [k, article] of Object.entries(this.articles)) {
            if (k !== key && article.content && article.content.includes(`[[${key}]]`)) {
                backlinks.push({ key: k, title: article.title });
            }
        }
        return backlinks;
    }
}
