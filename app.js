// Main wiki application
class WikiApp {
    constructor() {
        this.storage = new WikiStorage();
        this.articles = {};
        this.currentArticleKey = null;
        this.selectedText = '';
        this.quill = null;
        this.fileHandle = null; // Store file handle for overwriting
        this.searchSelectedIndex = -1; // Track selected search result
        this.searchResults = []; // Store current search results
        this.currentWebcomicPageIndex = undefined; // Track current webcomic page
        this.collectionEditMode = false; // Track collection edit mode
        this.selectedCollectionItems = new Set(); // Track selected items for deletion
        this.selectedCollections = new Set(); // Track selected collections (albums) for deletion
        this.init();
    }

    async init() {
        try {
            // Initialize storage first (this handles OAuth callback if present)
            await this.storage.init();
            
            // Check if we just completed OAuth
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('code') && urlParams.get('state')) {
                // OAuth was just completed in storage.init(), show success
                this.showUpdateNotification('Successfully connected to Bluesky!');
            }
            
            await this.loadArticles();
            this.initQuillEditor();
            this.setupEventListeners();
            this.setupRouting();
            await this.handleRoute();
            this.updateStorageIndicator();
            this.updateBookmarksDisplay();
            this.updateThoughtsDisplay();
            this.updateRecentArticlesDisplay();
            await this.generateRSSFeed(); // Generate RSS on load
            this.setupMobileSidebars(); // Setup swipe gestures for mobile sidebars
        } catch (error) {
            console.error('Error initializing wiki app:', error);
            console.log('Wiki initialized with errors. Some features may not work.');
            // Ensure content is displayed even if there's an error
            try {
                const container = document.getElementById('article-container');
                if (container && !container.innerHTML.trim()) {
                    await this.showArticle('main');
                }
            } catch (fallbackError) {
                console.error('Error showing fallback content:', fallbackError);
            }
        }
    }

    initQuillEditor() {
        if (typeof Quill === 'undefined') {
            const editorDiv = document.getElementById('article-content-editor');
            if (editorDiv) {
                editorDiv.innerHTML = '<textarea id="article-content-fallback" style="width:100%;height:300px;padding:10px;border:1px solid #a7d7f9;border-radius:2px;font-family:inherit;font-size:14px;" placeholder="Write your article here. Use the toolbar above to format text."></textarea>';
            }
            return;
        }

        const editorElement = document.getElementById('article-content-editor');
        if (!editorElement) return;

        try {
            this.quill = new Quill('#article-content-editor', {
                theme: 'snow',
                modules: {
                    toolbar: [
                        [{ 'header': [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline'],
                        ['link', 'blockquote'],
                        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                        ['clean']
                    ]
                },
                placeholder: 'Write your article here. Use the toolbar above to format text.'
            });
        } catch (error) {
            console.error('Quill error:', error);
        }
    }

    async loadArticles() {
        try {
            this.articles = await this.storage.getAllArticles();
        } catch (error) {
            console.error('Load articles error:', error);
            this.articles = {};
        }
    }

    /** When logged into Bluesky, returns HTML for a small blue cloud icon indicating synced to PDS; otherwise '' */
    getPdsSyncCloudIcon() {
        if (this.storage.storageMode !== 'bluesky') return '';
        return `<span class="pds-sync-cloud" title="Synced to Bluesky PDS" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg></span>`;
    }

    /** Label under artboard media: "Image from @handle" or "Video from @handle". Full URL is only in the edit window. */
    getArchiveItemMetaLabel(item) {
        const mediaType = (item.type === 'video') ? 'Video' : 'Image';
        if (item.authorHandle) return `${mediaType} from ${this.escapeHtml('@' + item.authorHandle)}`;
        if (item.authorDid) return `${mediaType} from ${this.escapeHtml('@' + item.authorDid)}`;
        if (item.source) {
            try {
                const url = new URL(item.source);
                const profileMatch = item.source.match(/bsky\.app\/profile\/([^/]+)/i);
                if (profileMatch) return `${mediaType} from ${this.escapeHtml('@' + profileMatch[1])}`;
                return `${mediaType} from ${this.escapeHtml(url.hostname)}`;
            } catch (_) {
                return 'Source';
            }
        }
        return 'View details';
    }

    // Check if in mobile mode based on viewport width (vw)
    // Mobile mode activates when viewport width <= 68.75vw of a 1600px reference viewport
    // This equals 1100px, but scales with different viewport sizes
    // Using vw-based calculation: 68.75vw of 1600px = 1100px
    isMobileMode() {
        const viewportWidth = window.innerWidth;
        // Reference viewport width (typical desktop)
        const referenceViewport = 1600;
        // Mobile breakpoint as vw percentage: 68.75vw = 68.75% of reference
        const mobileBreakpointPx = referenceViewport * 0.6875; // 1100px
        // Check if current viewport is narrow enough for mobile mode
        // This is equivalent to checking if viewport <= 68.75vw of reference
        return viewportWidth <= mobileBreakpointPx;
    }

    setupEventListeners() {
        // Navigation links - use event delegation for dynamically created links
        this.wasDragged = false;
        
        // Close bento edit mode when clicking outside
        document.addEventListener('click', (e) => {
            const grid = document.getElementById('bento-grid');
            if (!grid) return;
            
            // Find all bentos in edit mode
            const editingBentos = grid.querySelectorAll('.bento-card.bento-editing');
            if (editingBentos.length === 0) return;
            
            // Don't exit if clicking on bento controls (buttons, etc.)
            if (e.target.closest('.bento-controls-wrapper, .bento-edit-btn, .bento-delete-btn, .size-btn, .move-btn')) {
                return;
            }
            
            // Check if click is inside any editing bento
            let clickedInsideEditingBento = false;
            editingBentos.forEach(bento => {
                if (bento.contains(e.target)) {
                    clickedInsideEditingBento = true;
                }
            });
            
            // If click is outside all editing bentos, exit edit mode
            if (!clickedInsideEditingBento) {
                editingBentos.forEach(bento => {
                    const sectionName = bento.getAttribute('data-section');
                    if (sectionName) {
                        // Exit edit mode by toggling it off
                        const moveControls = bento.querySelector('.bento-move-controls');
                        const deleteResizeWrapper = bento.querySelector('.bento-delete-resize-wrapper');
                        const controlsWrapper = bento.querySelector('.bento-controls-wrapper');
                        
                        if (moveControls && moveControls.style.display !== 'none') {
                            // Currently in edit mode, so exit it
                            moveControls.style.display = 'none';
                            if (deleteResizeWrapper) deleteResizeWrapper.style.display = 'none';
                            bento.classList.remove('bento-editing');
                            if (controlsWrapper) controlsWrapper.style.opacity = '';
                            
                            // Remove moved class when exiting edit mode
                            if (bento.classList.contains('bento-moved')) {
                                setTimeout(() => {
                                    bento.classList.remove('bento-moved');
                                }, 10);
                            }
                            
                            // Clear moved section tracking if this was the moved bento
                            if (this.movedBentoSection === sectionName) {
                                this.movedBentoSection = null;
                            }
                        }
                    }
                });
            }
        });
        
        // Use capture phase to intercept clicks on bento-clickable before inline handlers
        document.addEventListener('click', (e) => {
            const bentoCard = e.target.closest('.bento-clickable');
            if (bentoCard) {
                // Allow clicks on interactive elements (links, buttons, inputs, etc.) to proceed normally
                const isInteractive = e.target.closest('a, button, input, select, textarea, label[for]');
                if (isInteractive) {
                    // Don't prevent - let the interactive element handle the click
                    return;
                }
                
                // If we just finished dragging, prevent navigation
                if (this.wasDragged) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    this.wasDragged = false;
                    return false;
                }
            }
        }, true); // Capture phase - fires before inline handlers
        
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[data-route]');
            if (link) {
                if (this.wasDragged) {
                    this.wasDragged = false;
                    return;
                }
                e.preventDefault();
                const route = link.getAttribute('data-route');
                this.navigate(route);
            }
        });
        
        // Track drag events to prevent navigation
        document.addEventListener('dragstart', () => {
            this.wasDragged = true;
        });
        
        document.addEventListener('dragend', () => {
            setTimeout(() => { this.wasDragged = false; }, 100);
        });

        // Create article button (from text selection)
        document.addEventListener('mouseup', (e) => {
            // Don't show button if clicking on a link or button
            if (e.target.closest('a, button')) {
                this.hideCreateButton();
                return;
            }

            const selection = window.getSelection();
            const text = selection.toString().trim();
            
            if (text.length > 0 && text.length < 500) {
                this.selectedText = text;
                this.showCreateButton(selection);
            } else {
                this.hideCreateButton();
            }
        });

        // Hide create button when clicking elsewhere
        // Also hide search results when clicking outside search area
        document.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.create-article-button') && !e.target.closest('.article-modal')) {
                this.hideCreateButton();
            }
            
            // Hide search results when clicking outside search container
            const searchContainer = document.querySelector('.mw-search-container');
            const searchResults = document.getElementById('search-results');
            if (searchResults && searchContainer && !e.target.closest('.mw-search-container')) {
                if (searchResults.style.display === 'block') {
                    searchResults.style.display = 'none';
                    this.searchSelectedIndex = -1;
                }
            }
        });

        // New Article button
        // Create button removed - users can create articles through search results or other methods

        // Modal controls
        const saveBtn = document.getElementById('save-article');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                console.log('Save button clicked');
                this.saveArticle().catch(err => {
                    console.error('Save error:', err);
                    alert('Error saving article: ' + err.message);
                });
            });
        }
        
        const cancelBtn = document.getElementById('cancel-article');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeModal());
        
        const deleteBtn = document.getElementById('delete-article');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this.deleteArticle());
        const viewHistoryBtn = document.getElementById('view-history');
        if (viewHistoryBtn) viewHistoryBtn.addEventListener('click', () => this.viewHistory());
        
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (e.target.closest('#history-modal')) {
                    this.closeHistoryModal();
                } else if (e.target.closest('#import-json-modal')) {
                    this.closeImportModal();
                } else if (e.target.closest('#bluesky-modal')) {
                    this.closeBlueskyModal();
                } else if (e.target.closest('#webcomic-upload-modal')) {
                    this.closeUploadWebcomicModal();
                } else if (e.target.closest('#pds-data-modal')) {
                    this.closePDSDataModal();
                } else if (e.target.closest('#browse-post-modal')) {
                    document.getElementById('browse-post-modal').style.display = 'none';
                } else if (e.target.closest('#browse-add-modal')) {
                    document.getElementById('browse-add-modal').style.display = 'none';
                } else {
                    this.closeModal();
                }
            });
        });
        
        // Close any modal when clicking outside (on backdrop) - use event delegation for all modals
        document.addEventListener('click', (e) => {
            // Check if click is on a modal backdrop (the article-modal element itself, not its children)
            const modal = e.target.closest('.article-modal');
            if (modal && e.target === modal) {
                // Click is directly on the modal backdrop, close it
                const modalId = modal.id;
                if (modalId === 'history-modal') {
                    this.closeHistoryModal();
                } else if (modalId === 'import-json-modal') {
                    this.closeImportModal();
                } else if (modalId === 'bluesky-modal') {
                    this.closeBlueskyModal();
                } else if (modalId === 'webcomic-upload-modal') {
                    this.closeUploadWebcomicModal();
                } else if (modalId === 'pds-data-modal') {
                    this.closePDSDataModal();
                } else if (modalId === 'browse-post-modal') {
                    modal.style.display = 'none';
                } else if (modalId === 'browse-add-modal') {
                    modal.style.display = 'none';
                } else if (modalId === 'browse-feed-search-modal') {
                    modal.style.display = 'none';
                } else if (modalId === 'article-modal') {
                    this.closeModal();
                } else {
                    // Generic close for any other modal
                    modal.style.display = 'none';
                }
            }
        }, true); // Use capture phase to catch events before they bubble

        // Bluesky connection (handled in menu section above)
        
        const connectBlueskySubmitBtn = document.getElementById('connect-bluesky-btn');
        if (connectBlueskySubmitBtn) connectBlueskySubmitBtn.addEventListener('click', () => this.connectBluesky());
        
        const cancelBlueskyBtn = document.getElementById('cancel-bluesky');
        if (cancelBlueskyBtn) cancelBlueskyBtn.addEventListener('click', () => this.closeBlueskyModal());

        const viewPdsDataBtn = document.getElementById('view-pds-data');
        if (viewPdsDataBtn) viewPdsDataBtn.addEventListener('click', () => this.showPDSDataModal());
        const pdsDataModalCloseBtn = document.getElementById('pds-data-modal-close-btn');
        if (pdsDataModalCloseBtn) pdsDataModalCloseBtn.addEventListener('click', () => this.closePDSDataModal());

        // Archive directory selection
        const selectArchiveDirBtn = document.getElementById('select-archive-directory');
        if (selectArchiveDirBtn) {
            selectArchiveDirBtn.addEventListener('click', () => this.selectArchiveDirectory());
        }
        
        // Clear storage
        const clearStorageBtn = document.getElementById('clear-storage');
        if (clearStorageBtn) {
            clearStorageBtn.addEventListener('click', () => this.clearBrowserStorage());
        }
        
        // JSON export/import
        const exportJsonBtn = document.getElementById('export-json');
        if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => this.downloadJSON());
        
        const importJsonBtn = document.getElementById('import-json');
        if (importJsonBtn) importJsonBtn.addEventListener('click', () => this.openImportModal());
        
        const importJsonSubmitBtn = document.getElementById('import-json-btn');
        if (importJsonSubmitBtn) importJsonSubmitBtn.addEventListener('click', () => this.importJSON());
        
        const cancelImportJsonBtn = document.getElementById('cancel-import-json');
        if (cancelImportJsonBtn) cancelImportJsonBtn.addEventListener('click', () => this.closeImportModal());
        
        // Import JSON file input and dropzone
        const importJsonDropzone = document.getElementById('import-json-dropzone');
        const importJsonFileInput = document.getElementById('import-json-file-input');
        if (importJsonDropzone && importJsonFileInput) {
            // Click to browse
            importJsonDropzone.addEventListener('click', () => importJsonFileInput.click());
            
            // File input change
            importJsonFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.handleImportJsonFile(file);
                }
            });
            
            // Drag and drop
            importJsonDropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                importJsonDropzone.classList.add('dragover');
            });
            
            importJsonDropzone.addEventListener('dragleave', () => {
                importJsonDropzone.classList.remove('dragover');
            });
            
            importJsonDropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                importJsonDropzone.classList.remove('dragover');
                
                const file = e.dataTransfer.files[0];
                if (file && (file.type === 'application/json' || file.name.endsWith('.json'))) {
                    this.handleImportJsonFile(file);
                } else {
                    alert('Please drop a JSON file (.json)');
                }
            });
        }

        // Webcomic upload
        const uploadWebcomicBtn = document.getElementById('upload-webcomic-btn');
        if (uploadWebcomicBtn) uploadWebcomicBtn.addEventListener('click', () => this.uploadWebcomicPage());
        
        const cancelWebcomicUploadBtn = document.getElementById('cancel-webcomic-upload');
        if (cancelWebcomicUploadBtn) cancelWebcomicUploadBtn.addEventListener('click', () => this.closeUploadWebcomicModal());

        // Create modal tabs
        document.querySelectorAll('.create-tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchCreateTab(tab.dataset.tab));
        });
        
        // Media dropzone
        const dropzone = document.getElementById('media-dropzone');
        if (dropzone) {
            dropzone.addEventListener('click', () => document.getElementById('media-file-input').click());
            dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); this.handleMediaFiles(e.dataTransfer.files); });
        }
        
        const mediaFileInput = document.getElementById('media-file-input');
        if (mediaFileInput) mediaFileInput.addEventListener('change', (e) => this.handleMediaFiles(e.target.files));
        
        const addMediaByUrlBtn = document.getElementById('add-media-by-url');
        const mediaImageUrlInput = document.getElementById('media-image-url');
        if (addMediaByUrlBtn && mediaImageUrlInput) {
            addMediaByUrlBtn.addEventListener('click', async () => {
                const url = mediaImageUrlInput.value.trim();
                if (!url) {
                    alert('Please enter an image URL or a Bluesky post URL.');
                    return;
                }
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    alert('Please enter a valid http or https URL.');
                    return;
                }
                // Bluesky post URL: fetch post and add all images/videos to pending
                if (this.storage._parseBskyPostUrl(url)) {
                    addMediaByUrlBtn.disabled = true;
                    addMediaByUrlBtn.textContent = 'Loading…';
                    try {
                        const { items, error } = await this.storage.fetchPostMediaFromUrl(url);
                        if (error) {
                            alert(error);
                            return;
                        }
                        for (const it of items) {
                            this.pendingMediaFiles.push({
                                data: null,
                                imageUrl: it.imageUrl,
                                videoUrl: it.videoUrl || null,
                                name: it.name || (it.type === 'video' ? 'Video from post' : 'Image from post'),
                                type: it.type || 'image',
                                albumIds: [],
                                assignmentType: 'albums',
                                articleIds: [],
                                habitDays: [],
                                source: it.source || url,
                                authorHandle: it.authorHandle,
                                authorDid: it.authorDid,
                                authorDisplayName: it.authorDisplayName,
                                postText: it.postText ?? it.textSnippet
                            });
                        }
                        mediaImageUrlInput.value = '';
                        const sourceInput = document.getElementById('media-source');
                        if (sourceInput) sourceInput.value = '';
                        this.updateMediaPreview();
                        if (items.length > 0) {
                            this.showUpdateNotification(`Added ${items.length} item(s) from post. Save to add them to your artboard.`);
                        }
                    } finally {
                        addMediaByUrlBtn.disabled = false;
                        addMediaByUrlBtn.textContent = 'Add';
                    }
                    return;
                }
                // Single image/URL
                this.pendingMediaFiles.push({
                    data: null,
                    imageUrl: url,
                    name: 'Image from URL',
                    type: 'image',
                    albumIds: [],
                    assignmentType: 'albums',
                    articleIds: [],
                    habitDays: []
                });
                mediaImageUrlInput.value = '';
                this.updateMediaPreview();
            });
        }
        
        const saveMediaBtn = document.getElementById('save-media');
        if (saveMediaBtn) {
            saveMediaBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Save media button clicked');
                this.saveMediaItems();
            });
        } else {
            console.warn('Save media button not found during initialization');
        }
        
        const cancelMediaBtn = document.getElementById('cancel-media');
        if (cancelMediaBtn) cancelMediaBtn.addEventListener('click', () => {
            this.pendingMediaFiles = [];
            this.updateMediaPreview();
            this.closeModal();
        });

        // Save Draft button
        const saveDraftBtn = document.getElementById('save-draft');
        if (saveDraftBtn) saveDraftBtn.addEventListener('click', () => this.saveDraft());

        // Auto-save setup
        this.setupAutoSave();

        // Bottom Sheet
        const bottomSheet = document.getElementById('bottom-sheet');
        if (bottomSheet) {
            bottomSheet.querySelectorAll('.bottom-sheet-item').forEach(item => {
                item.addEventListener('click', () => {
                    const action = item.dataset.action;
                    this.closeBottomSheet();
                    if (action === 'new-article') this.openCreateModal();
                    else if (action === 'upload-media') this.openCreateModal('media');
                    else if (action === 'random-article') this.randomArticle();
                });
            });
            
            // Close on backdrop click
            bottomSheet.addEventListener('click', (e) => {
                if (e.target === bottomSheet) this.closeBottomSheet();
            });
        }

        // Swipe gesture for bottom sheet
        let touchStartY = 0;
        document.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; });
        document.addEventListener('touchend', (e) => {
            const touchEndY = e.changedTouches[0].clientY;
            const diff = touchStartY - touchEndY;
            if (diff > 100 && document.getElementById('quick-capture-btn')) {
                // Swipe up - open bottom sheet on mobile
                if (this.isMobileMode()) this.openBottomSheet();
            }
        });

        // Download wiki code button
        const downloadWikiCodeBtn = document.getElementById('download-wiki-code');
        if (downloadWikiCodeBtn) downloadWikiCodeBtn.addEventListener('click', () => this.downloadWikiCode());

        // Auto-generate key from title
        const titleInput = document.getElementById('article-title');
        if (titleInput) {
            titleInput.addEventListener('input', (e) => {
                const title = e.target.value;
                const keyInput = document.getElementById('article-key');
                if (keyInput && !keyInput.dataset.manual) {
                    keyInput.value = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                }
            });
        }

        const keyInput = document.getElementById('article-key');
        if (keyInput) {
            keyInput.addEventListener('input', (e) => {
                e.target.dataset.manual = 'true';
            });
        }

        // Search functionality
        const searchInput = document.getElementById('wiki-search');
        const searchButton = document.getElementById('search-button');
        
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
            searchInput.addEventListener('focus', () => {
                if (searchInput.value) {
                    document.getElementById('search-results').style.display = 'block';
                }
            });
            
            // Keyboard navigation for search results
            searchInput.addEventListener('keydown', (e) => {
                const searchResults = document.getElementById('search-results');
                const isResultsVisible = searchResults && searchResults.style.display === 'block';
                const resultItems = searchResults ? searchResults.querySelectorAll('.search-result-item') : [];
                const createOption = searchResults ? searchResults.querySelector('.search-result-create') : null;
                const totalSelectable = resultItems.length + (createOption ? 1 : 0);
                
                if (e.key === 'Enter') {
                    e.preventDefault();
                    // If create option is selected (index = resultItems.length)
                    if (this.searchSelectedIndex === resultItems.length && createOption) {
                        const query = createOption.getAttribute('data-query');
                        this.showCreateFromSearch(query);
                        searchInput.blur();
                        searchResults.style.display = 'none';
                        this.searchSelectedIndex = -1;
                    }
                    // If a result is selected, navigate to it
                    else if (this.searchSelectedIndex >= 0 && this.searchSelectedIndex < this.searchResults.length) {
                        const selectedResult = this.searchResults[this.searchSelectedIndex];
                        if (selectedResult.type === 'article') {
                            this.navigate(selectedResult.key);
                        } else if (selectedResult.type === 'collection') {
                            this.filterCollectionByAlbum(selectedResult.id);
                        } else if (selectedResult.type === 'habit') {
                            this.navigate('main');
                        }
                        searchInput.blur();
                        searchResults.style.display = 'none';
                        this.searchSelectedIndex = -1;
                    } else {
                        // Otherwise just trigger search
                        this.handleSearch(e.target.value);
                        if (e.target.value.trim()) {
                            searchResults.style.display = 'block';
                        }
                    }
                } else if (e.key === 'ArrowDown' && isResultsVisible && totalSelectable > 0) {
                    e.preventDefault();
                    this.searchSelectedIndex = Math.min(this.searchSelectedIndex + 1, totalSelectable - 1);
                    this.highlightSearchResult(this.searchSelectedIndex);
                } else if (e.key === 'ArrowUp' && isResultsVisible && totalSelectable > 0) {
                    e.preventDefault();
                    this.searchSelectedIndex = Math.max(this.searchSelectedIndex - 1, -1);
                    this.highlightSearchResult(this.searchSelectedIndex);
                } else if (e.key === 'Escape' && isResultsVisible) {
                    e.preventDefault();
                    searchResults.style.display = 'none';
                    this.searchSelectedIndex = -1;
                }
            });
        }
        
        if (searchButton) {
            searchButton.addEventListener('click', () => {
                const query = searchInput ? searchInput.value : '';
                this.handleSearch(query);
                if (query.trim()) {
                    document.getElementById('search-results').style.display = 'block';
                }
            });
        }

        // Menu button
        const menuButton = document.getElementById('menu-button');
        const menuOverlay = document.getElementById('menu-overlay');
        const menuButtonWrapper = menuButton ? menuButton.closest('.menu-button-wrapper') : null;
        
        if (menuButton && menuOverlay) {
            menuButton.addEventListener('click', (e) => {
                e.stopPropagation();
                menuOverlay.classList.toggle('active');
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (menuOverlay.classList.contains('active')) {
                    if (menuButtonWrapper && !menuButtonWrapper.contains(e.target)) {
                        menuOverlay.classList.remove('active');
                    }
                }
            });

            // Close menu when clicking menu items
            const menuItems = menuOverlay.querySelectorAll('.menu-item');
            menuItems.forEach(item => {
                item.addEventListener('click', () => {
                    menuOverlay.classList.remove('active');
                });
            });

            // New article button in menu
            const menuNewArticle = document.getElementById('menu-new-article');
            if (menuNewArticle) {
                menuNewArticle.addEventListener('click', () => {
                    this.openCreateModal();
                    menuOverlay.classList.remove('active');
                });
            }

            // Bluesky connect button in menu
            const menuConnectBluesky = document.getElementById('menu-connect-bluesky');
            if (menuConnectBluesky) {
                menuConnectBluesky.addEventListener('click', () => {
                    this.openBlueskyModal();
                    menuOverlay.classList.remove('active');
                });
            }

            // Bluesky disconnect button in menu
            const menuDisconnectBluesky = document.getElementById('menu-disconnect-bluesky');
            if (menuDisconnectBluesky) {
                menuDisconnectBluesky.addEventListener('click', () => {
                    this.disconnectBluesky();
                    menuOverlay.classList.remove('active');
                });
            }

            // Close menu with ESC key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && menuOverlay.classList.contains('active')) {
                    menuOverlay.classList.remove('active');
                }
            });
        }

        // Header Bluesky button (left of menu)
        const headerBlueskyBtn = document.getElementById('header-bluesky-btn');
        if (headerBlueskyBtn) {
            headerBlueskyBtn.addEventListener('click', () => this.openBlueskyModal());
        }

        // Sidebar Bluesky connect link
        const sidebarConnectBluesky = document.getElementById('connect-bluesky');
        if (sidebarConnectBluesky) {
            sidebarConnectBluesky.addEventListener('click', (e) => {
                e.preventDefault();
                this.openBlueskyModal();
            });
        }

        // Bluesky handle autocomplete (like pckt.blog)
        this.setupBlueskyHandleAutocomplete();

        // Sidebar Bluesky disconnect button
        const sidebarDisconnectBluesky = document.getElementById('disconnect-bluesky');
        if (sidebarDisconnectBluesky) {
            sidebarDisconnectBluesky.addEventListener('click', (e) => {
                e.preventDefault();
                this.disconnectBluesky();
            });
        }

        // Keyboard shortcuts for article modal
        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('article-modal');
            // Only trigger if article modal is open and visible
            if (modal && modal.style.display === 'flex') {
                // ESC key to close modal
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.closeModal();
                    return;
                }
                
                // Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux) to save
                const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                const modifierKey = isMac ? e.metaKey : e.ctrlKey;
                
                if (modifierKey && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    // Save the article
                    this.saveArticle().catch(err => {
                        console.error('Save error:', err);
                        alert('Error saving article: ' + err.message);
                    });
                }
            }
        });

        // Search bar hide/show on scroll - binary mode: mobile OR desktop
        let lastScrollTop = 0;
        // Use vw-based threshold: 1vw = 1% of viewport width (only to prevent jitter, not a mode)
        const getScrollThreshold = () => window.innerWidth * 0.01; // 1vw in pixels
        const searchContainer = document.querySelector('.mw-search-container');
        const mobileBottomNav = document.getElementById('mobile-bottom-nav');
        const headerTop = document.querySelector('.mw-header-top');
        const searchResults = document.getElementById('search-results');
        const mobileMoreBtn = document.getElementById('mobile-more-btn');
        
        window.addEventListener('scroll', () => {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollDifference = Math.abs(scrollTop - lastScrollTop);
            const isMobile = this.isMobileMode(); // Binary: mobile OR desktop, no in-between
            
            // Only trigger if scrolled enough to avoid jitter (1vw) - this is NOT a mode, just anti-jitter
            if (scrollDifference < getScrollThreshold()) {
                return;
            }
            
            const mwHeader = document.querySelector('.mw-header');
            
            if (scrollTop > lastScrollTop) {
                // Scrolling down - hide top bar and search results
                if (searchResults) {
                    searchResults.style.display = 'none';
                }
                if (!isMobile) {
                    // Desktop mode: hide entire header immediately
                    if (mwHeader) {
                        mwHeader.classList.add('header-hidden');
                    }
                } else {
                    // Mobile mode: hide bottom nav and search bar immediately
                    if (mobileBottomNav) {
                        mobileBottomNav.classList.add('nav-hidden');
                    }
                    if (headerTop) {
                        headerTop.classList.remove('search-visible');
                        headerTop.classList.add('search-hidden');
                    }
                }
            } else if (scrollTop < lastScrollTop) {
                // Scrolling up - show top bar (search results stay hidden until user types)
                if (!isMobile) {
                    // Desktop mode: show entire header immediately
                    if (mwHeader) {
                        mwHeader.classList.remove('header-hidden');
                    }
                } else {
                    // Mobile mode: show bottom nav, search bar, and more button immediately
                    if (mobileBottomNav) {
                        mobileBottomNav.classList.remove('nav-hidden');
                    }
                    if (headerTop) {
                        headerTop.classList.add('search-visible');
                        headerTop.classList.remove('search-hidden');
                    }
                    if (mobileMoreBtn) {
                        mobileMoreBtn.classList.remove('more-hidden');
                    }
                }
            }
            
            lastScrollTop = scrollTop <= 0 ? 0 : scrollTop; // For Mobile or negative scrolling
        }, { passive: true });
        
        // Show search bar and more button initially on mobile
        if (headerTop && this.isMobileMode()) {
            headerTop.classList.add('search-visible');
            headerTop.classList.remove('search-hidden');
        }
        if (mobileMoreBtn && this.isMobileMode()) {
            mobileMoreBtn.classList.remove('more-hidden');
        }
        
        // Ensure header is visible initially on desktop
        const mwHeader = document.querySelector('.mw-header');
        if (mwHeader && !this.isMobileMode()) {
            mwHeader.classList.remove('header-hidden');
        }

        // Mobile bottom nav - new article button (legacy, may not exist anymore)
        const mobileNewArticle = document.getElementById('mobile-new-article');
        if (mobileNewArticle) {
            mobileNewArticle.addEventListener('click', () => {
                this.openCreateModal();
            });
        }

        // Mobile More Menu handling
        this.setupMobileMoreMenu();

        // Handle window resize for mobile nav visibility
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const mobileNav = document.getElementById('mobile-bottom-nav');
                if (mobileNav) {
                    if (this.isMobileMode()) {
                        // On mobile, show nav if we're not scrolled down much
                        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
                        if (scrollTop <= 50) {
                            mobileNav.classList.remove('nav-hidden');
                        }
                        // Also show search bar if not scrolled much
                        const headerTop = document.querySelector('.mw-header-top');
                        if (headerTop) {
                            if (scrollTop <= 50) {
                                headerTop.classList.add('search-visible');
                            } else {
                                headerTop.classList.remove('search-visible');
                            }
                        }
                    } else {
                        // On desktop, always hide mobile nav
                        mobileNav.classList.add('nav-hidden');
                    }
                }
            }, 100);
        });
    }

    generateTableOfContents(html) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const headings = tempDiv.querySelectorAll('h1, h2, h3');
        const toc = [];
        
        headings.forEach((heading, index) => {
            const id = heading.id || this.generateSectionId(heading.textContent.replace(/\[copy link\]|\[edit\]/g, '').trim());
            const level = parseInt(heading.tagName.charAt(1));
            const text = heading.textContent.replace(/\[copy link\]|\[edit\]/g, '').trim();
            
            // Ensure heading has ID
            if (!heading.id) {
                heading.id = id;
            }
            
            toc.push({
                id,
                level,
                text,
                index
            });
        });
        
        return toc;
    }

    updateTableOfContents(toc) {
        const tocContainer = document.getElementById('table-of-contents');
        const tocList = document.getElementById('toc-list');
        
        if (!tocContainer || !tocList) return;
        
        if (toc.length === 0) {
            tocContainer.style.display = 'none';
            return;
        }
        
        tocContainer.style.display = 'block';
        
        const articleKey = this.currentArticleKey || 'main';
        const tocItems = toc.map(item => {
            const indent = item.level > 1 ? ` style="padding-left: ${(item.level - 1) * 1}em;"` : '';
            return `<div class="toc-item toc-level-${item.level}"${indent}><a href="#${articleKey}#${item.id}" data-route="${articleKey}" data-section="${item.id}">${item.text}</a></div>`;
        }).join('');
        
        tocList.innerHTML = tocItems;
        
        // Add click handlers for TOC links
        tocList.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const route = link.getAttribute('data-route');
                const section = link.getAttribute('data-section');
                this.navigate(route + '#' + section);
            });
        });
    }
    setupRouting() {
        // Use hash-based routing for file:// protocol compatibility
        window.addEventListener('hashchange', () => this.handleRoute());
        // Also listen for popstate in case browser supports it
        window.addEventListener('popstate', () => this.handleRoute());
    }

    navigate(route) {
        // Scroll to top when navigating via page buttons
        window.scrollTo({ top: 0, behavior: 'instant' });
        
        // Use hash-based routing (#) which works with file:// protocol
        const newHash = `#${route}`;
        const currentHash = window.location.hash;
        
        // Update hash first
        if (currentHash !== newHash) {
            window.location.hash = newHash;
        }
        
        // Update mobile nav active state
        this.updateMobileNavActiveState(route);
        
        // Then call handleRoute with the route directly to ensure correct route is processed
        // This prevents timing issues where hashchange might fire before hash is updated
        this.handleRoute(route);
        
        // On mobile, close any open sidebars after navigation
        this.closeMobileSidebars();
    }
    
    updateMobileNavActiveState(route) {
        // Get base route (without section anchors)
        const baseRoute = route.split('#')[0] || 'main';
        
        // Map article routes to nav items
        const routeMap = {
            'main': 'main',
            'articles': 'articles',
            'collection': 'collection',
            'archive': 'collection',
            'browse': 'browse',
            'habits': 'habits',
            'bookmarks': 'bookmarks'
        };
        
        const activeRoute = routeMap[baseRoute] || null;
        
        // Update mobile bottom nav
        const mobileNav = document.getElementById('mobile-bottom-nav');
        if (mobileNav) {
            mobileNav.querySelectorAll('.mobile-nav-item').forEach(item => {
                const itemRoute = item.getAttribute('data-route');
                if (itemRoute === activeRoute) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
        }
        
        // Also update header section nav for consistency
        document.querySelectorAll('.section-nav-btn').forEach(btn => {
            const btnRoute = btn.getAttribute('data-route');
            if (btnRoute === activeRoute) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    setupMobileMoreMenu() {
        const moreBtn = document.getElementById('mobile-more-btn');
        const moreMenu = document.getElementById('mobile-more-menu');
        const moreClose = document.getElementById('mobile-more-close');
        const backdrop = moreMenu?.querySelector('.mobile-more-menu-backdrop');
        
        if (!moreBtn || !moreMenu) return;
        
        // Toggle more menu
        moreBtn.addEventListener('click', () => {
            moreMenu.classList.toggle('active');
        });
        
        // Close more menu
        const closeMoreMenu = () => {
            moreMenu.classList.remove('active');
        };
        
        moreClose?.addEventListener('click', closeMoreMenu);
        backdrop?.addEventListener('click', closeMoreMenu);
        
        // Handle menu item clicks
        const createBtn = document.getElementById('mobile-create-btn');
        const exportBtn = document.getElementById('mobile-export-btn');
        const importBtn = document.getElementById('mobile-import-btn');
        const blueskyBtn = document.getElementById('mobile-bluesky-btn');
        
        createBtn?.addEventListener('click', () => {
            closeMoreMenu();
            this.openCreateModal();
        });
        
        exportBtn?.addEventListener('click', () => {
            closeMoreMenu();
            this.exportJSON();
        });
        
        importBtn?.addEventListener('click', () => {
            closeMoreMenu();
            this.openImportModal();
        });
        
        blueskyBtn?.addEventListener('click', () => {
            closeMoreMenu();
            this.openBlueskyModal();
        });
        
        // Close menu when navigating via links
        moreMenu.querySelectorAll('a[data-route]').forEach(link => {
            link.addEventListener('click', () => {
                closeMoreMenu();
            });
        });
    }
    
    scrollToMainContent() {
        // Close any open sidebars on mobile when navigating
        if (window.innerWidth <= 480) {
            this.closeMobileSidebars();
        }
    }
    
    setupMobileSidebars() {
        // Use viewport width check: 480px = 30vw at 1600px base, or check directly
        if (window.innerWidth > 480) return; // Keep pixel check for very small screens
        
        const leftSidebar = document.querySelector('.mw-sidebar');
        const rightSidebar = document.querySelector('.mw-sidebar-right');
        const backdrop = document.getElementById('sidebar-backdrop');
        
        if (!leftSidebar || !rightSidebar || !backdrop) return;
        
        // Touch tracking
        let touchStartX = 0;
        let touchStartY = 0;
        let touchCurrentX = 0;
        let isSwiping = false;
        const edgeThreshold = 30; // pixels from edge to start swipe
        const swipeThreshold = 50; // minimum swipe distance
        
        // Detect edge swipe start
        document.addEventListener('touchstart', (e) => {
            if (window.innerWidth > 480) return; // Keep pixel check for very small screens
            
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchCurrentX = touchStartX;
            
            // Check if starting from edge
            const isLeftEdge = touchStartX < edgeThreshold;
            const isRightEdge = touchStartX > window.innerWidth - edgeThreshold;
            
            if (isLeftEdge || isRightEdge) {
                isSwiping = true;
            }
        }, { passive: true });
        
        document.addEventListener('touchmove', (e) => {
            if (!isSwiping || window.innerWidth > 480) return; // Keep pixel check for very small screens
            
            const touch = e.touches[0];
            touchCurrentX = touch.clientX;
        }, { passive: true });
        
        document.addEventListener('touchend', (e) => {
            if (!isSwiping || window.innerWidth > 480) {
                isSwiping = false;
                return;
            }
            
            const swipeDistance = touchCurrentX - touchStartX;
            const isLeftEdgeSwipe = touchStartX < edgeThreshold && swipeDistance > swipeThreshold;
            const isRightEdgeSwipe = touchStartX > window.innerWidth - edgeThreshold && swipeDistance < -swipeThreshold;
            
            if (isLeftEdgeSwipe) {
                this.openLeftSidebar();
            } else if (isRightEdgeSwipe) {
                this.openRightSidebar();
            }
            
            isSwiping = false;
        }, { passive: true });
        
        // Click on peek tabs (edges of screen) to open sidebars
        document.addEventListener('click', (e) => {
            if (window.innerWidth > 480) return;
            
            // Don't open if a sidebar is already open
            if (leftSidebar.classList.contains('sidebar-open') || rightSidebar.classList.contains('sidebar-open')) {
                return;
            }
            
            // Check if click is on left edge (peek tab area)
            if (e.clientX < 30) {
                e.preventDefault();
                this.openLeftSidebar();
            }
            // Check if click is on right edge (peek tab area)
            else if (e.clientX > window.innerWidth - 30) {
                e.preventDefault();
                this.openRightSidebar();
            }
        });
        
        // Close on backdrop click
        backdrop.addEventListener('click', () => {
            this.closeMobileSidebars();
        });
        
        // Swipe to close open sidebar
        leftSidebar.addEventListener('touchstart', (e) => {
            if (!leftSidebar.classList.contains('sidebar-open')) return;
            touchStartX = e.touches[0].clientX;
        }, { passive: true });
        
        leftSidebar.addEventListener('touchend', (e) => {
            if (!leftSidebar.classList.contains('sidebar-open')) return;
            const swipeDistance = e.changedTouches[0].clientX - touchStartX;
            if (swipeDistance < -swipeThreshold) {
                this.closeMobileSidebars();
            }
        }, { passive: true });
        
        rightSidebar.addEventListener('touchstart', (e) => {
            if (!rightSidebar.classList.contains('sidebar-open')) return;
            touchStartX = e.touches[0].clientX;
        }, { passive: true });
        
        rightSidebar.addEventListener('touchend', (e) => {
            if (!rightSidebar.classList.contains('sidebar-open')) return;
            const swipeDistance = e.changedTouches[0].clientX - touchStartX;
            if (swipeDistance > swipeThreshold) {
                this.closeMobileSidebars();
            }
        }, { passive: true });
    }
    
    openLeftSidebar() {
        const leftSidebar = document.querySelector('.mw-sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        leftSidebar?.classList.add('sidebar-open');
        backdrop?.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
    
    openRightSidebar() {
        const rightSidebar = document.querySelector('.mw-sidebar-right');
        const backdrop = document.getElementById('sidebar-backdrop');
        rightSidebar?.classList.add('sidebar-open');
        backdrop?.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
    
    closeMobileSidebars() {
        const leftSidebar = document.querySelector('.mw-sidebar');
        const rightSidebar = document.querySelector('.mw-sidebar-right');
        const backdrop = document.getElementById('sidebar-backdrop');
        leftSidebar?.classList.remove('sidebar-open');
        rightSidebar?.classList.remove('sidebar-open');
        backdrop?.classList.remove('active');
        document.body.style.overflow = '';
    }
    

    navigateFromBento(route, event) {
        // Check if click target is an interactive element (link, button, input, etc.)
        if (event && event.target) {
            const isInteractive = event.target.closest('a, button, input, select, textarea, label[for]');
            if (isInteractive) {
                // Don't navigate - let the interactive element handle the click
                return;
            }
        }
        this.navigate(route);
    }

    async handleRoute(forceRoute = null) {
        // Get route from hash (works with file:// protocol)
        // This enables deep linking - URLs like index.html#article-name will work
        // If forceRoute is provided, use it instead (for immediate navigation)
        // This ensures navigation works even if hash hasn't updated yet
        let hash = forceRoute !== null ? forceRoute : window.location.hash.replace(/^#/, '');
        
        // Handle section anchors (e.g., #article-name#section-name)
        let articleKey = hash;
        let sectionId = null;
        if (hash.includes('#')) {
            const parts = hash.split('#');
            articleKey = parts[0];
            sectionId = parts[1];
        }
        
        // Only default to main if there's truly no hash (empty string or just #)
        // If hash exists, preserve it for deep linking
        if (!hash || hash === '') {
            hash = 'main';
            articleKey = 'main';
            // Only set hash if it's not already set (preserve deep links)
            if (!window.location.hash || window.location.hash === '') {
                window.history.replaceState(null, '', '#main');
            }
        }

        console.log('Handling route:', hash, 'article:', articleKey, 'section:', sectionId);
        
        // Update mobile nav active state
        this.updateMobileNavActiveState(articleKey);

        // Check for special routes first
        if (articleKey === 'articles') {
            await this.showArticleList();
        } else if (articleKey === 'bookmarks') {
            await this.showBookmarks();
        } else if (articleKey === 'archive' || articleKey === 'collection') {
            await this.showCollectionPage();
        } else if (articleKey === 'browse') {
            await this.showBrowsePage();
        } else if (articleKey === 'habits') {
            this.showHabitsPage();
        } else if (articleKey === 'main') {
            await this.showArticle('main', sectionId);
        } else {
            // Regular article route - this enables deep linking to any article
            await this.showArticle(articleKey, sectionId);
        }
    }

    renderSectionNav() {
        // Section nav is now in the header, so return empty string to avoid duplication
        return '';
    }

    async navigateAlbumImage(albumId, direction) {
        const albumIndexKey = `album-${albumId}-index`;
        const archive = this.storage.getArchive();
        const albumItems = archive.filter(item => {
            const itemAlbums = item.albumIds || (item.albumId ? [item.albumId] : []);
            return itemAlbums.includes(albumId);
        });
        
        if (albumItems.length === 0) return;
        
        const currentIndex = parseInt(localStorage.getItem(albumIndexKey) || '0', 10);
        let newIndex = currentIndex + direction;
        
        // Wrap around
        if (newIndex < 0) newIndex = albumItems.length - 1;
        if (newIndex >= albumItems.length) newIndex = 0;
        
        localStorage.setItem(albumIndexKey, newIndex.toString());
        
        // Refresh the bento grid by re-rendering the main page
        if (this.currentArticleKey === 'main') {
            await this.showArticle('main');
        }
    }

    async showArticle(key, sectionId = null) {
        try {
            this.currentArticleKey = key;
            
            // Reload articles to ensure we have latest
            await this.loadArticles();
            
            const article = this.articles[key] || await this.storage.getArticle(key);

            const container = document.getElementById('article-container');
            if (!container) {
                console.error('article-container element not found!');
                // Try to show error message in body if container doesn't exist
                document.body.innerHTML = '<div style="padding: 2em; font-family: sans-serif;"><h1>Error</h1><p>Article container not found. Please refresh the page.</p></div>';
                return;
            }

        if (!article) {
            // If it's the main page and doesn't exist, create a helpful default one
            if (key === 'main') {
                const articleCount = Object.keys(this.articles).length;
                const bookmarks = this.storage.getBookmarks();
                const bookmarkedArticles = bookmarks
                    .filter(bKey => this.articles[bKey])
                    .map(bKey => {
                        const art = this.articles[bKey];
                        return `<a href="#${bKey}" data-route="${bKey}">${art.title}</a>`;
                    })
                    .join(', ');

                // Load webcomic pages
                await this.loadWebcomicPages();
                const webcomicHtml = this.renderWebcomicSection();
                
                // Get section order from storage or use default
                // Get section order and migrate old 'archive' to 'collections'
                let sectionOrder = this.storage.getSectionOrder();
                if (sectionOrder && sectionOrder.includes('archive') && !sectionOrder.includes('collections')) {
                    sectionOrder = sectionOrder.map(s => s === 'archive' ? 'collections' : s);
                    this.storage.saveSectionOrder(sectionOrder);
                }
                sectionOrder = sectionOrder || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
                
                // Get random article preview for articles bento
                const articleKeys = Object.keys(this.articles).filter(k => k !== 'main');
                let randomPreview = '';
                let suggestionHtml = '';
                if (articleKeys.length > 0) {
                    const randomKey = articleKeys[Math.floor(Math.random() * articleKeys.length)];
                    const randomArticle = this.articles[randomKey];
                    const previewText = randomArticle.content.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/<[^>]+>/g, '').slice(0, 100);
                    randomPreview = `<div class="bento-preview"><strong>${randomArticle.title}</strong><p>${previewText}...</p></div>`;
                }
                
                // Suggestions based on content
                const suggestions = [];
                if (articleKeys.length < 3) suggestions.push('Create more articles to build your knowledge base');
                if (!this.storage.getBookmarks().length) suggestions.push('Bookmark articles for quick access');
                if (!this.storage.getArchive().length) suggestions.push('Add images to your artboards');
                if (!this.storage.getHabits().length) suggestions.push('Set up habits to track daily goals');
                if (suggestions.length > 0) {
                    suggestionHtml = `<div class="bento-suggestions"><span class="suggestion-label">Try:</span> ${suggestions[0]}</div>`;
                }
                
                // Get saved bento sizes early so we can use them
                const bentoSizes = this.storage.getBentoSizes();
                // Migrate old 'archive' key to 'collections' if it exists
                if (bentoSizes['archive'] && !bentoSizes['collections']) {
                    bentoSizes['collections'] = bentoSizes['archive'];
                    delete bentoSizes['archive'];
                    this.storage.saveBentoSize('collections', bentoSizes['collections']);
                }
                // Ensure collections section defaults to 3 columns and square if not set
                if (!bentoSizes['collections']) {
                    bentoSizes['collections'] = { cols: 3, rows: 3 };
                } else if (bentoSizes['collections']) {
                    // Ensure collections is always square (rows = cols)
                    bentoSizes['collections'].rows = bentoSizes['collections'].cols || 3;
                }
                
                const collectionsPreview = this.renderCaptures(true, bentoSizes['collections']);
                const habitsPreview = this.renderHabitsBento();
                const editIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
                const deleteIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
                const addIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
                const dragHandleSvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
                
                // Minimalist size icons - simple squares
                const sizeSmallIcon = `<svg viewBox="0 0 8 8" width="6" height="6"><rect x="2" y="2" width="4" height="4" fill="currentColor"/></svg>`;
                const sizeMediumIcon = `<svg viewBox="0 0 8 8" width="8" height="8"><rect x="1" y="1" width="6" height="6" fill="currentColor"/></svg>`;
                const sizeLargeIcon = `<svg viewBox="0 0 8 8" width="10" height="10"><rect x="0" y="0" width="8" height="8" fill="currentColor"/></svg>`;
                
                // Arrow icons for moving bentos
                const arrowLeftIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M15 18l-6-6 6-6"/></svg>`;
                const arrowRightIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>`;
                const arrowUpIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 15l-6-6-6 6"/></svg>`;
                const arrowDownIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M6 9l6 6 6-6"/></svg>`;
                
                // Helper function to generate controls HTML for a section (move buttons, size buttons, delete, edit)
                const getControlsHTML = (sectionName) => {
                    const currentSize = bentoSizes[sectionName] || (sectionName === 'collections' ? { cols: 3, rows: 3 } : { cols: 1, rows: 1 });
                    const currentCols = currentSize.cols || (sectionName === 'collections' ? 3 : 1);
                    return `
                        <div class="bento-move-controls" style="display: none;">
                            <button class="move-btn" onclick="window.wikiApp.moveBentoPosition('${sectionName}', 'up'); event.stopPropagation();" title="Move up">${arrowUpIcon}</button>
                            <button class="move-btn" onclick="window.wikiApp.moveBentoPosition('${sectionName}', 'down'); event.stopPropagation();" title="Move down">${arrowDownIcon}</button>
                            <button class="move-btn" onclick="window.wikiApp.moveBentoPosition('${sectionName}', 'left'); event.stopPropagation();" title="Move left">${arrowLeftIcon}</button>
                            <button class="move-btn" onclick="window.wikiApp.moveBentoPosition('${sectionName}', 'right'); event.stopPropagation();" title="Move right">${arrowRightIcon}</button>
                        </div>
                        <button class="bento-edit-btn" onclick="window.wikiApp.toggleBentoEdit('${sectionName}', event)" title="Edit bento">${editIconSvg}</button>
                        <div class="bento-delete-resize-wrapper" style="display: none;">
                            <button class="bento-delete-btn" onclick="window.wikiApp.deleteBento('${sectionName}', event)" title="Delete bento">${deleteIconSvg}</button>
                            <div class="bento-size-controls">
                                <button class="size-btn ${currentCols === 1 ? 'active' : ''}" onclick="window.wikiApp.setBentoSize('${sectionName}', 1); event.stopPropagation();">${sizeSmallIcon}</button>
                                <button class="size-btn ${currentCols === 2 ? 'active' : ''}" onclick="window.wikiApp.setBentoSize('${sectionName}', 2); event.stopPropagation();">${sizeMediumIcon}</button>
                                <button class="size-btn ${currentCols === 3 ? 'active' : ''}" onclick="window.wikiApp.setBentoSize('${sectionName}', 3); event.stopPropagation();">${sizeLargeIcon}</button>
                            </div>
                        </div>
                    `;
                };
                
                // Helper function to apply saved size to a section
                const applyBentoSize = (sectionName, content) => {
                    const size = bentoSizes[sectionName];
                    if (size) {
                        // For collections section, ensure it's square (rows = cols)
                        const cols = size.cols || (sectionName === 'collections' ? 3 : 1);
                        const rows = sectionName === 'collections' ? cols : (size.rows || 1);
                        const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                        const sizeClass = `bento-size-${cols}`;
                        return content.replace('draggable-section', `draggable-section ${sizeClass} ${style}`);
                    } else if (sectionName === 'collections') {
                        // If no saved size, collections defaults to 3 columns
                        const style = `style="grid-column: span 3; grid-row: span 3;"`;
                        return content.replace('draggable-section', `draggable-section bento-size-3 ${style}`);
                    }
                    return content;
                };
                
                // Build section content
                const sections = {
                    welcome: `
                        <div class="bento-card bento-welcome draggable-section" data-section="welcome">
                            <div class="bento-controls-wrapper">
                                ${getControlsHTML('welcome')}
                            </div>
                            <h2>Welcome to XoxoWiki</h2>
                            <p>Your personal wiki that works completely offline. Create articles, link them together, and build your own knowledge base.</p>
                            <div class="bento-tips">
                                <span class="tip">Use <code>[[links]]</code></span>
                                <span class="tip">Bookmark articles</span>
                                <span class="tip">Remix content</span>
                            </div>
                        </div>
                    `,
                    articles: `
                        <div class="bento-card bento-articles bento-clickable draggable-section" data-section="articles" onclick="window.wikiApp.navigateFromBento('articles', event)">
                            <div class="bento-controls-wrapper">
                                ${getControlsHTML('articles')}
                            </div>
                            <div class="bento-header">
                                <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>Articles</h3>
                            </div>
                            ${randomPreview || '<p class="bento-empty">No articles yet</p>'}
                            ${suggestionHtml}
                        </div>
                    `,
                    bookmarks: `
                        <div class="bento-card bento-bookmarks bento-clickable draggable-section" data-section="bookmarks" onclick="window.wikiApp.navigateFromBento('bookmarks', event)">
                            <div class="bento-controls-wrapper">
                                ${getControlsHTML('bookmarks')}
                            </div>
                            <div class="bento-header">
                                <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>Bookmarks</h3>
                            </div>
                            ${bookmarkedArticles ? `<div class="bento-content">${bookmarkedArticles}</div>` : '<p class="bento-empty">No bookmarks yet</p>'}
                        </div>
                    `,
                    collections: `
                        <div class="bento-card bento-collections bento-clickable draggable-section" data-section="collections" onclick="window.wikiApp.navigateFromBento('collection', event)">
                            <div class="bento-controls-wrapper">
                                ${getControlsHTML('collections')}
                            </div>
                            <div class="bento-header">
                                <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>Artboards</h3>
                            </div>
                            ${collectionsPreview}
                        </div>
                    `,
                    habits: `
                        <div class="bento-card bento-habits bento-clickable draggable-section" data-section="habits" onclick="window.wikiApp.navigateFromBento('habits', event)">
                            <div class="bento-controls-wrapper">
                                ${getControlsHTML('habits')}
                            </div>
                            <div class="bento-header">
                                <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>Habits</h3>
                            </div>
                            ${habitsPreview || '<p class="bento-empty">No habits yet. Click to add your first habit!</p>'}
                        </div>
                    `,
                    webcomic: `
                        <div class="bento-card bento-webcomic bento-wide draggable-section" data-section="webcomic">
                            <div class="bento-controls-wrapper">
                                ${getControlsHTML('webcomic')}
                            </div>
                            ${webcomicHtml}
                        </div>
                    `
                };
                
                // Render sections in order and apply saved sizes
                const sectionsHtml = sectionOrder.map(s => {
                    // Handle article-specific sections
                    if (s.startsWith('article:')) {
                        const articleKey = s.split(':')[1];
                        const article = this.articles[articleKey];
                        if (!article) return ''; // Article was deleted
                        
                        const title = article.title || articleKey;
                        const content = article.content || '';
                        const preview = content.substring(0, 200).replace(/<[^>]*>/g, '');
                        
                        let articleHtml = `
                            <div class="bento-card bento-article bento-clickable draggable-section" data-section="${s}" data-article-key="${articleKey}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.showArticle('${articleKey}'); }">
                                <div class="bento-controls-wrapper">
                                    ${getControlsHTML(s)}
                                </div>
                                <div class="bento-header">
                                    <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>${title}</h3>
                                </div>
                                ${preview ? `<div class="bento-content"><p>${preview}${content.length > 200 ? '...' : ''}</p></div>` : '<p class="bento-empty">No content</p>'}
                            </div>
                        `;
                        
                        // Add moved class and edit mode if this section was moved
                        const isMoved = this.movedBentoSection === s;
                        const shouldRestoreEdit = this.bentoToRestoreEditMode === s;
                        
                        if (isMoved) {
                            // Add classes to the draggable-section div
                            articleHtml = articleHtml.replace(
                                /(<div[^>]*class="[^"]*draggable-section[^"]*)([^>]*>)/,
                                `$1${isMoved ? ' bento-moved' : ''}${shouldRestoreEdit ? ' bento-editing' : ''}$2`
                            );
                            
                            if (shouldRestoreEdit) {
                                // Show move controls
                                articleHtml = articleHtml.replace(
                                    /<div class="bento-move-controls" style="display: none;">/g,
                                    '<div class="bento-move-controls" style="display: flex;">'
                                );
                                // Show delete/resize wrapper
                                articleHtml = articleHtml.replace(
                                    /<div class="bento-delete-resize-wrapper" style="display: none;">/g,
                                    '<div class="bento-delete-resize-wrapper" style="display: flex;">'
                                );
                                // Make controls wrapper visible
                                articleHtml = articleHtml.replace(
                                    /<div class="bento-controls-wrapper">/g,
                                    '<div class="bento-controls-wrapper" style="opacity: 1;">'
                                );
                            }
                        }
                        
                        // Apply size if set
                        const size = bentoSizes[s];
                        if (size) {
                            const cols = size.cols || 1;
                            const rows = size.rows || 1;
                            const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                            const sizeClass = `bento-size-${cols}`;
                            articleHtml = articleHtml.replace(
                                /(<div[^>]*draggable-section[^>]*)(>)/,
                                `$1 ${sizeClass} ${style}$2`
                            );
                        }
                        return articleHtml;
                    }
                    
                    // Handle media-specific sections
                    if (s.startsWith('media:')) {
                        const mediaId = s.split(':')[1];
                        const archive = this.storage.getArchive();
                        const mediaItem = archive.find(item => item.id === mediaId);
                        if (!mediaItem) return ''; // Media was deleted
                        
                        const name = mediaItem.name || 'Untitled';
                        const truncatedName = name.length > 22 ? name.substring(0, 22) + '...' : name;
                        const mediaHtml = mediaItem.type === 'video'
                            ? `<video data-media-id="${mediaId}" class="bento-media-content" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                            : `<img data-media-id="${mediaId}" alt="${name}" class="bento-media-content" style="background: #f0f0f0;">`;
                        
                        // Load image/video asynchronously
                        setTimeout(() => {
                            this.loadArchiveItemImage(mediaItem).then(result => {
                                const { imageData, videoUrl } = this._archiveMediaFromResult(result, mediaItem);
                                const wrapper = document.querySelector(`.bento-card[data-media-id="${mediaId}"]`);
                                if (!wrapper) return;
                                if (mediaItem.type === 'video') {
                                    const videoEl = wrapper.querySelector('video');
                                    if (videoEl) {
                                        const src = videoUrl || imageData;
                                        if (src) videoEl.src = src;
                                        if (imageData) videoEl.poster = imageData;
                                    }
                                } else {
                                    const imgEl = wrapper.querySelector('img');
                                    if (imgEl && imageData) imgEl.src = imageData;
                                }
                            });
                        }, 100);
                        
                        let mediaBentoHtml = `
                            <div class="bento-card bento-media bento-clickable draggable-section" data-section="${s}" data-media-id="${mediaId}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.viewArchiveItemPage('${mediaId}'); }">
                                <div class="bento-controls-wrapper">
                                    ${getControlsHTML(s)}
                                </div>
                                <div class="bento-media-wrapper">
                                    ${mediaHtml}
                                </div>
                                <div class="bento-header">
                                    <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span class="bento-title-text" title="${name}">${truncatedName}</span></h3>
                                </div>
                            </div>
                        `;
                        
                        // Add moved class and edit mode if this section was moved
                        const isMoved = this.movedBentoSection === s;
                        const shouldRestoreEdit = this.bentoToRestoreEditMode === s;
                        
                        if (isMoved) {
                            // Add classes to the draggable-section div
                            mediaBentoHtml = mediaBentoHtml.replace(
                                /(<div[^>]*class="[^"]*draggable-section[^"]*)([^>]*>)/,
                                `$1${isMoved ? ' bento-moved' : ''}${shouldRestoreEdit ? ' bento-editing' : ''}$2`
                            );
                            
                            if (shouldRestoreEdit) {
                                // Show move controls
                                mediaBentoHtml = mediaBentoHtml.replace(
                                    /<div class="bento-move-controls" style="display: none;">/g,
                                    '<div class="bento-move-controls" style="display: flex;">'
                                );
                                // Show delete/resize wrapper
                                mediaBentoHtml = mediaBentoHtml.replace(
                                    /<div class="bento-delete-resize-wrapper" style="display: none;">/g,
                                    '<div class="bento-delete-resize-wrapper" style="display: flex;">'
                                );
                                // Make controls wrapper visible
                                mediaBentoHtml = mediaBentoHtml.replace(
                                    /<div class="bento-controls-wrapper">/g,
                                    '<div class="bento-controls-wrapper" style="opacity: 1;">'
                                );
                            }
                        }
                        
                        // Apply size if set
                        const size = bentoSizes[s];
                        if (size) {
                            const cols = size.cols || 1;
                            const rows = size.rows || 1;
                            const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                            const sizeClass = `bento-size-${cols}`;
                            mediaBentoHtml = mediaBentoHtml.replace(
                                /(<div[^>]*draggable-section[^>]*)(>)/,
                                `$1 ${sizeClass} ${style}$2`
                            );
                        }
                        return mediaBentoHtml;
                    }
                    
                    // Handle album-specific sections
                    if (s.startsWith('album:')) {
                        const albumId = s.split(':')[1];
                        const album = this.storage.getAlbums().find(a => a.id === albumId);
                        if (!album) return ''; // Album was deleted
                        
                        const archive = this.storage.getArchive();
                        const albumItems = archive.filter(item => {
                            const itemAlbums = item.albumIds || (item.albumId ? [item.albumId] : []);
                            return itemAlbums.includes(albumId);
                        });
                        
                        // Pick a random image from the collection on refresh (or use stored index)
                        let imageHtml = '';
                        let navArrows = '';
                        if (albumItems.length > 0) {
                            // Use the same key format as navigateAlbumImage for consistency
                            const albumIndexKey = `album-${albumId}-index`;
                            let storedIndex = localStorage.getItem(albumIndexKey);
                            if (storedIndex === null || parseInt(storedIndex) >= albumItems.length || parseInt(storedIndex) < 0) {
                                // Generate new random index and store it (only if not already set)
                                storedIndex = Math.floor(Math.random() * albumItems.length).toString();
                                localStorage.setItem(albumIndexKey, storedIndex);
                            }
                            const randomIndex = parseInt(storedIndex);
                            const currentItem = albumItems[randomIndex];
                            const itemId = currentItem.id;
                            imageHtml = currentItem.type === 'video'
                                ? `<video data-album-item-id="${itemId}" class="bento-album-featured-image" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                                : `<img data-album-item-id="${itemId}" alt="${currentItem.name || 'Image'}" class="bento-album-featured-image" style="background: #f0f0f0;">`;
                            
                            // Load image/video asynchronously
                            setTimeout(() => {
                                this.loadArchiveItemImage(currentItem).then(result => {
                                    const { imageData, videoUrl } = this._archiveMediaFromResult(result, currentItem);
                                    const el = document.querySelector(`[data-album-item-id="${itemId}"]`);
                                    if (!el) return;
                                    if (currentItem.type === 'video') {
                                        const src = videoUrl || imageData;
                                        if (src) el.src = src;
                                        if (imageData) el.poster = imageData;
                                    } else if (imageData) {
                                        el.src = imageData;
                                    }
                                });
                            }, 100);
                            
                            if (albumItems.length > 1) {
                                navArrows = `
                                    <button class="bento-album-nav-arrow bento-album-nav-left" onclick="event.stopPropagation(); window.wikiApp.navigateAlbumImage('${albumId}', -1);" aria-label="Previous">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="15 18 9 12 15 6"></polyline>
                                        </svg>
                                    </button>
                                    <button class="bento-album-nav-arrow bento-album-nav-right" onclick="event.stopPropagation(); window.wikiApp.navigateAlbumImage('${albumId}', 1);" aria-label="Next">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="9 18 15 12 9 6"></polyline>
                                        </svg>
                                    </button>
                                `;
                            }
                        }
                        
                        // Add moved class and edit mode if this section was moved
                        const isMoved = this.movedBentoSection === s;
                        const shouldRestoreEdit = this.bentoToRestoreEditMode === s;
                        const extraClasses = (isMoved ? ' bento-moved' : '') + (shouldRestoreEdit ? ' bento-editing' : '');
                        const controlsHtml = shouldRestoreEdit 
                            ? getControlsHTML(s).replace(/style="display: none;"/g, 'style="display: flex;"')
                            : getControlsHTML(s);
                        const controlsWrapperStyle = shouldRestoreEdit ? ' style="opacity: 1;"' : '';
                        
                        let albumHtml = `
                            <div class="bento-card bento-album bento-clickable draggable-section${extraClasses}" data-section="${s}" data-album-id="${albumId}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.filterCollectionByAlbum('${albumId}'); }">
                                <div class="bento-controls-wrapper"${controlsWrapperStyle}>
                                    ${controlsHtml}
                                </div>
                                <div class="bento-header">
                                    <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>${album.name}</h3>
                                </div>
                                ${albumItems.length > 0 
                                    ? `<div class="bento-album-featured">${imageHtml}${navArrows}</div>`
                                    : '<p class="bento-empty">No items yet</p>'}
                            </div>
                        `;
                        
                        const size = bentoSizes[s];
                        if (size) {
                            // For album sections, ensure they're square (rows = cols)
                            const cols = size.cols || 1;
                            const rows = cols; // Always square for album sections
                            const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                            const sizeClass = `bento-size-${cols}`;
                            albumHtml = albumHtml.replace(
                                /(<div[^>]*draggable-section[^>]*)(>)/,
                                `$1 ${sizeClass} ${style}$2`
                            );
                        }
                        return albumHtml;
                    }
                    
                    // Handle random bentos - pick a random item on each refresh
                    if (s.startsWith('random:')) {
                        const randomType = s.split(':')[1];
                        let randomHtml = '';
                        
                        if (randomType === 'articles') {
                            const articleKeys = Object.keys(this.articles).filter(k => k !== 'main');
                            if (articleKeys.length === 0) return '';
                            const randomKey = articleKeys[Math.floor(Math.random() * articleKeys.length)];
                            const article = this.articles[randomKey];
                            const title = article?.title || randomKey;
                            const content = article?.content || '';
                            const preview = content.substring(0, 200).replace(/<[^>]*>/g, '');
                            
                            randomHtml = `
                                <div class="bento-card bento-article bento-clickable draggable-section" data-section="${s}" data-article-key="${randomKey}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.showArticle('${randomKey}'); }">
                                    <div class="bento-controls-wrapper">
                                        ${getControlsHTML(s)}
                                    </div>
                                    <div class="bento-header">
                                        <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>${title}</h3>
                                    </div>
                                    ${preview ? `<div class="bento-content"><p>${preview}${content.length > 200 ? '...' : ''}</p></div>` : '<p class="bento-empty">No content</p>'}
                                </div>
                            `;
                        } else if (randomType === 'collections') {
                            const albums = this.storage.getAlbums();
                            if (albums.length === 0) return '';
                            const randomAlbum = albums[Math.floor(Math.random() * albums.length)];
                            const archive = this.storage.getArchive();
                            const albumItems = archive.filter(item => {
                                const itemAlbums = item.albumIds || (item.albumId ? [item.albumId] : []);
                                return itemAlbums.includes(randomAlbum.id);
                            });
                            
                            let imageHtml = '';
                            let randomItem = null;
                            if (albumItems.length > 0) {
                                randomItem = albumItems[Math.floor(Math.random() * albumItems.length)];
                                const itemId = randomItem.id;
                                imageHtml = randomItem.type === 'video'
                                    ? `<video data-random-album-item-id="${itemId}" class="bento-album-featured-image" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                                    : `<img data-random-album-item-id="${itemId}" alt="${randomItem.name || 'Image'}" class="bento-album-featured-image" style="background: #f0f0f0;">`;
                                
                                // Load image/video asynchronously
                                setTimeout(() => {
                                    this.loadArchiveItemImage(randomItem).then(result => {
                                        const { imageData, videoUrl } = this._archiveMediaFromResult(result, randomItem);
                                        const videoEl = document.querySelector(`[data-random-album-item-id="${itemId}"]`);
                                        if (!videoEl) return;
                                        if (randomItem.type === 'video') {
                                            const src = videoUrl || imageData;
                                            if (src) videoEl.src = src;
                                            if (imageData) videoEl.poster = imageData;
                                        } else if (imageData) {
                                            videoEl.src = imageData;
                                        }
                                    });
                                }, 100);
                            }
                            
                            randomHtml = `
                                <div class="bento-card bento-album bento-clickable draggable-section" data-section="${s}" data-album-id="${randomAlbum.id}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.filterCollectionByAlbum('${randomAlbum.id}'); }">
                                    <div class="bento-controls-wrapper">
                                        ${getControlsHTML(s)}
                                    </div>
                                    <div class="bento-header">
                                        <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>${randomAlbum.name}</h3>
                                    </div>
                                    ${imageHtml ? `<div class="bento-album-featured">${imageHtml}</div>` : '<p class="bento-empty">No items yet</p>'}
                                </div>
                            `;
                        } else if (randomType === 'media') {
                            const archive = this.storage.getArchive();
                            if (archive.length === 0) return '';
                            const randomItem = archive[Math.floor(Math.random() * archive.length)];
                            const name = randomItem.name || 'Untitled';
                            const truncatedName = name.length > 22 ? name.substring(0, 22) + '...' : name;
                            const itemId = randomItem.id;
                            const mediaHtml = randomItem.type === 'video'
                                ? `<video data-random-media-id="${itemId}" class="bento-media-content" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                                : `<img data-random-media-id="${itemId}" alt="${name}" class="bento-media-content" style="background: #f0f0f0;">`;
                            
                            // Load image/video asynchronously
                            setTimeout(() => {
                                this.loadArchiveItemImage(randomItem).then(result => {
                                    const { imageData, videoUrl } = this._archiveMediaFromResult(result, randomItem);
                                    const wrapper = document.querySelector(`.bento-card[data-media-id="${randomItem.id}"]`);
                                    if (!wrapper) return;
                                    if (randomItem.type === 'video') {
                                        const videoEl = wrapper.querySelector('video');
                                        if (videoEl) {
                                            const src = videoUrl || imageData;
                                            if (src) videoEl.src = src;
                                            if (imageData) videoEl.poster = imageData;
                                        }
                                    } else {
                                        const imgEl = wrapper.querySelector('img');
                                        if (imgEl && imageData) imgEl.src = imageData;
                                    }
                                });
                            }, 100);
                            
                            randomHtml = `
                                <div class="bento-card bento-media bento-clickable draggable-section" data-section="${s}" data-media-id="${randomItem.id}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.viewArchiveItemPage('${randomItem.id}'); }">
                                    <div class="bento-controls-wrapper">
                                        ${getControlsHTML(s)}
                                    </div>
                                    <div class="bento-media-wrapper">
                                        ${mediaHtml}
                                    </div>
                                    <div class="bento-header">
                                        <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span class="bento-title-text" title="${name}">${truncatedName}</span></h3>
                                    </div>
                                </div>
                            `;
                        } else if (randomType === 'bookmarks') {
                            const bookmarks = this.storage.getBookmarks();
                            const availableBookmarks = bookmarks.filter(key => this.articles[key]);
                            if (availableBookmarks.length === 0) return '';
                            const randomKey = availableBookmarks[Math.floor(Math.random() * availableBookmarks.length)];
                            const article = this.articles[randomKey];
                            const title = article?.title || randomKey;
                            const content = article?.content || '';
                            const preview = content.substring(0, 200).replace(/<[^>]*>/g, '');
                            
                            randomHtml = `
                                <div class="bento-card bento-article bento-clickable draggable-section" data-section="${s}" data-article-key="${randomKey}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.showArticle('${randomKey}'); }">
                                    <div class="bento-controls-wrapper">
                                        ${getControlsHTML(s)}
                                    </div>
                                    <div class="bento-header">
                                        <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>${title}</h3>
                                    </div>
                                    ${preview ? `<div class="bento-content"><p>${preview}${content.length > 200 ? '...' : ''}</p></div>` : '<p class="bento-empty">No content</p>'}
                                </div>
                            `;
                        } else if (randomType === 'habits') {
                            const habits = this.storage.getHabits();
                            if (habits.length === 0) return '';
                            const randomHabit = habits[Math.floor(Math.random() * habits.length)];
                            const log = this.storage.getHabitLog();
                            const today = new Date().toISOString().split('T')[0];
                            const checked = log[today] || [];
                            const isChecked = checked.includes(randomHabit);
                            
                            randomHtml = `
                                <div class="bento-card bento-habits draggable-section" data-section="${s}">
                                    <div class="bento-controls-wrapper">
                                        ${getControlsHTML(s)}
                                    </div>
                                    <div class="bento-header">
                                        <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>${randomHabit}</h3>
                                    </div>
                                    <div class="bento-content">
                                        <label class="habit-checkbox-label" style="display: flex; align-items: center; gap: 0.5em; cursor: pointer;">
                                            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="window.wikiApp.toggleHabit('${randomHabit}', this.checked)" style="width: 18px; height: 18px;">
                                            <span>Mark as done today</span>
                                        </label>
                                    </div>
                                </div>
                            `;
                        }
                        
                        if (!randomHtml) return '';
                        
                        // Apply intelligent default size based on type if not set
                        const size = bentoSizes[s];
                        let cols = 1;
                        let rows = 1;
                        
                        if (size) {
                            cols = size.cols || 1;
                            rows = size.rows || 1;
                        } else {
                            // Intelligent defaults based on type
                            if (randomType === 'media' || randomType === 'collections') {
                                cols = 2; // Media bentos default to medium size
                                rows = 2;
                            } else if (randomType === 'articles' || randomType === 'bookmarks') {
                                cols = 1; // Text bentos default to small
                                rows = 1;
                            } else if (randomType === 'habits') {
                                cols = 1;
                                rows = 1;
                            }
                        }
                        
                        const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                        const sizeClass = `bento-size-${cols}`;
                        randomHtml = randomHtml.replace(
                            /(<div[^>]*draggable-section[^>]*)(>)/,
                            `$1 ${sizeClass} ${style}$2`
                        );
                        return randomHtml;
                    }
                    
                    // Handle bookmark-specific sections
                    if (s.startsWith('bookmark:')) {
                        const bookmarkKey = s.split(':')[1];
                        const article = this.articles[bookmarkKey];
                        if (!article) return ''; // Article was deleted
                        
                        const title = article.title || bookmarkKey;
                        const content = article.content || '';
                        const preview = content.substring(0, 200).replace(/<[^>]*>/g, '');
                        
                        let bookmarkHtml = `
                            <div class="bento-card bento-article bento-clickable draggable-section" data-section="${s}" data-article-key="${bookmarkKey}" onclick="if (!window.wikiApp.wasDragged) { window.wikiApp.showArticle('${bookmarkKey}'); }">
                                <div class="bento-controls-wrapper">
                                    ${getControlsHTML(s)}
                                </div>
                                <div class="bento-header">
                                    <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>${title}</h3>
                                </div>
                                ${preview ? `<div class="bento-content"><p>${preview}${content.length > 200 ? '...' : ''}</p></div>` : '<p class="bento-empty">No content</p>'}
                            </div>
                        `;
                        
                        // Apply size if set
                        const size = bentoSizes[s];
                        if (size) {
                            const cols = size.cols || 1;
                            const rows = size.rows || 1;
                            const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                            const sizeClass = `bento-size-${cols}`;
                            bookmarkHtml = bookmarkHtml.replace(
                                /(<div[^>]*draggable-section[^>]*)(>)/,
                                `$1 ${sizeClass} ${style}$2`
                            );
                        }
                        return bookmarkHtml;
                    }
                    
                    // Handle habit-specific sections
                    if (s.startsWith('habit:')) {
                        const habitName = s.split(':')[1];
                        const habits = this.storage.getHabits();
                        if (!habits.includes(habitName)) return ''; // Habit was deleted
                        
                        const log = this.storage.getHabitLog();
                        const today = new Date().toISOString().split('T')[0];
                        const checked = log[today] || [];
                        const isChecked = checked.includes(habitName);
                        
                        let habitHtml = `
                            <div class="bento-card bento-habits draggable-section" data-section="${s}">
                                <div class="bento-controls-wrapper">
                                    ${getControlsHTML(s)}
                                </div>
                                <div class="bento-header">
                                    <h3><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>${habitName}</h3>
                                </div>
                                <div class="bento-content">
                                    <label class="habit-checkbox-label" style="display: flex; align-items: center; gap: 0.5em; cursor: pointer;">
                                        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="window.wikiApp.toggleHabit('${habitName}', this.checked)" style="width: 18px; height: 18px;">
                                        <span>Mark as done today</span>
                                    </label>
                                </div>
                            </div>
                        `;
                        
                        // Apply size if set
                        const size = bentoSizes[s];
                        if (size) {
                            const cols = size.cols || 1;
                            const rows = size.rows || 1;
                            const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                            const sizeClass = `bento-size-${cols}`;
                            habitHtml = habitHtml.replace(
                                /(<div[^>]*draggable-section[^>]*)(>)/,
                                `$1 ${sizeClass} ${style}$2`
                            );
                        }
                        return habitHtml;
                    }
                    
                    let sectionHtml = sections[s] || '';
                    if (!sectionHtml) return '';
                    
                    // Add moved class and edit mode if this section was moved
                    const isMoved = this.movedBentoSection === s;
                    const shouldRestoreEdit = this.bentoToRestoreEditMode === s;
                    
                    if (isMoved) {
                        // Add bento-moved class to the draggable-section div
                        sectionHtml = sectionHtml.replace(
                            /(<div[^>]*class="[^"]*draggable-section[^"]*)([^>]*>)/,
                            `$1${isMoved ? ' bento-moved' : ''}${shouldRestoreEdit ? ' bento-editing' : ''}$2`
                        );
                        
                        // If in edit mode, show controls and make wrapper visible
                        if (shouldRestoreEdit) {
                            // Show move controls
                            sectionHtml = sectionHtml.replace(
                                /<div class="bento-move-controls" style="display: none;">/g,
                                '<div class="bento-move-controls" style="display: flex;">'
                            );
                            // Show delete/resize wrapper
                            sectionHtml = sectionHtml.replace(
                                /<div class="bento-delete-resize-wrapper" style="display: none;">/g,
                                '<div class="bento-delete-resize-wrapper" style="display: flex;">'
                            );
                            // Make controls wrapper visible
                            sectionHtml = sectionHtml.replace(
                                /<div class="bento-controls-wrapper">/g,
                                '<div class="bento-controls-wrapper" style="opacity: 1;">'
                            );
                        }
                    }
                    
                    const size = bentoSizes[s];
                    if (size) {
                        // For collections section, ensure it's square (rows = cols)
                        const cols = size.cols || (s === 'collections' ? 3 : 1);
                        const rows = s === 'collections' ? cols : (size.rows || 1);
                        const style = `style="grid-column: span ${cols}; grid-row: span ${rows};"`;
                        const sizeClass = `bento-size-${cols}`;
                        // Insert style attribute and size class into the opening div tag
                        sectionHtml = sectionHtml.replace(
                            /(<div[^>]*draggable-section[^>]*)(>)/,
                            `$1 ${sizeClass} ${style}$2`
                        );
                    } else if (s === 'collections') {
                        // If no saved size, collections defaults to 3 columns
                        const style = `style="grid-column: span 3; grid-row: span 3;"`;
                        sectionHtml = sectionHtml.replace(
                            /(<div[^>]*draggable-section[^>]*)(>)/,
                            `$1 bento-size-3 ${style}$2`
                        );
                    }
                    return sectionHtml;
                }).join('');
                
                // Get available bentos (don't filter - allow multiple of same type)
                // Also exclude individual articles and albums that are already added
                const existingArticleBentos = sectionOrder.filter(s => s.startsWith('article:'));
                const existingAlbumBentos = sectionOrder.filter(s => s.startsWith('album:'));
                const availableBentos = [
                    { id: 'welcome', name: 'Home', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
                    { id: 'articles', name: 'Articles', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>' },
                    { id: 'bookmarks', name: 'Bookmarks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' },
                    { id: 'collections', name: 'Artboards', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' },
                    { id: 'habits', name: 'Habits', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>' },
                    { id: 'webcomic', name: 'Webcomic', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>' },
                    { id: 'media', name: 'Image/Video', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' }
                ];
                
                // Get available albums (collections) that aren't already added as bentos
                // Note: We still filter albums to prevent duplicates, but regular bentos can be duplicated
                const albums = this.storage.getAlbums();
                const availableAlbums = albums.filter(album => {
                    const albumBentoId = `album:${album.id}`;
                    return !existingAlbumBentos.includes(albumBentoId);
                });
                
                const menuOptions = [];
                
                // Add regular bentos
                if (availableBentos.length > 0) {
                    menuOptions.push(...availableBentos.map(bento => {
                        if (bento.id === 'articles') {
                            // Special handling for articles - show article selection
                            return `
                                <button class="bento-add-option" onclick="window.wikiApp.showArticleSelection(event)">
                                    ${bento.icon}
                                    <span>${bento.name}</span>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                                </button>
                            `;
                        } else if (bento.id === 'collections') {
                            // Special handling for collections - show collection selection
                            return `
                                <button class="bento-add-option" onclick="window.wikiApp.showCollectionSelection(event)">
                                    ${bento.icon}
                                    <span>${bento.name}</span>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                                </button>
                            `;
                        } else if (bento.id === 'bookmarks') {
                            // Special handling for bookmarks - show bookmark selection
                            return `
                                <button class="bento-add-option" onclick="window.wikiApp.showBookmarkSelection(event)">
                                    ${bento.icon}
                                    <span>${bento.name}</span>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                                </button>
                            `;
                        } else if (bento.id === 'habits') {
                            // Special handling for habits - show habit selection
                            return `
                                <button class="bento-add-option" onclick="window.wikiApp.showHabitSelection(event)">
                                    ${bento.icon}
                                    <span>${bento.name}</span>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                                </button>
                            `;
                        } else if (bento.id === 'media') {
                            // Special handling for media - show media selection
                            return `
                                <button class="bento-add-option" onclick="window.wikiApp.showMediaSelection(event)">
                                    ${bento.icon}
                                    <span>${bento.name}</span>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                                </button>
                            `;
                        }
                        return `
                            <button class="bento-add-option" onclick="window.wikiApp.addBento('${bento.id}', event)">
                                ${bento.icon}
                                <span>${bento.name}</span>
                            </button>
                        `;
                    }));
                }
                
                // Note: Individual collections are now shown in the collection selection menu, not here
                
                const menuContent = menuOptions.length > 0 
                    ? menuOptions.join('')
                    : '<div class="bento-add-empty">All bentos added</div>';
                
                // Create add bento card
                const addBentoHtml = `
                    <div class="bento-card bento-add" onclick="window.wikiApp.showAddBentoMenu(event)">
                        <button class="bento-add-btn" title="Add a bento">
                            ${addIconSvg}
                            <span>Add Bento</span>
                        </button>
                        <div class="bento-add-menu" style="display: none;">
                            ${menuContent}
                        </div>
                    </div>
                `;
                
                container.innerHTML = `
                    ${this.renderSectionNav()}
                    <div class="bento-grid" id="bento-grid">
                        ${sectionsHtml}
                        ${addBentoHtml}
                    </div>
                `;
                
                // Setup drag and drop for sections
                this.setupSectionDragDrop();
                
                // Setup webcomic event listeners
                this.setupWebcomicListeners();
                document.title = 'Home Page - XoxoWiki';
                // Hide TOC when showing main page
                const tocContainer = document.getElementById('table-of-contents');
                if (tocContainer) {
                    tocContainer.style.display = 'none';
                }
                // Show sidebar sections on homepage
                const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
                const sidebarThoughts = document.getElementById('sidebar-thoughts');
                const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
                const sidebarMenu = document.querySelector('.mw-sidebar-menu');
                
                if (sidebarBookmarks) sidebarBookmarks.style.display = 'block';
                if (sidebarThoughts) sidebarThoughts.style.display = 'block';
                if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'block';
                if (sidebarMenu) sidebarMenu.style.display = 'block';
                
                this.updateBookmarksDisplay();
                this.updateThoughtsDisplay();
                this.updateRecentArticlesDisplay();
                // Update right sidebar with activity and habits
                this.updateRightSidebar();
                
                // If a bento was moved, add the moved class and restore edit mode if needed
                // This runs after all setup is complete
                if (this.movedBentoSection) {
                    const movedSection = this.movedBentoSection;
                    const shouldRestoreEdit = this.bentoToRestoreEditMode === movedSection;
                    
                    // Use setTimeout to ensure everything is rendered
                    setTimeout(() => {
                        const grid = document.getElementById('bento-grid');
                        if (grid) {
                            const movedCard = grid.querySelector(`[data-section="${movedSection}"]`);
                            if (movedCard) {
                                // Add moved class for green shadow
                                movedCard.classList.add('bento-moved');
                                
                                // Restore edit mode if it was in edit mode before moving
                                if (shouldRestoreEdit) {
                                    const controlsWrapper = movedCard.querySelector('.bento-controls-wrapper');
                                    if (controlsWrapper) {
                                        const moveControls = controlsWrapper.querySelector('.bento-move-controls');
                                        const deleteResizeWrapper = controlsWrapper.querySelector('.bento-delete-resize-wrapper');
                                        
                                        // Show controls and add edit class
                                        if (moveControls) {
                                            moveControls.style.display = 'flex';
                                        }
                                        if (deleteResizeWrapper) {
                                            deleteResizeWrapper.style.display = 'flex';
                                        }
                                        controlsWrapper.style.opacity = '1';
                                        movedCard.classList.add('bento-editing');
                                    }
                                } else {
                                    // Not in edit mode - remove the moved class after transition (1.5s)
                                    setTimeout(() => {
                                        if (movedCard && movedCard.classList.contains('bento-moved')) {
                                            movedCard.classList.remove('bento-moved');
                                        }
                                        if (this.movedBentoSection === movedSection) {
                                            this.movedBentoSection = null;
                                        }
                                    }, 1500);
                                }
                            }
                        }
                        // Clear the restore flag
                        this.bentoToRestoreEditMode = null;
                    }, 200);
                }
                
                return;
            }
            
            container.innerHTML = `
                <h1>Article Not Found</h1>
                <p>The article "${key}" does not exist yet.</p>
                <p><a href="#articles" data-route="articles">View all articles</a> or <a href="#main" data-route="main">return to home page</a>.</p>
                <p><button class="btn-primary" onclick="window.wikiApp.createArticleFromKey('${key}')">Create this article</button></p>
            `;
            document.title = 'Article Not Found - XoxoWiki';
            return;
        }

        // Update articles cache
        this.articles[key] = article;

        const content = this.parseContent(article.content);
        const isBookmarked = this.storage.isBookmarked(key);
        const bookmarkText = isBookmarked ? 'Unbookmark' : 'Bookmark';
        const isPinned = this.storage.getPinnedArticles().includes(key);
        const pinText = isPinned ? 'Unpin' : 'Pin';
        const meta = this.storage.getArticleMeta(key);
        
        // Generate table of contents from headings
        const toc = this.generateTableOfContents(content);
        
        // Get comments for this article
        const comments = this.storage.getComments(key);
        const commentsHtml = this.renderComments(key, comments);
        
        // Get remixed versions of this article
        const remixes = this.getRemixes(key);
        const remixesHtml = this.renderRemixes(remixes);
        
        // Get backlinks
        const backlinksHtml = this.renderBacklinks(key);
        
        // Only show visibility badge if private (public is default)
        const visibilityBadge = meta.isPublic ? '' : 
            '<span class="visibility-badge private">Private</span>';
        const sourceBadge = meta.source ? 
            `<div class="source-link">Source: <a href="${meta.source}" target="_blank">${new URL(meta.source).hostname}</a></div>` : '';
        const remixBadge = meta.remixedFrom ? 
            `<span class="remix-badge">Remixed from ${meta.remixedFrom}</span>` : '';
        
        container.innerHTML = `
            ${this.renderSectionNav()}
            <div class="article-header">
                <h1>${article.title}<span class="section-actions"><a href="#${key}" class="section-copy-link" onclick="window.wikiApp.copyArticleLink('${key}'); return false;">[copy link]</a></span>${visibilityBadge}${remixBadge}</h1>
                ${sourceBadge}
                <div class="article-actions">
                    <button class="article-bookmark-button ${isBookmarked ? 'active' : ''}" onclick="window.wikiApp.toggleBookmark('${key}')"><svg viewBox="0 0 24 24" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>${bookmarkText}</button>
                    <button class="article-remix-button" onclick="window.wikiApp.remixArticle('${key}')" title="Create your own copy of this article"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"/></svg>Remix</button>
                    <button class="article-history-button" onclick="window.wikiApp.viewHistory('${key}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>History</button>
                    <button class="btn-secondary article-edit-button" onclick="window.wikiApp.editArticle('${key}')" style="display: inline-flex; align-items: center;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit</button>
                </div>
            </div>
            ${content}
            ${backlinksHtml}
            ${remixesHtml}
            <div class="article-comments-section">
                <h2>Discussion</h2>
                <div class="comment-form">
                    <textarea id="new-comment-text" placeholder="Add a comment..." rows="3"></textarea>
                    <button class="btn-primary" onclick="window.wikiApp.addComment('${key}')" style="margin-top: 0.5em;">Post Comment</button>
                </div>
                <div id="comments-list-${key}" class="comments-list">
                    ${commentsHtml}
                </div>
            </div>
        `;
        
        // Update TOC after DOM is ready
        setTimeout(() => {
            const toc = this.generateTableOfContents(content);
            this.updateTableOfContents(toc);
            
            // Add keyboard shortcuts for comment form
            const commentTextarea = document.getElementById('new-comment-text');
            if (commentTextarea) {
                commentTextarea.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        // Pass value from the focused field so we don't read stale/empty DOM
                        this.addComment(key, null, e.target.value);
                    }
                });
            }
        }, 100);

        document.title = `${article.title} - XoxoWiki`;
        
        // Hide sidebar sections except table of contents when viewing an article
        const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
        const sidebarThoughts = document.getElementById('sidebar-thoughts');
        const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
        const sidebarMenu = document.querySelector('.mw-sidebar-menu');
        
        if (sidebarBookmarks) sidebarBookmarks.style.display = 'none';
        if (sidebarThoughts) sidebarThoughts.style.display = 'none';
        if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'none';
        if (sidebarMenu) sidebarMenu.style.display = 'none';
        
        // Mark article as read when viewed
        if (key !== 'main') {
            this.storage.markAsRead(key);
        }
        
        this.updateBookmarksDisplay();
        this.updateThoughtsDisplay();
        this.updateRecentArticlesDisplay();
        this.updateRightSidebar();
        
        // Note: Moved bento handling is now done in the main page rendering section above
        // This keeps it in one place and ensures it runs after all setup is complete
        
        // Scroll to section if specified
        if (sectionId) {
            setTimeout(() => {
                const sectionElement = document.getElementById(sectionId);
                if (sectionElement) {
                    this.scrollToElement(sectionElement, 'center');
                    // Highlight the section briefly
                    sectionElement.style.backgroundColor = '#fff3cd';
                    setTimeout(() => {
                        sectionElement.style.backgroundColor = '';
                    }, 2000);
                }
            }, 100);
        }
        } catch (error) {
            console.error('Error in showArticle:', error);
            const container = document.getElementById('article-container');
            if (container) {
                container.innerHTML = `
                    <div style="padding: 2em;">
                        <h1>Error Loading Article</h1>
                        <p>There was an error loading "${key}". Please try refreshing the page.</p>
                        <p><a href="#main" data-route="main">Return to home page</a></p>
                        <details style="margin-top: 1em;">
                            <summary>Error details</summary>
                            <pre style="background: #f8f9fa; padding: 1em; overflow: auto;">${this.escapeHtml(error.toString())}</pre>
                        </details>
                    </div>
                `;
            } else {
                console.error('Could not display error - container not found');
            }
        }
    }

    async showArticleList() {
        const container = document.getElementById('article-container');
        
        // Reload articles to ensure we have the latest
        await this.loadArticles();
        await this.showArticleListWithoutReload();
    }

    async showArticleListWithoutReload() {
        const container = document.getElementById('article-container');
        
        const articleKeys = Object.keys(this.articles).sort();
        
        if (articleKeys.length === 0) {
            container.innerHTML = `
                ${this.renderSectionNav()}
                <div class="article-header">
                    <h1>All Articles</h1>
                    <div class="article-header-upload-wrapper">
                        <button class="btn-primary" onclick="window.wikiApp.openCreateModal('article')" style="display: inline-flex; align-items: center;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                            New Article
                        </button>
                    </div>
                </div>
                <p>No articles yet. Click "New Article" above or highlight some text and click "Create Article" to get started!</p>
            `;
            document.title = 'All Articles - XoxoWiki';
            // Show Home Page button when not on homepage
            const homePageLink = document.querySelector('.mw-sidebar-menu a[data-route="main"]');
            if (homePageLink && homePageLink.closest('li')) {
                homePageLink.closest('li').style.display = '';
            }
            this.updateBookmarksDisplay();
            this.updateThoughtsDisplay();
            this.updateRecentArticlesDisplay();
            this.updateRightSidebar();
            return;
        }

        const listItems = articleKeys.map(key => {
            const article = this.articles[key];
            const isBookmarked = this.storage.isBookmarked(key);
            const bookmarkIcon = isBookmarked ? ' (saved)' : '';
            return `<li><a href="#${key}" data-route="${key}">${article.title}${bookmarkIcon}${this.getPdsSyncCloudIcon()}</a></li>`;
        }).join('');

        container.innerHTML = `
            ${this.renderSectionNav()}
            <div class="article-header">
                <h1>All Articles</h1>
                <div class="article-header-upload-wrapper">
                    <button class="btn-primary" onclick="window.wikiApp.openCreateModal('article')" style="display: inline-flex; align-items: center;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        New Article
                    </button>
                </div>
            </div>
            <p>Total: <strong>${articleKeys.length}</strong> article(s)</p>
            <ul class="article-list">
                ${listItems}
            </ul>
        `;

        document.title = 'All Articles - XoxoWiki';
        // Hide TOC when showing article list
        const tocContainer = document.getElementById('table-of-contents');
        if (tocContainer) {
            tocContainer.style.display = 'none';
        }
        // Show sidebar sections
        const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
        const sidebarThoughts = document.getElementById('sidebar-thoughts');
        const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
        const sidebarMenu = document.querySelector('.mw-sidebar-menu');
        
        if (sidebarBookmarks) sidebarBookmarks.style.display = 'block';
        if (sidebarThoughts) sidebarThoughts.style.display = 'block';
        if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'block';
        if (sidebarMenu) sidebarMenu.style.display = 'block';
        
        this.updateBookmarksDisplay();
        this.updateThoughtsDisplay();
        this.updateRecentArticlesDisplay();
        this.updateRightSidebar();
    }

    async showBookmarks() {
        const container = document.getElementById('article-container');
        
        // Reload articles to ensure we have the latest
        await this.loadArticles();
        
        const bookmarks = this.storage.getBookmarks();
        const bookmarkedArticles = bookmarks
            .filter(key => this.articles[key]) // Only show if article exists
            .map(key => {
                const article = this.articles[key];
                const updatedAt = article.updatedAt || 0;
                const lastReadTime = this.storage.getLastReadTime(key);
                const isRead = this.storage.isRead(key);
                // Article is unread if never read, or if it was updated after last read
                const isUnread = !isRead || updatedAt > lastReadTime;
                
                return {
                    key,
                    title: article.title,
                    updatedAt,
                    lastReadTime,
                    isRead,
                    isUnread
                };
            });

        if (bookmarkedArticles.length === 0) {
            container.innerHTML = `
                ${this.renderSectionNav()}
                <div class="article-header">
                    <h1>Bookmarked Articles</h1>
                </div>
                <p>No bookmarked articles yet. Click the Bookmark button on any article to save it.</p>
            `;
            document.title = 'Bookmarks - XoxoWiki';
            // Show Home Page button when not on homepage
            const homePageLink = document.querySelector('.mw-sidebar-menu a[data-route="main"]');
            if (homePageLink && homePageLink.closest('li')) {
                homePageLink.closest('li').style.display = '';
            }
            this.updateBookmarksDisplay();
            this.updateThoughtsDisplay();
            return;
        }

        // Sort by: unread articles first, then by most recently updated
        bookmarkedArticles.sort((a, b) => {
            // Unread articles go to top
            if (a.isUnread !== b.isUnread) {
                return b.isUnread ? 1 : -1;
            }
            // Then sort by most recently updated (descending)
            return b.updatedAt - a.updatedAt;
        });

        const listItems = bookmarkedArticles.map(item => {
            const isUnread = !item.isRead || item.updatedAt > item.lastReadTime;
            const unreadBadge = isUnread ? ' <span class="unread-badge">●</span>' : '';
            return `<li><a href="#${item.key}" data-route="${item.key}">${item.title}${unreadBadge}</a></li>`;
        }).join('');

        container.innerHTML = `
            ${this.renderSectionNav()}
            <div class="article-header">
                <h1>Bookmarked Articles</h1>
            </div>
            <p>Total: <strong>${bookmarkedArticles.length}</strong> bookmarked article(s)</p>
            <p style="color: #54595d; font-size: 13px; margin-bottom: 1em;">
                Articles are sorted by recently edited. Unread articles appear at the top.
            </p>
            <ul class="article-list">
                ${listItems}
            </ul>
        `;

        document.title = 'Bookmarks - XoxoWiki';
        // Hide TOC when showing bookmarks
        const tocContainer = document.getElementById('table-of-contents');
        if (tocContainer) {
            tocContainer.style.display = 'none';
        }
        // Show sidebar sections
        const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
        const sidebarThoughts = document.getElementById('sidebar-thoughts');
        const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
        const sidebarMenu = document.querySelector('.mw-sidebar-menu');
        
        if (sidebarBookmarks) sidebarBookmarks.style.display = 'block';
        if (sidebarThoughts) sidebarThoughts.style.display = 'block';
        if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'block';
        if (sidebarMenu) sidebarMenu.style.display = 'block';
        
        this.updateBookmarksDisplay();
        this.updateThoughtsDisplay();
        this.updateRecentArticlesDisplay();
    }

    showCreateButton(selection) {
        let button = document.getElementById('create-article-button');
        if (!button) {
            button = document.createElement('button');
            button.id = 'create-article-button';
            button.className = 'create-article-button';
            button.textContent = 'Create Article';
            button.addEventListener('click', () => this.openCreateModal());
            document.body.appendChild(button);
        }

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        button.style.display = 'block';
        button.style.top = `${rect.bottom + window.scrollY + 5}px`;
        button.style.left = `${rect.left + window.scrollX + (rect.width / 2) - 75}px`;
    }

    hideCreateButton() {
        const button = document.getElementById('create-article-button');
        if (button) {
            button.style.display = 'none';
        }
    }

    openCreateModal(startTab = 'article') {
        document.getElementById('modal-title').textContent = startTab === 'media' ? 'Upload Media' : 'Create New Article';
        document.getElementById('article-title').value = '';
        document.getElementById('article-key').value = '';
        document.getElementById('article-key').dataset.manual = '';
        document.getElementById('article-key').disabled = false;
        // Hide the technical "Article Key" field for simplicity
        document.getElementById('article-key-group').style.display = 'none';
        
        // Set content in Quill editor
        if (this.quill) {
            if (this.selectedText) {
                this.quill.root.innerHTML = this.selectedText;
            } else {
                this.quill.setText('');
            }
        } else {
            // Fallback to textarea
            const fallbackTextarea = document.getElementById('article-content-fallback');
            if (fallbackTextarea) {
                fallbackTextarea.value = this.selectedText || '';
            }
        }
        
        document.getElementById('delete-article').style.display = 'none';
        document.getElementById('view-history').style.display = 'none';
        
        // Clear metadata fields
        
        // Show tabs for create, hide for edit
        const tabsEl = document.getElementById('create-tabs');
        if (tabsEl) tabsEl.style.display = 'flex';
        
        document.getElementById('article-modal').style.display = 'flex';
        this.currentArticleKey = null;
        this.hideCreateButton();
        
        // Switch to appropriate tab
        this.switchCreateTab(startTab || 'article');
        
        // Update album dropdown
        this.updateAlbumSelect();
        
        // Focus on title input after modal opens
        setTimeout(() => {
            if (startTab === 'media') {
                // Focus dropzone or file input
            } else {
                document.getElementById('article-title').focus();
            }
        }, 100);
    }

    switchCreateTab(tabName) {
        document.querySelectorAll('.create-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        document.querySelectorAll('.create-panel').forEach(p => {
            p.classList.toggle('active', p.id === `create-${tabName}-panel`);
        });
    }

    async viewHistory(key = null) {
        const articleKey = key || this.currentArticleKey;
        if (!articleKey) return;

        const history = await this.storage.getArticleHistory(articleKey);
        const container = document.getElementById('history-list');

        if (history.length === 0) {
            container.innerHTML = '<p>No edit history available for this article.</p>';
        } else {
            const historyItems = history.map((entry, index) => {
                const date = new Date(entry.timestamp);
                const dateStr = date.toLocaleString();
                const isCurrent = index === 0;
                
                return `
                    <div class="history-entry ${isCurrent ? 'current' : ''}">
                        <div class="history-header">
                            <span class="history-date">${dateStr}</span>
                            ${isCurrent ? '<span class="history-badge">Current</span>' : ''}
                        </div>
                        <div class="history-preview">
                            <strong>${entry.title}</strong>
                            <p>${entry.content.substring(0, 200)}${entry.content.length > 200 ? '...' : ''}</p>
                        </div>
                        ${!isCurrent ? `<button class="btn-secondary btn-sm" onclick="window.wikiApp.restoreVersion('${articleKey}', ${entry.timestamp})">Restore this version</button>` : ''}
                    </div>
                `;
            }).join('');

            container.innerHTML = historyItems;
        }

        const historyModal = document.getElementById('history-modal');
        historyModal.style.display = 'flex';
        
        // Close modal when clicking outside
        const handleOutsideClick = (e) => {
            if (e.target === historyModal) {
                this.closeHistoryModal();
                historyModal.removeEventListener('click', handleOutsideClick);
            }
        };
        historyModal.addEventListener('click', handleOutsideClick);
    }

    async restoreVersion(articleKey, timestamp) {
        if (!confirm('Are you sure you want to restore this version? This will create a new edit in the history.')) {
            return;
        }

        const history = await this.storage.getArticleHistory(articleKey);
        const entry = history.find(h => h.timestamp === timestamp);
        
        if (entry) {
            await this.storage.saveArticle(articleKey, entry.title, entry.content);
            await this.loadArticles();
            this.closeHistoryModal();
            this.navigate(articleKey);
            this.showUpdateNotification('Version restored!');
        }
    }

    closeHistoryModal() {
        document.getElementById('history-modal').style.display = 'none';
    }

    editArticle(key, sectionId = null) {
        const article = this.articles[key];
        if (!article) return;

        document.getElementById('modal-title').textContent = 'Edit Article';
        document.getElementById('article-title').value = article.title;
        document.getElementById('article-key').value = key;
        document.getElementById('article-key').disabled = true;
        // Hide the technical "Article Key" field when editing
        document.getElementById('article-key-group').style.display = 'none';
        
        // Show modal first
        document.getElementById('article-modal').style.display = 'flex';
        
        // Set content in Quill editor - use setTimeout to ensure modal is visible
        setTimeout(() => {
            if (this.quill) {
                try {
                    // Get raw content
                    const content = article.content || '';
                    
                    // Convert to HTML
                    const htmlContent = this.convertToHTML(content);
                    
                    // Clear editor completely
                    const length = this.quill.getLength();
                    this.quill.deleteText(0, length);
                    
                    // Get the editor element and set HTML directly
                    const editorElement = document.querySelector('#article-content-editor .ql-editor');
                    if (editorElement) {
                        editorElement.innerHTML = htmlContent;
                    } else {
                        // Fallback to root
                        this.quill.root.innerHTML = htmlContent;
                    }
                    
                    // If sectionId is provided, scroll to that section in the editor
                    if (sectionId) {
                        setTimeout(() => {
                            this.scrollToSectionInEditor(sectionId);
                        }, 300);
                    }
                } catch (error) {
                    console.error('Error loading content into editor:', error);
                    alert('Error loading article content: ' + error.message);
                }
            } else {
                // Fallback to textarea
                const fallbackTextarea = document.getElementById('article-content-fallback');
                if (fallbackTextarea) {
                    fallbackTextarea.value = article.content;
                    if (sectionId) {
                        setTimeout(() => {
                            this.scrollToSectionInTextarea(fallbackTextarea, sectionId);
                        }, 300);
                    }
                }
            }
        }, 100);
        
        document.getElementById('delete-article').style.display = 'inline-block';
        document.getElementById('view-history').style.display = 'inline-block';
        
        // Load metadata
        const meta = this.storage.getArticleMeta(key);
        
        this.currentArticleKey = key;
    }

    editArticleAtSection(key, sectionId) {
        this.editArticle(key, sectionId);
    }

    scrollToSectionInEditor(sectionId) {
        if (!this.quill) return;
        
        const editor = this.quill.root;
        const heading = editor.querySelector(`h1#${sectionId}, h2#${sectionId}, h3#${sectionId}`);
        
        if (heading) {
            // Scroll the heading into view
            heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
            
            // Try to set cursor at the heading
            setTimeout(() => {
                try {
                    // Get the Quill instance and find the heading's position
                    const delta = this.quill.getContents();
                    const headingText = heading.textContent.replace(/\[copy link\]|\[edit\]/g, '').trim();
                    
                    // Find the heading in the content
                    let foundIndex = -1;
                    for (let i = 0; i < delta.ops.length; i++) {
                        const op = delta.ops[i];
                        if (op.insert && typeof op.insert === 'string' && op.insert.includes(headingText)) {
                            foundIndex = i;
                            break;
                        }
                    }
                    
                    if (foundIndex >= 0) {
                        // Calculate approximate position
                        let position = 0;
                        for (let i = 0; i < foundIndex; i++) {
                            const op = delta.ops[i];
                            if (op.insert && typeof op.insert === 'string') {
                                position += op.insert.length;
                            }
                        }
                        
                        // Set cursor position
                        this.quill.setSelection(position, 'user');
                    }
                } catch (e) {
                    console.log('Could not set cursor position:', e);
                }
            }, 100);
        }
    }

    scrollToSectionInTextarea(textarea, sectionId) {
        const content = textarea.value;
        // Find the heading in markdown format
        const headingRegex = new RegExp(`^#+\\s+.*${this.escapeRegex(sectionId.replace(/-/g, ' '))}`, 'im');
        const match = content.match(headingRegex);
        
        if (match) {
            const position = match.index;
            textarea.setSelectionRange(position, position);
            textarea.scrollTop = textarea.scrollHeight * (position / content.length);
            textarea.focus();
        }
    }

    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    generateSectionId(text) {
        return text.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    copySectionLink(articleKey, sectionId) {
        const url = window.location.href.split('#')[0] + '#' + articleKey + '#' + sectionId;
        
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => {
                this.showUpdateNotification('Section link copied!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                this.fallbackCopyToClipboard(url);
            });
        } else {
            this.fallbackCopyToClipboard(url);
        }
    }

    createArticleFromKey(key) {
        document.getElementById('modal-title').textContent = 'Create Article';
        document.getElementById('article-title').value = key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        document.getElementById('article-key').value = key;
        document.getElementById('article-key').disabled = false;
        this.quill.setText('');
        document.getElementById('delete-article').style.display = 'none';
        document.getElementById('view-history').style.display = 'none';
        document.getElementById('article-modal').style.display = 'flex';
        this.currentArticleKey = null;
    }

    async saveArticle() {
        try {
            console.log('saveArticle called');
            const titleInput = document.getElementById('article-title');
            const keyInput = document.getElementById('article-key');
            
            if (!titleInput || !keyInput) {
                alert('Form elements not found. Please refresh the page.');
                return;
            }
            
            const title = titleInput.value.trim();
            const key = this.currentArticleKey || keyInput.value.trim() || 
                       title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            
            // Get content from Quill editor and convert to markdown-like format
            let content = '';
            if (this.quill) {
                const htmlContent = this.quill.root.innerHTML;
                content = this.convertFromHTML(htmlContent);
            } else {
                // Fallback to textarea if Quill isn't available
                const fallbackTextarea = document.getElementById('article-content-fallback');
                content = fallbackTextarea ? fallbackTextarea.value : '';
            }

            if (!title) {
                alert('Please enter a title.');
                return;
            }
            
            if (!content.trim()) {
                alert('Please enter some content.');
                return;
            }

            console.log('Saving article:', key, title);
            
            // Save to localStorage and PDS (if connected)
            try {
                await this.storage.saveArticle(key, title, content);
            } catch (err) {
                console.error('Save error:', err);
                if (this.storage.storageMode === 'bluesky') {
                    this.showUpdateNotification('Saved locally; could not sync to Bluesky: ' + (err.message || 'Unknown error'));
                } else {
                    throw err;
                }
                // Article was saved locally; Bluesky sync failed
            }
            this.articles[key] = { title, content };
            
            // Save metadata
            this.storage.saveArticleMeta(key, {
                isPublic: true  // Articles are public by default
            });
            
            // Log activity
            this.storage.logActivity('article', { key, title });
            
            // Export to JSON cache
            await this.exportToJSON();
            
            // Generate RSS feed
            await this.generateRSSFeed();
            
            this.closeModal();
            await this.loadArticles();
            this.updateBookmarksDisplay();
            this.updateThoughtsDisplay();
            this.updateRecentArticlesDisplay();
            
            // Show the published article without reloading (keeps user logged in)
            window.location.hash = `#${key}`;
            await this.showArticle(key);
        } catch (error) {
            console.error('Error in saveArticle:', error);
            alert('Error saving article: ' + error.message);
        }
    }

    async downloadUpdatedJSON() {
        try {
            // Get all articles for the JSON file
            const allArticles = await this.storage.getAllArticles();
            const jsonString = JSON.stringify(allArticles, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });

            // Always download the file so user can overwrite their local file
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'articles.json';
            a.style.position = 'fixed';
            a.style.top = '-1000px';
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                if (document.body.contains(a)) {
                    document.body.removeChild(a);
                }
                URL.revokeObjectURL(url);
            }, 100);
        } catch (error) {
            console.error('Error downloading updated JSON:', error);
            // Don't throw - article is already saved to localStorage
        }
    }

    async deleteArticle() {
        if (!this.currentArticleKey) return;
        
        if (!confirm(`Are you sure you want to delete "${this.articles[this.currentArticleKey]?.title}"?`)) {
            return;
        }

        const deletedKey = this.currentArticleKey;
        const articleTitle = this.articles[deletedKey]?.title || deletedKey;
        
        // Show loading state
        this.showUpdateNotification('Deleting article...');
        
        try {
            // Delete from storage and PDS
            await this.storage.deleteArticle(deletedKey);
            
            // Remove from local cache
            delete this.articles[deletedKey];
            
            // Remove from bookmarks if bookmarked
            if (this.storage.isBookmarked(deletedKey)) {
                this.storage.removeBookmark(deletedKey);
            }
            
            // Update JSON file after deletion
            await this.exportToJSON();
            
            // Update UI
            this.closeModal();
            this.updateBookmarksDisplay();
            this.updateThoughtsDisplay();
            this.updateRecentArticlesDisplay();
            this.currentArticleKey = 'articles';
            await this.showArticleListWithoutReload();
            this.showUpdateNotification('Article deleted');
        } catch (e) {
            console.error('Delete error:', e);
            alert('Could not delete article from Bluesky PDS: ' + (e.message || e) + '\n\nPlease try again. The article was not deleted.');
            // Reload to ensure UI matches storage state
            await this.loadArticles();
            if (this.articles[deletedKey]) {
                // Article still exists, show it
                await this.showArticle(deletedKey);
            } else {
                // Article was deleted locally but PDS deletion failed - show list
                this.currentArticleKey = 'articles';
                await this.showArticleListWithoutReload();
            }
        }
    }

    closeModal() {
        document.getElementById('article-modal').style.display = 'none';
        document.getElementById('article-key').disabled = false;
    }

    openBlueskyModal() {
        document.getElementById('bluesky-modal').style.display = 'flex';
    }

    setupBlueskyHandleAutocomplete() {
        const input = document.getElementById('bluesky-handle');
        const listEl = document.getElementById('bluesky-handle-suggestions');
        if (!input || !listEl) return;

        let debounceTimer = null;
        let selectedIndex = -1;

        const hideSuggestions = () => {
            listEl.style.display = 'none';
            listEl.innerHTML = '';
            selectedIndex = -1;
        };

        const showSuggestions = (actors) => {
            listEl.innerHTML = '';
            if (!actors || actors.length === 0) {
                listEl.style.display = 'none';
                return;
            }
            actors.forEach((actor, i) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'bluesky-handle-suggestion';
                btn.setAttribute('role', 'option');
                btn.setAttribute('aria-selected', 'false');
                const handle = actor.handle || '';
                const name = actor.displayName || actor.name || '';
                btn.innerHTML = `<span class="handle">@${handle}</span>${name ? `<span class="name">${this.escapeHtml(name)}</span>` : ''}`;
                btn.addEventListener('click', () => {
                    input.value = handle;
                    hideSuggestions();
                    input.focus();
                });
                listEl.appendChild(btn);
            });
            listEl.style.display = 'block';
            selectedIndex = 0;
            listEl.querySelectorAll('.bluesky-handle-suggestion')[0]?.setAttribute('aria-selected', 'true');
        };

        input.addEventListener('input', () => {
            const q = input.value.trim().replace(/^@/, '');
            clearTimeout(debounceTimer);
            if (q.length < 2) {
                hideSuggestions();
                return;
            }
            debounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead?q=${encodeURIComponent(q)}&limit=8`);
                    if (!res.ok) { hideSuggestions(); return; }
                    const data = await res.json();
                    showSuggestions(data.actors || []);
                } catch (e) {
                    hideSuggestions();
                }
            }, 200);
        });

        input.addEventListener('focus', () => {
            if (listEl.children.length > 0) listEl.style.display = 'block';
        });

        input.addEventListener('blur', () => {
            setTimeout(hideSuggestions, 150);
        });

        input.addEventListener('keydown', (e) => {
            const options = listEl.querySelectorAll('.bluesky-handle-suggestion');
            if (options.length === 0) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, options.length - 1);
                options.forEach((el, i) => el.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false'));
                options[selectedIndex]?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                options.forEach((el, i) => el.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false'));
                options[selectedIndex]?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && selectedIndex >= 0 && options[selectedIndex]) {
                e.preventDefault();
                const handle = (options[selectedIndex].querySelector('.handle')?.textContent || '').replace(/^@/, '');
                if (handle) {
                    input.value = handle;
                    hideSuggestions();
                }
            } else if (e.key === 'Escape') {
                hideSuggestions();
            }
        });

        document.addEventListener('click', (e) => {
            if (!listEl.contains(e.target) && e.target !== input) hideSuggestions();
        });
    }

    closeBlueskyModal() {
        document.getElementById('bluesky-modal').style.display = 'none';
    }

    async connectBluesky() {
        const handle = document.getElementById('bluesky-handle').value.trim();

        if (!handle) {
            alert('Please enter your Bluesky handle.');
            return;
        }

        const btn = document.getElementById('connect-bluesky-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Starting…';
        }
        try {
            const isPublishedOrigin = window.location.origin === 'https://slrgt.github.io' && (window.location.pathname || '').startsWith('/wikisky');
            if (!isPublishedOrigin && window.location.origin !== 'null' && window.location.origin !== 'file:') {
                const proceed = confirm('Bluesky login will redirect you to sign in, then back to the published app (https://slrgt.github.io/wikisky/). Use the app from that URL to sync with Bluesky. Continue?');
                if (!proceed) {
                    if (btn) { btn.disabled = false; btn.textContent = 'Continue to Bluesky Login'; }
                    return;
                }
            }
            await this.storage.startBlueskyOAuth(handle);
            // User will be redirected to Bluesky; if we get here, redirect was blocked
            alert('Redirect was blocked. Please allow popups/redirects, or open the app from its published URL: https://slrgt.github.io/wikisky/');
        } catch (error) {
            const msg = error.message || 'Unknown error';
            if (/redirect_uri|PAR|invalid/i.test(msg)) {
                alert('Bluesky login failed: use the app from its published URL (https://slrgt.github.io/wikisky/) to sign in.');
            } else {
                alert('Failed to start Bluesky login: ' + msg);
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Continue to Bluesky Login';
            }
        }
    }

    async disconnectBluesky() {
        this.storage.disconnectBluesky();
        this.updateStorageIndicator();
        await this.loadArticles();
        this.handleRoute();
        this.showUpdateNotification('Disconnected from Bluesky');
    }

    async exportToJSON() {
        // Automatically export to JSON after saving
        // This keeps articles.json in sync
        try {
            const jsonString = await this.storage.exportArticles();
            // Store in localStorage for easy access
            localStorage.setItem('articles-json-cache', jsonString);
        } catch (error) {
            console.error('Error exporting to JSON:', error);
        }
    }

    async selectArchiveDirectory() {
        try {
            // Try current directory first if running from file:// (Chrome/Edge only)
            let granted = false;
            if (window.location.protocol === 'file:' && 'showDirectoryPicker' in window) {
                granted = await this.storage.requestCurrentDirectory();
            }
            
            // Fall back to standard directory picker (works on all browsers)
            if (!granted) {
                granted = await this.storage.requestArchiveDirectory();
            }
            
            if (granted) {
                const statusEl = document.getElementById('archive-directory-status');
                if (statusEl) {
                if ('showDirectoryPicker' in window && this.storage.archiveDirectoryHandle) {
                    statusEl.textContent = '✓ Archive folder selected';
                } else if ('showSaveFilePicker' in window) {
                    statusEl.textContent = '✓ You will choose location for each file';
                } else {
                    statusEl.textContent = '✓ Files will download to Downloads folder';
                }
                    statusEl.style.display = 'block';
                    statusEl.style.color = '#00af89';
                }
                
                if ('showDirectoryPicker' in window && this.storage.archiveDirectoryHandle) {
                    this.showUpdateNotification('Archive folder selected! Files will be saved to disk.');
                } else {
                    this.showUpdateNotification('Storage configured! Files will be saved to IndexedDB and Downloads folder.');
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                // User cancelled - that's fine
                return;
            } else {
                console.error('Error selecting archive directory:', error);
                alert('Failed to select directory: ' + error.message);
            }
        }
    }

    clearBrowserStorage() {
        if (!confirm('Are you sure you want to clear ALL browser storage? This will delete:\n\n• All articles\n• All artboards/albums\n• All archive items\n• All bookmarks\n• All habits\n• All drafts\n• All settings\n\nThis cannot be undone!')) {
            return;
        }
        
        // Clear all xoxowiki localStorage keys
        const keysToRemove = [
            'xoxowiki-articles',
            'xoxowiki-history',
            'xoxowiki-comments',
            'xoxowiki-bookmarks',
            'xoxowiki-read-articles',
            'xoxowiki-webcomic-pages',
            'xoxowiki-webcomic-progress',
            'xoxowiki-habits',
            'xoxowiki-habit-log',
            'xoxowiki-drafts',
            'xoxowiki-archive',
            'xoxowiki-albums',
            'xoxowiki-section-order',
            'xoxowiki-bento-sizes',
            'xoxowiki-pinned',
            'xoxowiki-activity',
            'xoxowiki-meta',
            'xoxowiki-rss',
            'articles-json-cache'
        ];
        
        // Also clear album index keys (they have dynamic names)
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('album-') && key.endsWith('-index')) {
                keysToRemove.push(key);
            }
            if (key.startsWith('album-') && key.endsWith('-thumb-index')) {
                keysToRemove.push(key);
            }
        });
        
        keysToRemove.forEach(key => localStorage.removeItem(key));
        
        // Reload the page to reset the app
        alert('Browser storage cleared! The page will reload.');
        window.location.reload();
    }

    async downloadJSON() {
        try {
            const jsonString = await this.storage.exportArticles();
            const blob = new Blob([jsonString], { type: 'application/json' });

            // Use File System Access API - ask for location, then remember for overwrites
            if (window.showSaveFilePicker) {
                try {
                    // Always ask for location (or use previous if available)
                    let fileHandle = this.fileHandle;
                    
                    // If no previous handle, ask for location
                    if (!fileHandle) {
                        fileHandle = await window.showSaveFilePicker({
                            suggestedName: 'articles.json',
                            types: [{
                                description: 'JSON files',
                                accept: { 'application/json': ['.json'] }
                            }]
                        });
                        this.fileHandle = fileHandle;
                    }
                    
                    // Write to file (overwrites if exists)
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    this.showUpdateNotification('Backup saved!');
                    return;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        return; // User cancelled
                    }
                    // If file handle invalid, clear and ask for new location
                    if (error.name === 'NotFoundError' || error.name === 'InvalidStateError') {
                        this.fileHandle = null;
                        const fileHandle = await window.showSaveFilePicker({
                            suggestedName: 'articles.json',
                            types: [{
                                description: 'JSON files',
                                accept: { 'application/json': ['.json'] }
                            }]
                        });
                        this.fileHandle = fileHandle;
                        const writable = await fileHandle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        this.showUpdateNotification('Backup saved!');
                        return;
                    }
                    console.warn('File System Access API error:', error);
                }
            }

            // Fallback: browser download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'articles.json';
            a.style.position = 'fixed';
            a.style.top = '-1000px';
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                if (document.body.contains(a)) {
                    document.body.removeChild(a);
                }
                URL.revokeObjectURL(url);
            }, 1000);
            
            this.showUpdateNotification('Backup downloaded!');
        } catch (error) {
            alert('Failed to download backup: ' + error.message);
            console.error('Download error:', error);
        }
    }

    openImportModal() {
        document.getElementById('import-json-modal').style.display = 'flex';
    }

    closeImportModal() {
        document.getElementById('import-json-modal').style.display = 'none';
        document.getElementById('import-json-content').value = '';
        const fileInput = document.getElementById('import-json-file-input');
        if (fileInput) fileInput.value = '';
    }

    async handleImportJsonFile(file) {
        try {
            const text = await file.text();
            const jsonContent = document.getElementById('import-json-content');
            if (jsonContent) {
                jsonContent.value = text;
                // Show a brief success indicator
                const dropzone = document.getElementById('import-json-dropzone');
                if (dropzone) {
                    const originalText = dropzone.querySelector('p').textContent;
                    dropzone.querySelector('p').textContent = `✓ Loaded: ${file.name}`;
                    setTimeout(() => {
                        dropzone.querySelector('p').textContent = originalText;
                    }, 2000);
                }
            }
        } catch (error) {
            alert('Failed to read file: ' + error.message);
            console.error('Error reading file:', error);
        }
    }

    async importJSON() {
        const jsonContent = document.getElementById('import-json-content').value.trim();
        
        if (!jsonContent) {
            alert('Please paste JSON content.');
            return;
        }

        try {
            await this.storage.importArticles(jsonContent);
            await this.loadArticles();
            this.closeImportModal();
            this.handleRoute();
            this.showUpdateNotification('Articles imported successfully!');
        } catch (error) {
            alert('Failed to import JSON: ' + error.message);
            console.error('Import error:', error);
        }
    }

    updateStorageIndicator() {
        const indicator = document.getElementById('storage-mode-indicator');
        const menuConnectBtn = document.getElementById('menu-connect-bluesky');
        const menuDisconnectBtn = document.getElementById('menu-disconnect-bluesky');
        const sidebarConnectBtn = document.getElementById('connect-bluesky');
        const sidebarDisconnectBtn = document.getElementById('disconnect-bluesky');
        const viewPdsBtn = document.getElementById('view-pds-data');
        const menuRssFeed = document.getElementById('menu-rss-feed');
        const headerBlueskyBtn = document.getElementById('header-bluesky-btn');

        if (this.storage.storageMode === 'bluesky') {
            indicator.textContent = 'Sync Status: Bluesky';
            indicator.className = 'storage-mode-bluesky';
            if (menuConnectBtn) menuConnectBtn.style.display = 'none';
            if (menuDisconnectBtn) menuDisconnectBtn.style.display = 'flex';
            if (sidebarConnectBtn) sidebarConnectBtn.style.display = 'none';
            if (sidebarDisconnectBtn) sidebarDisconnectBtn.style.display = 'block';
            if (viewPdsBtn) viewPdsBtn.style.display = 'block';
            if (menuRssFeed) menuRssFeed.style.display = 'flex';
            if (headerBlueskyBtn) {
                headerBlueskyBtn.title = 'Bluesky (connected)';
                headerBlueskyBtn.setAttribute('aria-label', 'Bluesky connected');
            }
        } else {
            indicator.textContent = 'Sync Status: Local Only';
            indicator.className = 'storage-mode-local';
            if (menuConnectBtn) menuConnectBtn.style.display = 'flex';
            if (menuDisconnectBtn) menuDisconnectBtn.style.display = 'none';
            if (sidebarConnectBtn) sidebarConnectBtn.style.display = 'block';
            if (sidebarDisconnectBtn) sidebarDisconnectBtn.style.display = 'none';
            if (viewPdsBtn) viewPdsBtn.style.display = 'none';
            if (menuRssFeed) menuRssFeed.style.display = 'flex';
            if (headerBlueskyBtn) {
                headerBlueskyBtn.title = 'Login with Bluesky';
                headerBlueskyBtn.setAttribute('aria-label', 'Login with Bluesky');
            }
        }
    }

    async showPDSDataModal() {
        const modal = document.getElementById('pds-data-modal');
        const body = document.getElementById('pds-data-modal-body');
        const pdslsLink = document.getElementById('pds-data-open-pdsls');
        if (!modal || !body) return;
        modal.style.display = 'flex';
        body.innerHTML = '<p style="color: #72777d;">Loading…</p>';
        try {
            const summary = await this.storage.getPDSStorageSummary();
            if (summary.error) {
                body.innerHTML = `<p style="color: #b32424;">${this.escapeHtml(summary.error)}</p>`;
                pdslsLink.style.display = 'none';
                return;
            }
            const did = summary.did || '';
            const handle = summary.handle || did;
            const art = summary.articles || {};
            const arch = summary.archive || {};
            let html = `<p><strong>Account</strong><br>Handle: ${this.escapeHtml(handle)}<br>DID: <code style="font-size: 11px; word-break: break-all;">${this.escapeHtml(did)}</code></p>`;
            html += `<p><strong>Articles</strong> (collection <code>site.standard.document</code>): ${art.count || 0} record(s) on PDS</p>`;
            if (art.rkeys && art.rkeys.length > 0) {
                const show = art.rkeys.slice(0, 30);
                html += `<p style="font-size: 12px; color: #54595d;">Keys: ${show.map(k => this.escapeHtml(k)).join(', ')}${art.rkeys.length > 30 ? ' …' : ''}</p>`;
            }
            html += `<p><strong>Artboards</strong> (record <code>com.atproto.repo.record</code> / <code>xoxowiki-archive</code>): ${arch.hasRecord ? `${arch.itemCount || 0} item(s), ${arch.albumCount || 0} album(s)` : 'No record'}</p>`;
            body.innerHTML = html;
            pdslsLink.href = did ? `https://pdsls.dev/${encodeURIComponent(did)}` : 'https://pdsls.dev';
            pdslsLink.style.display = 'inline-flex';
        } catch (e) {
            body.innerHTML = `<p style="color: #b32424;">${this.escapeHtml(e.message || 'Failed to load')}</p>`;
            pdslsLink.style.display = 'none';
        }
    }

    closePDSDataModal() {
        const modal = document.getElementById('pds-data-modal');
        if (modal) modal.style.display = 'none';
    }

    async generateRSSFeed() {
        try {
            const articles = await this.storage.getAllArticles();
            const articleKeys = Object.keys(articles).sort();
            const siteTitle = 'XoxoWiki';
            const siteUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
            
            let rssItems = '';
            articleKeys.slice(0, 20).forEach(key => {
                const article = articles[key];
                const articleUrl = `${siteUrl}/${key}`;
                const description = article.content.substring(0, 200).replace(/<[^>]*>/g, '');
                rssItems += `<item><title>${this.escapeXml(article.title)}</title><link>${articleUrl}</link><guid>${articleUrl}</guid><description>${this.escapeXml(description)}</description><pubDate>${new Date().toUTCString()}</pubDate></item>`;
            });
            
            const rssXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${this.escapeXml(siteTitle)}</title><link>${siteUrl}</link><description>Personal Wiki</description><lastBuildDate>${new Date().toUTCString()}</lastBuildDate><language>en-us</language>${rssItems}</channel></rss>`;
            localStorage.setItem('xoxowiki-rss', rssXml);
            
            const blob = new Blob([rssXml], { type: 'application/rss+xml' });
            const url = URL.createObjectURL(blob);
            const rssLink = document.getElementById('rss-feed-link');
            if (rssLink) {
                const link = rssLink.querySelector('a');
                if (link) { link.href = url; link.download = 'feed.xml'; }
            }
        } catch (error) { console.error('Error generating RSS:', error); }
    }

    escapeXml(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    showUpdateNotification(message) {
        let notification = document.getElementById('update-notification');
        if (notification) {
            notification.remove();
        }

        notification = document.createElement('div');
        notification.id = 'update-notification';
        notification.className = 'update-notification';
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => notification.classList.add('show'), 10);
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    // Convert HTML from Quill to markdown-like format for storage
    convertFromHTML(html) {
        // Create a temporary div to parse HTML
        const temp = document.createElement('div');
        temp.innerHTML = html;

        // Convert headers
        temp.querySelectorAll('h1').forEach(h => {
            h.outerHTML = `# ${h.textContent}\n\n`;
        });
        temp.querySelectorAll('h2').forEach(h => {
            h.outerHTML = `## ${h.textContent}\n\n`;
        });
        temp.querySelectorAll('h3').forEach(h => {
            h.outerHTML = `### ${h.textContent}\n\n`;
        });

        // Convert links - check for wiki links (format: / article-name)
        temp.querySelectorAll('a').forEach(a => {
            const href = a.getAttribute('href');
            if (href && href.startsWith('/ ')) {
                const articleName = href.substring(2);
                a.outerHTML = `[[${articleName}${a.textContent !== articleName ? '|' + a.textContent : ''}]]`;
            } else if (href) {
                a.outerHTML = `[${a.textContent}](${href})`;
            }
        });

        // Convert formatting
        temp.querySelectorAll('strong, b').forEach(el => {
            el.outerHTML = `**${el.textContent}**`;
        });
        temp.querySelectorAll('em, i').forEach(el => {
            el.outerHTML = `*${el.textContent}*`;
        });
        temp.querySelectorAll('code').forEach(el => {
            if (el.parentElement.tagName === 'PRE') {
                el.outerHTML = `\`\`\`\n${el.textContent}\n\`\`\``;
            } else {
                el.outerHTML = `\`${el.textContent}\``;
            }
        });
        temp.querySelectorAll('blockquote').forEach(el => {
            el.outerHTML = `> ${el.textContent}\n\n`;
        });

        // Convert lists
        temp.querySelectorAll('ul li, ol li').forEach(li => {
            li.outerHTML = `- ${li.textContent}\n`;
        });

        // Convert paragraphs
        temp.querySelectorAll('p').forEach(p => {
            if (p.textContent.trim()) {
                p.outerHTML = `${p.textContent}\n\n`;
            }
        });

        return temp.textContent.trim();
    }

    // Convert markdown-like content to HTML for Quill editor
    convertToHTML(content) {
        let html = content;

        // Headers
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

        // Links - [[Article Name]] or [[Article Name|Display Text]]
        html = html.replace(/\[\[([^\]]+)\]\]/g, (match, linkText) => {
            const parts = linkText.split('|');
            const articleName = parts[0].trim().toLowerCase().replace(/\s+/g, '-');
            const displayText = parts[1] ? parts[1].trim() : parts[0].trim();
            return `<a href="#${articleName}" data-route="${articleName}">${displayText}</a>`;
        });

        // External links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

        // Bold
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/'''([^']+)'''/g, '<strong>$1</strong>');

        // Italic
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/''([^']+)''/g, '<em>$1</em>');

        // Code
        html = html.replace(/```([^`]+)```/g, '<pre><code>$1</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Blockquote
        html = html.replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>');

        // Lists
        html = html.replace(/^- (.*$)/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

        // Line breaks
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');

        if (!html.startsWith('<')) {
            html = '<p>' + html + '</p>';
        }

        html = html.replace(/<p><\/p>/g, '');
        html = html.replace(/<p>(<h[1-6])/g, '$1');
        html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');

        return html;
    }

    parseContent(content) {
        let html = content;

        // Headers
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

        // Links - [[Article Name]] or [[Article Name|Display Text]]
        html = html.replace(/\[\[([^\]]+)\]\]/g, (match, linkText) => {
            const parts = linkText.split('|');
            const articleName = parts[0].trim().toLowerCase().replace(/\s+/g, '-');
            const displayText = parts[1] ? parts[1].trim() : parts[0].trim();
            // Check if article exists
            const exists = this.articles[articleName] ? 'article-exists' : 'article-missing';
            return `<a href="#${articleName}" data-route="${articleName}" class="wiki-link ${exists}">${displayText}</a>`;
        });

        // External links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Bold
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/'''([^']+)'''/g, '<strong>$1</strong>');

        // Italic
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/''([^']+)''/g, '<em>$1</em>');

        // Code
        html = html.replace(/```([^`]+)```/g, '<pre><code>$1</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Line breaks
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');

        if (!html.startsWith('<')) {
            html = '<p>' + html + '</p>';
        }

        html = html.replace(/<p><\/p>/g, '');
        html = html.replace(/<p>(<h[1-6])/g, '$1');
        html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');

        // Add IDs and section buttons to headers
        html = html.replace(/<h([1-3])>(.*?)<\/h\1>/g, (match, level, text) => {
            // Extract text content (remove any existing HTML)
            const textContent = text.replace(/<[^>]+>/g, '').trim();
            const sectionId = this.generateSectionId(textContent);
            const articleKey = this.currentArticleKey || 'main';
            return `<h${level} id="${sectionId}">${text} <span class="section-actions"><a href="#${articleKey}#${sectionId}" class="section-copy-link" onclick="window.wikiApp.copySectionLink('${articleKey}', '${sectionId}'); return false;">[copy link]</a> <a href="#${articleKey}#${sectionId}" class="section-edit-link" onclick="window.wikiApp.editArticleAtSection('${articleKey}', '${sectionId}'); return false;">[edit]</a></span></h${level}>`;
        });

        return html;
    }

    updateBookmarksDisplay() {
        const bookmarks = this.storage.getBookmarks();
        const bookmarksBar = document.getElementById('bookmarks-bar');
        const bookmarksList = document.getElementById('bookmarks-list');
        const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
        const sidebarBookmarksList = document.getElementById('sidebar-bookmarks-list');

        // Always hide the top bookmarks bar (not needed anymore)
        if (bookmarksBar) bookmarksBar.style.display = 'none';

        // Update sidebar bookmarks only (top bar removed)
        if (bookmarks.length === 0) {
            if (sidebarBookmarks) sidebarBookmarks.style.display = 'none';
            return;
        }

        // Update sidebar bookmarks
        if (sidebarBookmarks && sidebarBookmarksList) {
            const bookmarkedArticles = bookmarks
                .filter(key => this.articles[key])
                .map(key => {
                    const article = this.articles[key];
                    const updatedAt = article.updatedAt || 0;
                    const lastReadTime = this.storage.getLastReadTime(key);
                    const isRead = this.storage.isRead(key);
                    const isUnread = !isRead || updatedAt > lastReadTime;
                    
                    return {
                        key,
                        title: article.title,
                        updatedAt,
                        isUnread
                    };
                });

            // Sort by: unread articles first, then by most recently updated
            bookmarkedArticles.sort((a, b) => {
                if (a.isUnread !== b.isUnread) {
                    return b.isUnread ? 1 : -1;
                }
                return b.updatedAt - a.updatedAt;
            });

            if (bookmarkedArticles.length === 0) {
                sidebarBookmarks.style.display = 'none';
            } else {
                sidebarBookmarks.style.display = 'block';
                const unreadBadge = (item) => item.isUnread ? ' <span class="unread-badge">●</span>' : '';
                sidebarBookmarksList.innerHTML = bookmarkedArticles.map(item => 
                    `<li><a href="#${item.key}" data-route="${item.key}">${this.escapeHtml(item.title)}${unreadBadge(item)}</a></li>`
                ).join('');
            }
        }
    }

    toggleBookmark(articleKey) {
        if (this.storage.isBookmarked(articleKey)) {
            this.storage.removeBookmark(articleKey);
            this.showUpdateNotification('Article unbookmarked');
        } else {
            this.storage.addBookmark(articleKey);
            this.showUpdateNotification('Article bookmarked');
        }
        this.updateBookmarksDisplay();
        this.updateThoughtsDisplay();
        this.updateRecentArticlesDisplay();
        
        // Update bookmark button if we're viewing this article
        if (this.currentArticleKey === articleKey) {
            this.showArticle(articleKey);
        }
    }

    updateRecentArticlesDisplay() {
        const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
        const sidebarRecentArticlesList = document.getElementById('sidebar-recent-articles-list');

        if (!sidebarRecentArticles || !sidebarRecentArticlesList) return;

        // Get all articles sorted by most recently created/updated
        const articlesArray = Object.entries(this.articles)
            .filter(([key]) => key !== 'main') // Exclude main page from recent
            .map(([key, article]) => ({
                key,
                title: article.title,
                createdAt: article.createdAt || 0,
                updatedAt: article.updatedAt || article.createdAt || 0
            }))
            .sort((a, b) => {
                // Sort by most recent update, then by creation date
                const aTime = a.updatedAt || a.createdAt || 0;
                const bTime = b.updatedAt || b.createdAt || 0;
                return bTime - aTime;
            })
            .slice(0, 10); // Show top 10 most recent

        if (articlesArray.length === 0) {
            sidebarRecentArticlesList.innerHTML = '<li style="color: #54595d; font-size: 12px;">No articles yet</li>';
            return;
        }

        sidebarRecentArticlesList.innerHTML = articlesArray.map(item => {
            const date = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '';
            return `<li><a href="#${item.key}" data-route="${item.key}">${this.escapeHtml(item.title)}</a>${date ? ` <span class="recent-date">(${date})</span>` : ''}</li>`;
        }).join('');
    }

    updateThoughtsDisplay() {
        const sidebarThoughts = document.getElementById('sidebar-thoughts');
        const sidebarThoughtsList = document.getElementById('sidebar-thoughts-list');

        if (!sidebarThoughts || !sidebarThoughtsList) return;

        // If viewing an article, show top-level comments for that article
        if (this.currentArticleKey && this.currentArticleKey !== 'main' && this.currentArticleKey !== 'articles' && this.currentArticleKey !== 'bookmarks') {
            const comments = this.storage.getComments(this.currentArticleKey);
            const topLevelComments = comments.filter(c => !c.parentId);

            if (topLevelComments.length === 0) {
                sidebarThoughts.style.display = 'none';
                return;
            }

            // Show the section
            sidebarThoughts.style.display = 'block';

            // Sort by most recent first
            topLevelComments.sort((a, b) => b.timestamp - a.timestamp);

            sidebarThoughtsList.innerHTML = topLevelComments.map(comment => {
                const date = new Date(comment.timestamp).toLocaleDateString();
                const preview = comment.text.length > 60 ? comment.text.substring(0, 60) + '...' : comment.text;
                return `<li><a href="#" class="comment-link" data-comment-id="${comment.id}" onclick="window.wikiApp.scrollToComment('${comment.id}'); return false;" title="${this.escapeHtml(comment.author)} - ${date}">${this.escapeHtml(comment.author)}: ${this.escapeHtml(preview)}</a></li>`;
            }).join('');
        } else {
            // Not viewing an article - show articles with their comments
            const articlesWithComments = this.storage.getArticlesWithComments(this.articles);

            if (articlesWithComments.length === 0) {
                sidebarThoughts.style.display = 'none';
                return;
            }

            // Show the section
            sidebarThoughts.style.display = 'block';

            // Get all comments from all articles, sorted by most recent
            const allComments = [];
            for (const item of articlesWithComments.slice(0, 10)) {
                const comments = this.storage.getComments(item.key);
                const topLevelComments = comments.filter(c => !c.parentId);
                
                for (const comment of topLevelComments) {
                    allComments.push({
                        articleKey: item.key,
                        articleTitle: item.title,
                        comment: comment
                    });
                }
            }
            
            // Sort by most recent comment timestamp
            allComments.sort((a, b) => b.comment.timestamp - a.comment.timestamp);
            
            // Limit to 20 most recent comments
            const recentComments = allComments.slice(0, 20);

            if (recentComments.length === 0) {
                sidebarThoughts.style.display = 'none';
                return;
            }

            sidebarThoughtsList.innerHTML = recentComments.map(item => {
                const preview = item.comment.text.length > 80 ? item.comment.text.substring(0, 80) + '...' : item.comment.text;
                return `<li class="thought-item">
                    <a href="#${item.articleKey}" data-route="${item.articleKey}" class="thought-article-link">${this.escapeHtml(item.articleTitle)}</a>
                    <a href="#" onclick="window.wikiApp.navigateToComment('${item.articleKey}', '${item.comment.id}'); return false;" class="thought-comment-author">${this.escapeHtml(item.comment.author)}</a>
                    <a href="#" onclick="window.wikiApp.navigateToComment('${item.articleKey}', '${item.comment.id}'); return false;" class="thought-comment-text">${this.escapeHtml(preview)}</a>
                </li>`;
            }).join('');
        }
    }

    navigateToComment(articleKey, commentId) {
        // Navigate to the article first
        this.navigate(articleKey);
        
        // Then scroll to the comment after a short delay to allow page to load
        setTimeout(() => {
            this.scrollToComment(commentId);
        }, 500);
    }

    scrollToComment(commentId) {
        // Find the comment element
        const commentElement = document.getElementById(`comment-${commentId}`) || document.querySelector(`[data-comment-id="${commentId}"]`);
        if (!commentElement) {
            console.warn('Comment not found:', commentId);
            return;
        }

        // Scroll to the discussion section first
        const discussionSection = document.querySelector('.article-comments-section');
        if (discussionSection) {
            this.scrollToElement(discussionSection, 'start');
        }

        // Then scroll to the specific comment and highlight it
        setTimeout(() => {
            this.scrollToElement(commentElement, 'center');
            
            // Highlight the comment author
            const authorElement = document.getElementById(`comment-author-${commentId}`) || commentElement.querySelector('.comment-author');
            if (authorElement) {
                // Add highlight style
                const originalBg = authorElement.style.backgroundColor;
                const originalPadding = authorElement.style.padding;
                const originalBorderRadius = authorElement.style.borderRadius;
                
                authorElement.style.backgroundColor = '#fff3cd';
                authorElement.style.padding = '2px 4px';
                authorElement.style.borderRadius = '2px';
                authorElement.style.transition = 'background-color 0.3s';
                
                // Also highlight the comment container briefly
                commentElement.style.backgroundColor = '#fff3cd';
                commentElement.style.transition = 'background-color 0.3s';
                
                // Remove highlight after 3 seconds
                setTimeout(() => {
                    authorElement.style.backgroundColor = originalBg;
                    authorElement.style.padding = originalPadding;
                    authorElement.style.borderRadius = originalBorderRadius;
                    commentElement.style.backgroundColor = '';
                }, 3000);
            }
        }, 300);
    }

    scrollToElement(element, position = 'center') {
        if (!element) return;
        
        // Get header height (sticky header)
        const header = document.querySelector('.mw-header');
        const headerHeight = header ? header.offsetHeight : 0;
        
        // Get element position
        const elementRect = element.getBoundingClientRect();
        const elementTop = elementRect.top + window.pageYOffset;
        
        // Calculate scroll position
        let scrollPosition;
        if (position === 'center') {
            // Center the element on screen, accounting for header
            const viewportHeight = window.innerHeight;
            scrollPosition = elementTop - (viewportHeight / 2) + (elementRect.height / 2);
        } else if (position === 'start') {
            // Position at top, accounting for header
            scrollPosition = elementTop - headerHeight - 10; // 10px padding
        } else {
            // Default: center
            scrollPosition = elementTop - (window.innerHeight / 2) + (elementRect.height / 2);
        }
        
        // Scroll smoothly to the calculated position
        window.scrollTo({
            top: Math.max(0, scrollPosition),
            behavior: 'smooth'
        });
    }

    copyArticleLink(articleKey) {
        // Get the full URL with hash for deep linking
        const url = window.location.href.split('#')[0] + '#' + articleKey;
        
        // Copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => {
                this.showUpdateNotification('Link copied to clipboard!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                this.fallbackCopyToClipboard(url);
            });
        } else {
            // Fallback for older browsers
            this.fallbackCopyToClipboard(url);
        }
    }

    fallbackCopyToClipboard(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        try {
            document.execCommand('copy');
            this.showUpdateNotification('Link copied to clipboard!');
        } catch (err) {
            console.error('Fallback copy failed:', err);
            this.showUpdateNotification('Failed to copy link. URL: ' + text);
        }
        
        document.body.removeChild(textArea);
    }

    handleSearch(query) {
        const searchResults = document.getElementById('search-results');
        if (!searchResults) return;

        const trimmedQuery = query.trim().toLowerCase();
        
        if (trimmedQuery.length === 0) {
            searchResults.style.display = 'none';
            this.searchResults = [];
            this.searchSelectedIndex = -1;
            return;
        }

        const results = [];
        
        // Search through articles
        for (const [key, article] of Object.entries(this.articles)) {
            const title = article.title.toLowerCase();
            const content = (article.content || '').toLowerCase();
            
            // Check if query matches title or content
            if (title.includes(trimmedQuery) || content.includes(trimmedQuery)) {
                const titleMatch = title.includes(trimmedQuery);
                const contentPreview = content.substring(0, 100).replace(/\n/g, ' ');
                
                results.push({
                    type: 'article',
                    key,
                    title: article.title,
                    preview: contentPreview,
                    titleMatch
                });
            }
        }

        // Search through collections (albums)
        const albums = this.storage.getAlbums();
        for (const album of albums) {
            const name = album.name.toLowerCase();
            if (name.includes(trimmedQuery)) {
                results.push({
                    type: 'collection',
                    id: album.id,
                    title: album.name,
                    preview: 'Artboard',
                    titleMatch: name.includes(trimmedQuery)
                });
            }
        }

        // Search through habits
        const habits = this.storage.getHabits();
        for (const habit of habits) {
            const habitName = habit.toLowerCase();
            if (habitName.includes(trimmedQuery)) {
                results.push({
                    type: 'habit',
                    title: habit,
                    preview: 'Habit',
                    titleMatch: habitName.includes(trimmedQuery)
                });
            }
        }

        // Sort: title matches first, then by type (articles, collections, habits), then by title
        results.sort((a, b) => {
            if (a.titleMatch !== b.titleMatch) {
                return b.titleMatch ? 1 : -1;
            }
            const typeOrder = { article: 0, collection: 1, habit: 2 };
            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            return a.title.localeCompare(b.title);
        });

        // Limit to 10 results
        this.searchResults = results.slice(0, 10);
        this.searchSelectedIndex = -1;

        if (this.searchResults.length === 0) {
            // Show create option with + icon
            const createQuery = query.trim();
            searchResults.innerHTML = `
                <div class="search-result-create" data-query="${createQuery.replace(/"/g, '&quot;')}">
                    <div class="search-result-create-icon">+</div>
                    <div class="search-result-create-content">
                        <div class="search-result-title">Create "${createQuery}"</div>
                        <div class="search-result-preview">Create new article or artboard</div>
                    </div>
                </div>
            `;
        } else {
            searchResults.innerHTML = this.searchResults.map((result, index) => {
                const typeLabel = result.type === 'article' ? 'Article' : result.type === 'collection' ? 'Artboard' : 'Habit';
                let href = '#';
                if (result.type === 'article') {
                    href = `#${result.key}`;
                } else if (result.type === 'collection') {
                    href = `#collection`;
                } else if (result.type === 'habit') {
                    href = '#main'; // Habits don't have a dedicated page, go to main
                }
                
                return `
                    <a href="${href}" data-route="${result.type === 'article' ? result.key : result.type === 'collection' ? 'archive' : 'main'}" class="search-result-item" data-index="${index}" data-type="${result.type}" data-collection-id="${result.type === 'collection' ? result.id : ''}" data-habit-name="${result.type === 'habit' ? result.title : ''}">
                        <div class="search-result-title">
                            ${result.title}
                            <span class="search-result-type">${typeLabel}</span>
                        </div>
                        <div class="search-result-preview">${result.preview}${result.type === 'article' ? '...' : ''}</div>
                    </a>
                `;
            }).join('');
            
            // Add click handlers for collection results
            searchResults.querySelectorAll('.search-result-item[data-type="collection"]').forEach(item => {
                item.addEventListener('click', (e) => {
                    const collectionId = item.getAttribute('data-collection-id');
                    if (collectionId) {
                        e.preventDefault();
                        this.navigate('collection');
                        setTimeout(() => {
                            this.filterCollectionByAlbum(collectionId);
                        }, 100);
                        searchResults.style.display = 'none';
                        document.getElementById('wiki-search').blur();
                    }
                });
            });
        }

        searchResults.style.display = 'block';
        
        // Add click handler for create option
        const createOption = searchResults.querySelector('.search-result-create');
        if (createOption) {
            createOption.addEventListener('click', (e) => {
                e.preventDefault();
                const query = createOption.getAttribute('data-query');
                this.showCreateFromSearch(query);
            });
        }
    }

    highlightSearchResult(index) {
        const searchResults = document.getElementById('search-results');
        if (!searchResults) return;
        
        const resultItems = searchResults.querySelectorAll('.search-result-item');
        const createOption = searchResults.querySelector('.search-result-create');
        
        // Remove previous highlight
        resultItems.forEach(item => {
            item.classList.remove('search-result-selected');
        });
        if (createOption) {
            createOption.classList.remove('search-result-selected');
        }
        
        // Add highlight to selected item
        if (index >= 0 && index < resultItems.length) {
            resultItems[index].classList.add('search-result-selected');
            // Scroll into view if needed
            resultItems[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else if (index === resultItems.length && createOption) {
            // Highlight create option
            createOption.classList.add('search-result-selected');
            createOption.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    showCreateFromSearch(query) {
        if (!query || !query.trim()) return;
        
        const trimmedQuery = query.trim();
        // Escape HTML entities for safe display
        const escapeHtml = (text) => {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        };
        const escapedQuery = escapeHtml(trimmedQuery);
        
        // Show a simple menu to choose between article and collection
        const menu = document.createElement('div');
        menu.className = 'search-create-menu';
        menu.innerHTML = `
            <div class="search-create-option" data-type="article">
                <div class="search-create-icon">📄</div>
                <div class="search-create-text">
                    <div class="search-create-title">Create Article</div>
                    <div class="search-create-desc">"${escapedQuery}"</div>
                </div>
            </div>
            <div class="search-create-option" data-type="collection">
                <div class="search-create-icon">📁</div>
                <div class="search-create-text">
                    <div class="search-create-title">Create Artboard</div>
                    <div class="search-create-desc">"${escapedQuery}"</div>
                </div>
            </div>
        `;
        
        // Position menu near search input - append to search results container to avoid layout shift
        const searchResults = document.getElementById('search-results');
        const searchContainer = document.querySelector('.mw-search-container');
        if (searchResults && searchContainer) {
            // Get the search container's position relative to viewport
            const containerRect = searchContainer.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.top = `${containerRect.bottom + window.scrollY + 8}px`;
            menu.style.left = `${containerRect.left + window.scrollX}px`;
            menu.style.width = `${containerRect.width}px`;
            menu.style.zIndex = '1001';
            // Append to body to avoid affecting search container layout
            document.body.appendChild(menu);
            
            // Handle clicks
            menu.querySelectorAll('.search-create-option').forEach(option => {
                option.addEventListener('click', () => {
                    const type = option.getAttribute('data-type');
                    if (type === 'article') {
                        this.createArticleFromKey(trimmedQuery.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
                    } else if (type === 'collection') {
                        this.storage.saveAlbum({ name: trimmedQuery });
                        this.navigate('collection');
                        // Refresh if already on collection page
                        if (this.currentArticleKey === 'collection') {
                            this.showCollectionPage();
                        }
                    }
                    menu.remove();
                    const searchResults = document.getElementById('search-results');
                    if (searchResults) searchResults.style.display = 'none';
                    const searchInput = document.getElementById('wiki-search');
                    if (searchInput) searchInput.value = '';
                    this.searchSelectedIndex = -1;
                });
            });
            
            // Close on outside click
            setTimeout(() => {
                const closeMenu = (e) => {
                    if (!menu.contains(e.target) && !e.target.closest('.mw-search-container')) {
                        menu.remove();
                        document.removeEventListener('click', closeMenu);
                    }
                };
                document.addEventListener('click', closeMenu);
            }, 0);
        }
    }

    renderComments(articleKey, comments) {
        if (!comments || comments.length === 0) {
            return '<p style="color: #54595d; font-style: italic;">No comments yet. Be the first to comment!</p>';
        }
        
        const renderComment = (comment, depth = 0) => {
            const indent = depth > 0 ? ` style="margin-left: ${depth * 2}em; padding-left: 1em; border-left: 2px solid #a7d7f9;"` : '';
            const date = new Date(comment.timestamp).toLocaleString();
            let repliesHtml = '';
            
            if (comment.replies && comment.replies.length > 0) {
                repliesHtml = comment.replies.map(reply => renderComment(reply, depth + 1)).join('');
            }
            
            return `
                <div class="comment" id="comment-${comment.id}" data-comment-id="${comment.id}"${indent}>
                    <div class="comment-header">
                        <strong class="comment-author" id="comment-author-${comment.id}">${this.escapeHtml(comment.author)}</strong>
                        <span class="comment-date">${date}</span>
                        <button class="comment-reply-btn" onclick="window.wikiApp.showReplyForm('${articleKey}', '${comment.id}')" style="margin-left: 1em; font-size: 12px; padding: 0.2em 0.5em;">Reply</button>
                    </div>
                    <div class="comment-text">${this.escapeHtml(comment.text).replace(/\n/g, '<br>')}</div>
                    ${repliesHtml}
                </div>
            `;
        };
        
        return comments.map(comment => renderComment(comment)).join('');
    }

    addComment(articleKey, parentId = null, optionalCommentText = undefined) {
        // Prefer text passed from caller (e.g. Cmd+Enter) to avoid stale/wrong element
        let commentText = typeof optionalCommentText === 'string' ? optionalCommentText.trim() : undefined;
        if (commentText === undefined) {
            let textArea = document.getElementById('new-comment-text');
            if (!textArea && parentId) {
                textArea = document.getElementById(`reply-text-${parentId}`);
            }
            commentText = textArea ? textArea.value.trim() : '';
        }
        if (!commentText) {
            alert('Please enter a comment');
            return;
        }
        const textArea = document.getElementById('new-comment-text') || (parentId ? document.getElementById(`reply-text-${parentId}`) : null);
        
        // Use Anonymous as author (no name field)
        const comment = this.storage.addComment(articleKey, commentText, 'Anonymous', parentId);
        
        // Clear form
        if (textArea) textArea.value = '';
        
        // Refresh comments display
        const comments = this.storage.getComments(articleKey);
        const commentsList = document.getElementById(`comments-list-${articleKey}`);
        if (commentsList) {
            commentsList.innerHTML = this.renderComments(articleKey, comments);
        }
        
        // Update Thoughts section
        this.updateThoughtsDisplay();
        this.updateRecentArticlesDisplay();
        
        // Hide reply form if it was shown
        if (parentId) {
            const replyForm = document.getElementById(`reply-form-${parentId}`);
            if (replyForm) {
                replyForm.style.display = 'none';
            }
        }
    }

    showReplyForm(articleKey, parentId) {
        // Hide any other open reply forms
        document.querySelectorAll('.reply-form').forEach(form => {
            form.style.display = 'none';
        });
        
        // Check if form already exists
        let replyForm = document.getElementById(`reply-form-${parentId}`);
        if (!replyForm) {
            // Create reply form
            const commentElement = document.querySelector(`[data-comment-id="${parentId}"]`);
            if (commentElement) {
                replyForm = document.createElement('div');
                replyForm.id = `reply-form-${parentId}`;
                replyForm.className = 'reply-form';
                replyForm.innerHTML = `
                    <textarea id="reply-text-${parentId}" placeholder="Write a reply..." rows="2" style="width: 100%; margin-top: 0.5em;"></textarea>
                    <div style="margin-top: 0.5em;">
                        <button class="btn-primary" onclick="window.wikiApp.addReply('${articleKey}', '${parentId}')" style="font-size: 12px; padding: 0.3em 0.8em;">Post Reply</button>
                        <button class="btn-secondary" onclick="document.getElementById('reply-form-${parentId}').style.display='none'" style="font-size: 12px; padding: 0.3em 0.8em; margin-left: 0.5em;">Cancel</button>
                    </div>
                `;
                commentElement.appendChild(replyForm);
                
                // Add keyboard shortcut for reply form
                setTimeout(() => {
                    const replyTextarea = document.getElementById(`reply-text-${parentId}`);
                    if (replyTextarea) {
                        replyTextarea.addEventListener('keydown', (e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                e.preventDefault();
                                this.addReply(articleKey, parentId, e.target.value);
                            }
                        });
                    }
                }, 50);
            }
        }
        
        if (replyForm) {
            replyForm.style.display = 'block';
            // Re-attach keyboard shortcut if form already existed
            setTimeout(() => {
                const replyTextarea = document.getElementById(`reply-text-${parentId}`);
                if (replyTextarea) {
                    // Remove old listener and add new one
                    const newTextarea = replyTextarea.cloneNode(true);
                    replyTextarea.parentNode.replaceChild(newTextarea, replyTextarea);
                    newTextarea.addEventListener('keydown', (e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault();
                            this.addReply(articleKey, parentId, e.target.value);
                        }
                    });
                }
            }, 50);
        }
    }

    addReply(articleKey, parentId, optionalReplyText = undefined) {
        const replyText = typeof optionalReplyText === 'string' ? optionalReplyText.trim() : undefined;
        const textArea = document.getElementById(`reply-text-${parentId}`);
        const resolvedText = replyText !== undefined ? replyText : (textArea ? textArea.value.trim() : '');
        if (!resolvedText) {
            alert('Please enter a reply');
            return;
        }
        // Use Anonymous as author for replies (no name field)
        const comment = this.storage.addComment(articleKey, resolvedText, 'Anonymous', parentId);
        // Clear reply form
        if (textArea) textArea.value = '';
        
        // Hide reply form
        const replyForm = document.getElementById(`reply-form-${parentId}`);
        if (replyForm) {
            replyForm.style.display = 'none';
        }
        
        // Refresh comments display
        const comments = this.storage.getComments(articleKey);
        const commentsList = document.getElementById(`comments-list-${articleKey}`);
        if (commentsList) {
            commentsList.innerHTML = this.renderComments(articleKey, comments);
        }
        
        // Update Thoughts section
        this.updateThoughtsDisplay();
        this.updateRecentArticlesDisplay();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    remixArticle(key) {
        const article = this.articles[key];
        if (!article) return;
        
        const newKey = `${key}-remix-${Date.now()}`;
        const newTitle = `${article.title} (Remix)`;
        
        // Set metadata for the remix
        this.storage.saveArticleMeta(newKey, { remixedFrom: article.title });
        this.storage.logActivity('remix', { original: key, newKey });
        
        // Open editor with the remixed content
        document.getElementById('modal-title').textContent = 'Create Remix';
        document.getElementById('article-title').value = newTitle;
        document.getElementById('article-key').value = newKey;
        document.getElementById('article-key').disabled = false;
        document.getElementById('article-key-group').style.display = 'block';
        document.getElementById('article-modal').style.display = 'flex';
        
        setTimeout(() => {
            if (this.quill) {
                const htmlContent = this.convertToHTML(article.content || '');
                const editorElement = document.querySelector('#article-content-editor .ql-editor');
                if (editorElement) editorElement.innerHTML = htmlContent;
                else this.quill.root.innerHTML = htmlContent;
            }
        }, 100);
        
        document.getElementById('delete-article').style.display = 'none';
        document.getElementById('view-history').style.display = 'none';
        this.currentArticleKey = null;
    }

    getRemixes(articleKey) {
        // Find all articles that are remixes of this article
        // Remix keys follow the pattern: {originalKey}-remix-{timestamp}
        const baseKey = articleKey.replace(/-remix-\d+$/, ''); // Remove remix suffix if this is a remix
        const remixes = [];
        
        for (const [key, article] of Object.entries(this.articles)) {
            // Check if this article is a remix of the current article
            if (key.startsWith(baseKey + '-remix-')) {
                remixes.push({
                    key: key,
                    title: article.title,
                    updatedAt: article.updatedAt || 0
                });
            }
        }
        
        // Sort by most recently updated
        remixes.sort((a, b) => b.updatedAt - a.updatedAt);
        
        return remixes;
    }

    renderRemixes(remixes) {
        if (remixes.length === 0) {
            return '';
        }
        
        const remixList = remixes.map(remix => {
            const date = remix.updatedAt ? new Date(remix.updatedAt).toLocaleDateString() : '';
            return `<li><a href="#${remix.key}" data-route="${remix.key}">${this.escapeHtml(remix.title)}</a>${date ? ` <span class="remix-date">(${date})</span>` : ''}</li>`;
        }).join('');
        
        return `
            <div class="article-remixes-section">
                <h2>Remixed Versions</h2>
                <p style="color: #54595d; font-size: 13px; margin-bottom: 0.5em;">This article has been remixed ${remixes.length} time(s). View other versions:</p>
                <ul class="remixes-list">
                    ${remixList}
                </ul>
            </div>
        `;
    }

    async downloadWikiCode() {
        try {
            // Create a zip file with all the code
            // We'll use JSZip library if available, or create a simple download
            if (typeof JSZip === 'undefined') {
                // Fallback: download files individually or show instructions
                alert('To download the complete wiki code, please:\n\n1. Download index.html\n2. Download style.css\n3. Download app.js\n4. Download storage.js\n5. Download README.md\n\nOr visit the GitHub repository to download as a zip.');
                return;
            }

            const zip = new JSZip();
            const fetchedFiles = [];
            
            // Helper function to get file content using multiple methods
            const getFileContent = async (filename) => {
                // Method 1: Try fetch (works with http/https and some file:// scenarios)
                try {
                    const response = await fetch(filename);
                    if (response.ok) {
                        const content = await response.text();
                        if (content && content.length > 0) {
                            return content;
                        }
                    }
                } catch (e) {
                    // Fetch failed, try other methods
                }
                
                // Method 2: For CSS - try to read from loaded stylesheet (works if same-origin)
                if (filename === 'style.css') {
                    try {
                        const styleLink = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                            .find(link => link.href && (link.href.includes('style.css') || link.href.endsWith('style.css')));
                        
                        if (styleLink) {
                            // Try to fetch from the link's href
                            try {
                                const response = await fetch(styleLink.href);
                                if (response.ok) {
                                    return await response.text();
                                }
                            } catch (e) {
                                // If that fails, try reading from stylesheet rules
                                if (styleLink.sheet) {
                                    try {
                                        let cssContent = '';
                                        const rules = styleLink.sheet.cssRules || styleLink.sheet.rules;
                                        if (rules && rules.length > 0) {
                                            for (let i = 0; i < rules.length; i++) {
                                                try {
                                                    cssContent += rules[i].cssText + '\n';
                                                } catch (e) {
                                                    // Some rules might not be accessible
                                                }
                                            }
                                            if (cssContent.length > 100) {
                                                return cssContent;
                                            }
                                        }
                                    } catch (e) {
                                        // CORS restriction or other error
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // Error accessing stylesheet
                    }
                }
                
                // Method 3: For JS files - try to fetch from script src
                if (filename.endsWith('.js')) {
                    try {
                        const scriptTag = Array.from(document.querySelectorAll('script[src]'))
                            .find(script => script.src && (script.src.includes(filename) || script.src.endsWith(filename)));
                        
                        if (scriptTag && scriptTag.src) {
                            try {
                                const response = await fetch(scriptTag.src);
                                if (response.ok) {
                                    return await response.text();
                                }
                            } catch (e) {
                                // Fetch from script src failed
                            }
                        }
                    } catch (e) {
                        // Error accessing script tag
                    }
                }
                
                // Method 4: For HTML - reconstruct from document
                if (filename === 'index.html') {
                    // Get the HTML structure
                    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XoxoWiki</title>
    <link rel="stylesheet" href="style.css">
    <!-- Quill WYSIWYG Editor -->
    <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
    <!-- JSZip for downloading wiki code -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
</head>
<body>
${document.body.innerHTML}
    <script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
    <script src="storage.js"></script>
    <script src="app.js"></script>
</body>
</html>`;
                    return htmlContent;
                }
                
                return null;
            };
            
            // Get all required files
            const filesToGet = [
                { name: 'index.html', required: true },
                { name: 'style.css', required: true },
                { name: 'app.js', required: true },
                { name: 'storage.js', required: true },
                { name: 'README.md', required: false }
            ];
            
            // Try to get each file
            for (const file of filesToGet) {
                const content = await getFileContent(file.name);
                if (content) {
                    zip.file(file.name, content);
                    fetchedFiles.push(file.name);
                }
            }
            
            // If we're missing required files, try File System Access API
            const missingFiles = filesToGet.filter(f => f.required && !fetchedFiles.includes(f.name));
            
            if (missingFiles.length > 0 && window.showOpenFilePicker) {
                const message = `Could not automatically fetch some files:\n${missingFiles.map(f => f.name).join(', ')}\n\nWould you like to manually select these files from your computer?`;
                if (confirm(message)) {
                    for (const file of missingFiles) {
                        try {
                            const [fileHandle] = await window.showOpenFilePicker({
                                suggestedName: file.name,
                                types: [{
                                    description: file.name.endsWith('.js') ? 'JavaScript files' : 
                                                file.name.endsWith('.css') ? 'CSS files' : 
                                                file.name.endsWith('.md') ? 'Markdown files' : 'HTML files',
                                    accept: {
                                        [file.name.endsWith('.js') ? 'text/javascript' : 
                                         file.name.endsWith('.css') ? 'text/css' : 
                                         file.name.endsWith('.md') ? 'text/markdown' : 'text/html']: ['.' + file.name.split('.').pop()]
                                    }
                                }]
                            });
                            const fileObj = await fileHandle.getFile();
                            const content = await fileObj.text();
                            zip.file(file.name, content);
                            fetchedFiles.push(file.name);
                        } catch (e) {
                            if (e.name !== 'AbortError') {
                                console.warn(`Error selecting ${file.name}:`, e);
                            }
                        }
                    }
                }
            }
            
            // Verify we have minimum required files
            const hasMinimumFiles = fetchedFiles.includes('index.html') && 
                                   fetchedFiles.includes('style.css') && 
                                   fetchedFiles.includes('app.js') && 
                                   fetchedFiles.includes('storage.js');
            
            if (!hasMinimumFiles) {
                const stillMissing = filesToGet.filter(f => f.required && !fetchedFiles.includes(f.name));
                alert(`Warning: Missing required files: ${stillMissing.map(f => f.name).join(', ')}\n\nThe zip will be created but the wiki may not work properly.\n\nTo fix: Run from a web server (not file://) or manually add the missing files.`);
            }
            
            // Generate zip file
            const blob = await zip.generateAsync({ type: 'blob' });
            
            // Download the zip
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'xoxowiki.zip';
            a.style.position = 'fixed';
            a.style.top = '-1000px';
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                if (document.body.contains(a)) {
                    document.body.removeChild(a);
                }
                URL.revokeObjectURL(url);
            }, 100);
            
            if (hasMinimumFiles) {
                this.showUpdateNotification(`Wiki code downloaded! Includes: ${fetchedFiles.join(', ')}. Extract and open index.html to run your own wiki.`);
            } else {
                this.showUpdateNotification(`Partial download: ${fetchedFiles.join(', ')}. Some files may be missing.`);
            }
        } catch (error) {
            console.error('Error downloading wiki code:', error);
            alert('Error downloading wiki code. To download manually:\n\n1. Download index.html\n2. Download style.css\n3. Download app.js\n4. Download storage.js\n5. Download README.md\n\nMake sure all files are in the same folder and open index.html in a web browser.');
        }
    }

    // Webcomic functions
    async loadWebcomicPages() {
        try {
            // Try to load from Bluesky first if connected
            if (this.storage.storageMode === 'bluesky' && this.storage.blueskyClient) {
                const blueskyPages = await this.storage.loadWebcomicPagesFromBluesky();
                if (blueskyPages && blueskyPages.length > 0) {
                    this.storage.saveWebcomicPages(blueskyPages);
                }
            }
            
            // Load read progress from Bluesky if connected
            if (this.storage.storageMode === 'bluesky' && this.storage.blueskyClient) {
                const blueskyProgress = await this.storage.loadWebcomicProgressFromBluesky();
                if (blueskyProgress) {
                    const localProgress = this.storage.getWebcomicReadProgress();
                    const userId = this.storage.blueskyClient.did;
                    localProgress[userId] = blueskyProgress[userId] || blueskyProgress;
                    this.storage.saveWebcomicReadProgress(localProgress);
                }
            }
        } catch (error) {
            console.error('Error loading webcomic pages:', error);
        }
    }

    renderWebcomicSection() {
        const pages = this.storage.getWebcomicPages();
        const readPages = this.storage.getReadWebcomicPages();
        
        if (pages.length === 0) {
            return `
                <div class="webcomic-section">
                    <div class="webcomic-header">
                        <h2>Webcomic</h2>
                        <div class="webcomic-header-actions">
                            <button class="btn-small" onclick="window.wikiApp.openUploadWebcomicModal()">+ Upload</button>
                        </div>
                    </div>
                    <p style="color: #72777d; text-align: center; padding: 2em;">No pages yet. Upload your first page!</p>
                </div>
            `;
        }

        // Ensure we have a valid page index
        if (this.currentWebcomicPageIndex === undefined || this.currentWebcomicPageIndex >= pages.length) {
            this.currentWebcomicPageIndex = pages.length - 1;
        }
        if (this.currentWebcomicPageIndex < 0) {
            this.currentWebcomicPageIndex = 0;
        }

        // Use stored index if available, otherwise find first unread or last page
        let currentPageIndex = this.currentWebcomicPageIndex !== undefined ? this.currentWebcomicPageIndex : pages.length - 1;
        if (this.currentWebcomicPageIndex === undefined) {
            for (let i = 0; i < pages.length; i++) {
                if (!this.storage.isWebcomicPageRead(pages[i].id)) {
                    currentPageIndex = i;
                    break;
                }
            }
            // Store the calculated index
            this.currentWebcomicPageIndex = currentPageIndex;
        }
        
        // Ensure index is valid
        currentPageIndex = Math.max(0, Math.min(currentPageIndex, pages.length - 1));
        this.currentWebcomicPageIndex = currentPageIndex; // Update stored index
        const currentPage = pages[currentPageIndex];
        const isRead = this.storage.isWebcomicPageRead(currentPage.id);
        
        // Build segmented progress bar
        const progressSegments = pages.map((page, idx) => {
            const isPageRead = this.storage.isWebcomicPageRead(page.id);
            const isCurrent = idx === currentPageIndex;
            return `<div class="webcomic-progress-segment ${isPageRead ? 'read' : ''} ${isCurrent ? 'current' : ''}" 
                onclick="window.wikiApp.goToWebcomicPage(${idx})" 
                title="Page ${idx + 1}${page.title ? ': ' + page.title : ''}"></div>`;
        }).join('');

        return `
            <div class="webcomic-section">
                <div class="webcomic-header">
                    <h2>Webcomic</h2>
                    <div class="webcomic-header-actions">
                        <button class="btn-small" onclick="window.wikiApp.openUploadWebcomicModal()">+ Upload</button>
                        <button class="btn-small btn-danger-small" onclick="window.wikiApp.deleteWebcomicPage('${currentPage.id}')">Delete</button>
                    </div>
                </div>
                
                <div class="webcomic-viewer">
                    <div class="webcomic-image-container" onclick="window.wikiApp.handleWebcomicImageClick(event, '${currentPage.id}')">
                        <div class="webcomic-image-left-click" onclick="event.stopPropagation(); window.wikiApp.previousWebcomicPage();"></div>
                        <div class="webcomic-image-right-click" onclick="event.stopPropagation(); window.wikiApp.nextWebcomicPage();"></div>
                        <img src="${currentPage.imageData}" alt="Page ${currentPage.pageNumber}${currentPage.title ? ` - ${currentPage.title}` : ''}" class="webcomic-image">
                        ${!isRead ? '<div class="webcomic-unread-indicator" id="webcomic-unread-' + currentPage.id + '">New</div>' : ''}
                    </div>
                    
                    <div class="webcomic-navigation">
                        <button class="webcomic-nav-btn" onclick="window.wikiApp.previousWebcomicPage()" ${currentPageIndex === 0 ? 'disabled' : ''}>←</button>
                        <div class="webcomic-progress-segments">${progressSegments}</div>
                        <button class="webcomic-nav-btn" onclick="window.wikiApp.nextWebcomicPage()" ${currentPageIndex === pages.length - 1 ? 'disabled' : ''}>→</button>
                    </div>
                </div>
            </div>
        `;
    }

    // ===== SECTION DRAG AND DROP =====
    setupSectionDragDrop() {
        const grid = document.getElementById('bento-grid');
        if (!grid) return;
        
        let draggedEl = null;
        let draggedNavBtn = null;
        let draggedAlbum = null;
        let dragStartPos = null;
        let isDragging = false;
        let lastMoveTime = 0;
        let moveTimeout = null;
        
        // Handle dragging existing sections within grid - allow dragging from anywhere
        grid.querySelectorAll('.draggable-section').forEach(section => {
            section.addEventListener('mousedown', (e) => {
                // Don't start drag if clicking on interactive elements
                if (e.target.closest('a, button, input, select, textarea')) {
                    return;
                }
                
                dragStartPos = { x: e.clientX, y: e.clientY };
                draggedEl = section;
                isDragging = false;
                
                const onMouseMove = (moveEvent) => {
                    if (!dragStartPos) return;
                    
                    const deltaX = Math.abs(moveEvent.clientX - dragStartPos.x);
                    const deltaY = Math.abs(moveEvent.clientY - dragStartPos.y);
                    
                    // If mouse moved more than 5px, start dragging
                    if (deltaX > 5 || deltaY > 5) {
                        isDragging = true;
                        section.classList.add('dragging');
                        section.style.cursor = 'grabbing';
                        section.style.transition = 'none'; // Disable transitions during drag
                    }
                };
                
                const self = this;
                const onMouseUp = (e) => {
                    if (isDragging && draggedEl) {
                        draggedEl.style.transition = '';
                        draggedEl.classList.remove('dragging');
                        draggedEl.style.cursor = '';
                        draggedEl.style.transform = '';
                        
                        // Save new order based on visual grid positions, not DOM order
                        // This ensures the order matches what the user sees
                        const sections = [...grid.querySelectorAll('.draggable-section')];
                        const newOrder = sections
                            .map(s => ({
                                section: s.dataset.section,
                                rect: s.getBoundingClientRect()
                            }))
                            .sort((a, b) => {
                                // Sort by top position first (row), then by left position (column)
                                const topDiff = a.rect.top - b.rect.top;
                                if (Math.abs(topDiff) > 10) { // Different rows (with some tolerance)
                                    return topDiff;
                                }
                                // Same row, sort by left position
                                return a.rect.left - b.rect.left;
                            })
                            .map(item => item.section)
                            .filter(s => s);
                        self.storage.saveSectionOrder(newOrder);
                        
                        // Set flag to prevent click navigation - use longer timeout to ensure click is blocked
                        self.wasDragged = true;
                        setTimeout(() => { self.wasDragged = false; }, 300);
                        // Also prevent the click event from firing
                        if (e) {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    }
                    dragStartPos = null;
                    draggedEl = null;
                    isDragging = false;
                    lastMoveTime = 0;
                    if (moveTimeout) {
                        clearTimeout(moveTimeout);
                        moveTimeout = null;
                    }
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };
                
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
        
        // Handle dragging from section nav buttons (using event delegation)
        document.addEventListener('dragstart', (e) => {
            const btn = e.target.closest('.section-nav-btn[data-section]');
            if (btn) {
                draggedNavBtn = btn;
                btn.style.opacity = '0.5';
                e.dataTransfer.effectAllowed = 'move';
            }
            
            // Handle dragging albums from bento
            const albumItem = e.target.closest('.bento-album-item');
            if (albumItem) {
                draggedAlbum = {
                    id: albumItem.dataset.albumId,
                    name: albumItem.dataset.albumName
                };
                albumItem.style.opacity = '0.5';
                e.dataTransfer.effectAllowed = 'move';
            }
        });
        
        document.addEventListener('dragend', (e) => {
            const btn = e.target.closest('.section-nav-btn[data-section]');
            if (btn) {
                btn.style.opacity = '1';
                draggedNavBtn = null;
                grid.classList.remove('drag-over');
            }
            
            const albumItem = e.target.closest('.bento-album-item');
            if (albumItem) {
                albumItem.style.opacity = '1';
                draggedAlbum = null;
                grid.classList.remove('drag-over');
            }
        });
        
        // Handle drop zone for nav buttons and albums
        grid.addEventListener('dragover', (e) => {
            if (draggedNavBtn || draggedAlbum) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                grid.classList.add('drag-over');
                
                // Find insertion point
                const sections = [...grid.querySelectorAll('.draggable-section:not(.dragging)')];
                const afterEl = sections.reduce((closest, child) => {
                    const box = child.getBoundingClientRect();
                    const offset = e.clientY - box.top - box.height / 2;
                    if (offset < 0 && offset > closest.offset) {
                        return { offset, element: child };
                    }
                    return closest;
                }, { offset: Number.NEGATIVE_INFINITY }).element;
                
                // Show drop indicator
                grid.querySelectorAll('.drop-indicator').forEach(ind => ind.remove());
                const indicator = document.createElement('div');
                indicator.className = 'drop-indicator';
                if (afterEl) {
                    grid.insertBefore(indicator, afterEl);
                } else {
                    grid.appendChild(indicator);
                }
            }
        });
        
        grid.addEventListener('dragleave', () => {
            grid.classList.remove('drag-over');
            grid.querySelectorAll('.drop-indicator').forEach(ind => ind.remove());
        });
        
        grid.addEventListener('drop', (e) => {
            e.preventDefault();
            grid.classList.remove('drag-over');
            grid.querySelectorAll('.drop-indicator').forEach(ind => ind.remove());
            
            if (draggedNavBtn) {
                const sectionName = draggedNavBtn.dataset.section;
                const currentOrder = this.storage.getSectionOrder() || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
                
                // Only add if not already in order
                if (!currentOrder.includes(sectionName)) {
                    // Find where to insert based on drop position
                    const sections = [...grid.querySelectorAll('.draggable-section')];
                    const dropY = e.clientY;
                    let insertIndex = currentOrder.length;
                    
                    for (let i = 0; i < sections.length; i++) {
                        const box = sections[i].getBoundingClientRect();
                        if (dropY < box.top + box.height / 2) {
                            const existingSection = sections[i].dataset.section;
                            insertIndex = currentOrder.indexOf(existingSection);
                            break;
                        }
                    }
                    
                    currentOrder.splice(insertIndex, 0, sectionName);
                    this.storage.saveSectionOrder(currentOrder);
                    
                    // Re-render the page to show the new section
                    this.showArticle('main');
                }
                draggedNavBtn = null;
            } else if (draggedAlbum) {
                // Create album-specific section name
                const sectionName = `album:${draggedAlbum.id}`;
                const currentOrder = this.storage.getSectionOrder() || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
                
                // Only add if not already in order
                if (!currentOrder.includes(sectionName)) {
                    // Find where to insert based on drop position
                    const sections = [...grid.querySelectorAll('.draggable-section')];
                    const dropY = e.clientY;
                    let insertIndex = currentOrder.length;
                    
                    for (let i = 0; i < sections.length; i++) {
                        const box = sections[i].getBoundingClientRect();
                        if (dropY < box.top + box.height / 2) {
                            const existingSection = sections[i].dataset.section;
                            insertIndex = currentOrder.indexOf(existingSection);
                            break;
                        }
                    }
                    
                    currentOrder.splice(insertIndex, 0, sectionName);
                    this.storage.saveSectionOrder(currentOrder);
                    
                    // Re-render the page to show the new album bento
                    this.showArticle('main');
                }
                draggedAlbum = null;
            }
        });
        
        const updateDragPosition = (e) => {
            if (!draggedEl || !isDragging || !grid) return;
            
            const sections = [...grid.querySelectorAll('.draggable-section:not(.dragging)')];
            if (sections.length === 0) return;
            
            const mouseX = e.clientX;
            const mouseY = e.clientY;
            
            // Find which section the mouse is currently over
            let hoveredEl = null;
            sections.forEach(child => {
                const box = child.getBoundingClientRect();
                // Check if mouse is within the bounds of this section
                if (mouseX >= box.left && mouseX <= box.right && 
                    mouseY >= box.top && mouseY <= box.bottom) {
                    hoveredEl = child;
                }
            });
            
            // If not hovering over any section, find the closest one
            if (!hoveredEl) {
                let minDistance = Infinity;
                sections.forEach(child => {
                    const box = child.getBoundingClientRect();
                    const centerX = box.left + box.width / 2;
                    const centerY = box.top + box.height / 2;
                    
                    // Calculate distance from mouse to center of element
                    const dx = mouseX - centerX;
                    const dy = mouseY - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    
                    if (distance < minDistance) {
                        minDistance = distance;
                        hoveredEl = child;
                    }
                });
            }
            
            if (!hoveredEl) return;
            
            // Determine if we should insert before or after based on mouse position relative to hovered element
            const hoveredBox = hoveredEl.getBoundingClientRect();
            const centerX = hoveredBox.left + hoveredBox.width / 2;
            const centerY = hoveredBox.top + hoveredBox.height / 2;
            
            // Use a balanced threshold (35% from center) for consistent behavior
            // This creates a neutral zone in the middle where we use the dominant direction
            const horizontalThreshold = hoveredBox.width * 0.35;
            const verticalThreshold = hoveredBox.height * 0.35;
            
            const horizontalDistance = Math.abs(mouseX - centerX);
            const verticalDistance = Math.abs(mouseY - centerY);
            
            // Determine which direction dominates
            let insertAfter = false;
            
            if (verticalDistance > horizontalDistance) {
                // Vertical movement dominates - use simple center check
                insertAfter = mouseY > centerY;
            } else {
                // Horizontal movement dominates - use balanced threshold
                // Only trigger if clearly past the threshold, not just slightly to the right
                if (mouseX > centerX + horizontalThreshold) {
                    // Clearly to the right - insert after
                    insertAfter = true;
                } else if (mouseX < centerX - horizontalThreshold) {
                    // Clearly to the left - insert before
                    insertAfter = false;
                } else {
                    // In the middle zone - use a slight bias but be more conservative
                    // Only insert after if mouse is slightly past center (not just anywhere in middle)
                    insertAfter = mouseX > centerX + (horizontalThreshold * 0.3);
                }
            }
            
            // Find insertion point
            let insertBeforeEl = null;
            if (insertAfter) {
                // Insert after hoveredEl
                insertBeforeEl = hoveredEl.nextElementSibling;
            } else {
                // Insert before hoveredEl
                insertBeforeEl = hoveredEl;
            }
            
            // Only update if position actually changed
            const currentNext = draggedEl.nextElementSibling;
            if (insertBeforeEl !== currentNext && insertBeforeEl !== draggedEl) {
                // Use requestAnimationFrame for smooth updates
                requestAnimationFrame(() => {
                    if (!draggedEl || !isDragging || !grid) return;
                    if (insertBeforeEl && insertBeforeEl !== draggedEl && insertBeforeEl.parentNode === grid) {
                        grid.insertBefore(draggedEl, insertBeforeEl);
                    } else if (!insertBeforeEl && draggedEl.parentNode === grid) {
                        grid.appendChild(draggedEl);
                    }
                });
            }
        };
        
        // Global mousemove handler for dragging sections
        const globalMouseMove = (e) => {
            if (!draggedEl || !isDragging) return;
            
            // Throttle DOM updates to prevent jumping (max 20fps for smooth but not excessive updates)
            const now = Date.now();
            if (now - lastMoveTime < 50) {
                if (moveTimeout) clearTimeout(moveTimeout);
                moveTimeout = setTimeout(() => {
                    updateDragPosition(e);
                }, 50);
                return;
            }
            lastMoveTime = now;
            updateDragPosition(e);
        };
        
        document.addEventListener('mousemove', globalMouseMove);
        
    }

    setBentoSize(sectionName, cols) {
        const grid = document.getElementById('bento-grid');
        const card = grid?.querySelector(`[data-section="${sectionName}"]`);
        if (!card) return;
        
        // Get current size or default to 1 row
        const currentSize = this.storage.getBentoSizes()[sectionName] || { cols: 1, rows: 1 };
        // For collections section, always make it square (rows = cols)
        const rows = sectionName === 'collections' ? cols : (currentSize.rows || 1);
        
        // Apply new size
        card.style.gridColumn = `span ${cols}`;
        card.style.gridRow = `span ${rows}`;
        
        // Add size class for CSS targeting
        card.classList.remove('bento-size-1', 'bento-size-2', 'bento-size-3');
        card.classList.add(`bento-size-${cols}`);
        
        // Save the new size (ensuring collections is always square)
        const sizeToSave = sectionName === 'collections' ? { cols, rows: cols } : { cols, rows };
        this.storage.saveBentoSize(sectionName, sizeToSave);
        
        // Update active state of buttons
        const controlsWrapper = card.querySelector('.bento-controls-wrapper');
        if (controlsWrapper) {
            const sizeControls = controlsWrapper.querySelector('.bento-size-controls');
            if (sizeControls) {
                sizeControls.querySelectorAll('.size-btn').forEach((btn, index) => {
                    const targetCols = index + 1;
                    btn.classList.toggle('active', targetCols === cols);
                });
            }
        }
        
        // Update album list size if this is the collections section
        if (sectionName === 'collections') {
            const albumsList = card.querySelector('.bento-albums-list');
            if (albumsList) {
                albumsList.classList.remove('bento-albums-small', 'bento-albums-medium', 'bento-albums-large');
                if (cols === 2) {
                    albumsList.classList.add('bento-albums-medium');
                } else if (cols === 3) {
                    albumsList.classList.add('bento-albums-large');
                } else {
                    albumsList.classList.add('bento-albums-small');
                }
            }
        }
        
    }

    toggleBentoEdit(sectionName, event) {
        if (event) event.stopPropagation();
        // Find the specific bento card that was clicked, not just the first one with this section name
        let card = event.target.closest('.bento-card[data-section]');
        if (!card || card.getAttribute('data-section') !== sectionName) {
            // Fallback to querySelector if closest doesn't work
            const grid = document.getElementById('bento-grid');
            card = grid?.querySelector(`[data-section="${sectionName}"]`);
            if (!card) return;
        }
        
        const controlsWrapper = card.querySelector('.bento-controls-wrapper');
        if (!controlsWrapper) return;
        
        // Get all control elements
        const moveControls = controlsWrapper.querySelector('.bento-move-controls');
        const deleteResizeWrapper = controlsWrapper.querySelector('.bento-delete-resize-wrapper');
        
        // Check if any controls are visible to determine current state
        const isVisible = moveControls && moveControls.style.display !== 'none';
        
        // Toggle visibility of all controls
        if (moveControls) {
            moveControls.style.display = isVisible ? 'none' : 'flex';
        }
        if (deleteResizeWrapper) {
            deleteResizeWrapper.style.display = isVisible ? 'none' : 'flex';
        }
        
        // If showing controls, make card draggable; if hiding, remove drag class
        if (!isVisible) {
            card.classList.add('bento-editing');
            controlsWrapper.style.opacity = '1'; // Make controls visible
        } else {
            card.classList.remove('bento-editing');
            controlsWrapper.style.opacity = ''; // Reset opacity
            // Remove moved class when exiting edit mode (with transition)
            if (card.classList.contains('bento-moved')) {
                // The CSS transition will handle the fade
                setTimeout(() => {
                    card.classList.remove('bento-moved');
                }, 10);
            }
            // Clear moved section tracking if this was the moved bento
            if (this.movedBentoSection === sectionName) {
                this.movedBentoSection = null;
            }
        }
    }

    deleteBento(sectionName, event) {
        if (event) event.stopPropagation();
        if (!confirm(`Remove "${sectionName}" bento from the grid?`)) return;
        
        // Find the specific bento card that was clicked
        const clickedCard = event.target.closest('.bento-card[data-section]');
        if (!clickedCard) return;
        
        const grid = document.getElementById('bento-grid');
        if (!grid) return;
        
        // Get all bento cards with the same section name
        const allCardsWithSameSection = Array.from(grid.querySelectorAll(`[data-section="${sectionName}"]`));
        
        // Find the index of the clicked card among cards with the same section
        const clickedIndex = allCardsWithSameSection.indexOf(clickedCard);
        if (clickedIndex === -1) return;
        
        // Get current order and find all instances of this section name
        const currentOrder = this.storage.getSectionOrder() || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
        const matchingIndices = [];
        currentOrder.forEach((s, index) => {
            if (s === sectionName) {
                matchingIndices.push(index);
            }
        });
        
        // Remove only the instance at the matching index
        if (clickedIndex < matchingIndices.length) {
            const indexToRemove = matchingIndices[clickedIndex];
            const newOrder = currentOrder.filter((s, index) => index !== indexToRemove);
            this.storage.saveSectionOrder(newOrder);
            
            // Re-render the page
            this.showArticle('main');
        }
    }

    showAddBentoMenu(event) {
        if (event) event.stopPropagation();
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Toggle menu visibility
        const isVisible = menu.style.display !== 'none';
        menu.style.display = isVisible ? 'none' : 'block';
        
        // Close menu when clicking outside
        if (!isVisible) {
            const closeMenu = (e) => {
                if (!addCard.contains(e.target)) {
                    menu.style.display = 'none';
                    document.removeEventListener('click', closeMenu);
                }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
        }
    }

    showArticleSelection(event) {
        if (event) event.stopPropagation();
        
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Get all articles except 'main'
        const articleKeys = Object.keys(this.articles).filter(k => k !== 'main');
        const currentOrder = this.storage.getSectionOrder() || [];
        const existingArticleBentos = currentOrder.filter(s => s.startsWith('article:'));
        const availableArticles = articleKeys.filter(key => {
            const articleBentoId = `article:${key}`;
            return !existingArticleBentos.includes(articleBentoId);
        });
        
        if (availableArticles.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">All articles added</div>';
            menu.style.display = 'block';
            return;
        }
        
        // If no articles exist at all
        if (articleKeys.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">No articles yet. Create one first!</div>';
            menu.style.display = 'block';
            return;
        }
        
        // Create searchable article list
        const articleListHtml = availableArticles.map(key => {
            const article = this.articles[key];
            const title = article?.title || key;
            const preview = article?.content ? article.content.substring(0, 100).replace(/<[^>]*>/g, '') : '';
            return `
                <button class="bento-add-option bento-add-article" onclick="window.wikiApp.addBento('article:${key}', event)" title="${preview}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>
                    <span style="flex: 1; text-align: left;">${title}</span>
                </button>
            `;
        }).join('');
        
        const searchHtml = `
            <div id="article-selection-list" style="max-height: 300px; overflow-y: auto;">
                ${articleListHtml}
            </div>
            <div style="padding: 0.5em; border-top: 1px solid #eaecf0; display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap;">
                <button class="bento-add-option" onclick="window.wikiApp.restoreAddBentoMenu(event)" style="justify-content: center; flex: 0 0 auto;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    <span>Back</span>
                </button>
                <input type="text" id="article-search-input" placeholder="Search articles..." style="flex: 1; min-width: 150px; padding: 0.5em; border: 1px solid #eaecf0; border-radius: 4px; font-size: 14px;" oninput="window.wikiApp.filterArticleSelection(this.value)">
                <button class="bento-add-option" onclick="window.wikiApp.addBento('random:articles', event)" style="justify-content: center; flex: 0 0 auto; background: #f0f7ff; color: #0645ad; font-weight: 500;">
                    <span>Random</span>
                </button>
            </div>
        `;
        
        menu.innerHTML = searchHtml;
        menu.style.display = 'block';
        
        // Focus search input
        setTimeout(() => {
            const searchInput = document.getElementById('article-search-input');
            if (searchInput) searchInput.focus();
        }, 0);
    }

    filterArticleSelection(searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const articleList = document.getElementById('article-selection-list');
        if (!articleList) return;
        
        const options = articleList.querySelectorAll('.bento-add-article');
        options.forEach(option => {
            const title = option.querySelector('span')?.textContent || '';
            const matches = title.toLowerCase().includes(searchLower);
            option.style.display = matches ? 'flex' : 'none';
        });
    }

    restoreAddBentoMenu(event) {
        if (event) event.stopPropagation();
        
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Rebuild the original menu content
        const sectionOrder = this.storage.getSectionOrder() || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
        const existingArticleBentos = sectionOrder.filter(s => s.startsWith('article:'));
        const existingAlbumBentos = sectionOrder.filter(s => s.startsWith('album:'));
        const availableBentos = [
            { id: 'welcome', name: 'Home', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
            { id: 'articles', name: 'Articles', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>' },
            { id: 'bookmarks', name: 'Bookmarks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' },
            { id: 'collections', name: 'Artboards', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' },
            { id: 'habits', name: 'Habits', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>' },
            { id: 'webcomic', name: 'Webcomic', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>' },
            { id: 'media', name: 'Image/Video', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' }
        ];
        
        const albums = this.storage.getAlbums();
        const availableAlbums = albums.filter(album => {
            const albumBentoId = `album:${album.id}`;
            return !existingAlbumBentos.includes(albumBentoId);
        });
        
        const menuOptions = [];
        
        // Add regular bentos
        if (availableBentos.length > 0) {
            menuOptions.push(...availableBentos.map(bento => {
                if (bento.id === 'articles') {
                    return `
                        <button class="bento-add-option" onclick="window.wikiApp.showArticleSelection(event)">
                            ${bento.icon}
                            <span>${bento.name}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    `;
                } else if (bento.id === 'collections') {
                    return `
                        <button class="bento-add-option" onclick="window.wikiApp.showCollectionSelection(event)">
                            ${bento.icon}
                            <span>${bento.name}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    `;
                } else if (bento.id === 'bookmarks') {
                    return `
                        <button class="bento-add-option" onclick="window.wikiApp.showBookmarkSelection(event)">
                            ${bento.icon}
                            <span>${bento.name}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    `;
                } else if (bento.id === 'habits') {
                    return `
                        <button class="bento-add-option" onclick="window.wikiApp.showHabitSelection(event)">
                            ${bento.icon}
                            <span>${bento.name}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    `;
                } else if (bento.id === 'media') {
                    return `
                        <button class="bento-add-option" onclick="window.wikiApp.showMediaSelection(event)">
                            ${bento.icon}
                            <span>${bento.name}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-left: auto;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    `;
                }
                return `
                    <button class="bento-add-option" onclick="window.wikiApp.addBento('${bento.id}', event)">
                        ${bento.icon}
                        <span>${bento.name}</span>
                    </button>
                `;
            }));
        }
        
        // Note: Individual collections are now shown in the collection selection menu, not here
        
        const menuContent = menuOptions.length > 0 
            ? menuOptions.join('')
            : '<div class="bento-add-empty">All bentos added</div>';
        
        menu.innerHTML = menuContent;
        menu.style.display = 'block';
    }

    showMediaSelection(event) {
        if (event) event.stopPropagation();
        
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Get all media items from archive
        const archive = this.storage.getArchive();
        const currentOrder = this.storage.getSectionOrder() || [];
        const existingMediaBentos = currentOrder.filter(s => s.startsWith('media:'));
        const availableMedia = archive.filter(item => {
            const mediaBentoId = `media:${item.id}`;
            return !existingMediaBentos.includes(mediaBentoId);
        });
        
        if (availableMedia.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">All media files added</div>';
            menu.style.display = 'block';
            return;
        }
        
        // If no media exists at all
        if (archive.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">No media files yet. Upload some first!</div>';
            menu.style.display = 'block';
            return;
        }
        
        // Create searchable media list
        const mediaListHtml = availableMedia.map(item => {
            const name = item.name || 'Untitled';
            const truncatedName = name.length > 22 ? name.substring(0, 22) + '...' : name;
            const itemId = item.id;
            const thumbnail = item.type === 'video'
                ? `<video data-media-thumb-id="${itemId}" controls playsinline style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                : `<img data-media-thumb-id="${itemId}" alt="${name}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; background: #f0f0f0;">`;
            
            // Load thumbnail asynchronously
            setTimeout(() => {
                this.loadArchiveItemImage(item).then(result => {
                    const { imageData, videoUrl } = this._archiveMediaFromResult(result, item);
                    const el = document.querySelector(`[data-media-thumb-id="${itemId}"]`);
                    if (!el) return;
                    if (item.type === 'video') {
                        const src = videoUrl || imageData;
                        if (src) el.src = src;
                        if (imageData) el.poster = imageData;
                    } else if (imageData) {
                        el.src = imageData;
                    }
                });
            }, 100);
            
            return `
                <button class="bento-add-option bento-add-media" onclick="window.wikiApp.addBento('media:${item.id}', event)" title="${name}">
                    ${thumbnail}
                    <span style="flex: 1; text-align: left;">${truncatedName}</span>
                </button>
            `;
        }).join('');
        
        const searchHtml = `
            <div id="media-selection-list" style="max-height: 300px; overflow-y: auto;">
                ${mediaListHtml}
            </div>
            <div style="padding: 0.5em; border-top: 1px solid #eaecf0; display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap;">
                <button class="bento-add-option" onclick="window.wikiApp.restoreAddBentoMenu(event)" style="justify-content: center; flex: 0 0 auto;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    <span>Back</span>
                </button>
                <input type="text" id="media-search-input" placeholder="Search media..." style="flex: 1; min-width: 150px; padding: 0.5em; border: 1px solid #eaecf0; border-radius: 4px; font-size: 14px;" oninput="window.wikiApp.filterMediaSelection(this.value)">
                <button class="bento-add-option" onclick="window.wikiApp.addBento('random:media', event)" style="justify-content: center; flex: 0 0 auto; background: #f0f7ff; color: #0645ad; font-weight: 500;">
                    <span>Random</span>
                </button>
            </div>
        `;
        
        menu.innerHTML = searchHtml;
        menu.style.display = 'block';
        
        // Focus search input
        setTimeout(() => {
            const searchInput = document.getElementById('media-search-input');
            if (searchInput) searchInput.focus();
        }, 0);
    }

    filterMediaSelection(searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const mediaList = document.getElementById('media-selection-list');
        if (!mediaList) return;
        
        const options = mediaList.querySelectorAll('.bento-add-media');
        options.forEach(option => {
            const name = option.querySelector('span')?.textContent || '';
            const matches = name.toLowerCase().includes(searchLower);
            option.style.display = matches ? 'flex' : 'none';
        });
    }

    showCollectionSelection(event) {
        if (event) event.stopPropagation();
        
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Get all collections (albums)
        const albums = this.storage.getAlbums();
        const currentOrder = this.storage.getSectionOrder() || [];
        const existingAlbumBentos = currentOrder.filter(s => s.startsWith('album:'));
        const availableAlbums = albums.filter(album => {
            const albumBentoId = `album:${album.id}`;
            return !existingAlbumBentos.includes(albumBentoId);
        });
        
        if (availableAlbums.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">All artboards added</div>';
            menu.style.display = 'block';
            return;
        }
        
        // If no collections exist at all
        if (albums.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">No artboards yet. Create one first!</div>';
            menu.style.display = 'block';
            return;
        }
        
        // Create searchable collection list
        const collectionListHtml = availableAlbums.map(album => {
            const archive = this.storage.getArchive();
            const albumItems = archive.filter(item => {
                const itemAlbums = item.albumIds || (item.albumId ? [item.albumId] : []);
                return itemAlbums.includes(album.id);
            });
            const count = albumItems.length;
            return `
                <button class="bento-add-option bento-add-collection" onclick="window.wikiApp.addBento('album:${album.id}', event)" title="${album.name}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                    <span style="flex: 1; text-align: left;">${album.name}</span>
                    ${count > 0 ? `<span style="font-size: 12px; color: #72777d;">${count}</span>` : ''}
                </button>
            `;
        }).join('');
        
        const searchHtml = `
            <div id="collection-selection-list" style="max-height: 300px; overflow-y: auto;">
                ${collectionListHtml}
            </div>
            <div style="padding: 0.5em; border-top: 1px solid #eaecf0; display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap;">
                <button class="bento-add-option" onclick="window.wikiApp.restoreAddBentoMenu(event)" style="justify-content: center; flex: 0 0 auto;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    <span>Back</span>
                </button>
                <input type="text" id="collection-search-input" placeholder="Search artboards..." style="flex: 1; min-width: 150px; padding: 0.5em; border: 1px solid #eaecf0; border-radius: 4px; font-size: 14px;" oninput="window.wikiApp.filterCollectionSelection(this.value)">
                <button class="bento-add-option" onclick="window.wikiApp.addBento('random:collections', event)" style="justify-content: center; flex: 0 0 auto; background: #f0f7ff; color: #0645ad; font-weight: 500;">
                    <span>Random</span>
                </button>
            </div>
        `;
        
        menu.innerHTML = searchHtml;
        menu.style.display = 'block';
        
        // Focus search input
        setTimeout(() => {
            const searchInput = document.getElementById('collection-search-input');
            if (searchInput) searchInput.focus();
        }, 0);
    }

    filterCollectionSelection(searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const collectionList = document.getElementById('collection-selection-list');
        if (!collectionList) return;
        
        const options = collectionList.querySelectorAll('.bento-add-collection');
        options.forEach(option => {
            const name = option.querySelector('span')?.textContent || '';
            const matches = name.toLowerCase().includes(searchLower);
            option.style.display = matches ? 'flex' : 'none';
        });
    }

    showBookmarkSelection(event) {
        if (event) event.stopPropagation();
        
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Get all bookmarks
        const bookmarks = this.storage.getBookmarks();
        const currentOrder = this.storage.getSectionOrder() || [];
        const existingBookmarkBentos = currentOrder.filter(s => s.startsWith('bookmark:'));
        const availableBookmarks = bookmarks.filter(key => {
            const bookmarkBentoId = `bookmark:${key}`;
            return !existingBookmarkBentos.includes(bookmarkBentoId) && this.articles[key];
        });
        
        if (availableBookmarks.length === 0 && bookmarks.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">No bookmarks yet. Bookmark some articles first!</div>';
            menu.style.display = 'block';
            return;
        }
        
        if (availableBookmarks.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">All bookmarks added</div>';
            menu.style.display = 'block';
            return;
        }
        
        // Create searchable bookmark list
        const bookmarkListHtml = availableBookmarks.map(key => {
            const article = this.articles[key];
            const title = article?.title || key;
            return `
                <button class="bento-add-option bento-add-bookmark" onclick="window.wikiApp.addBento('bookmark:${key}', event)" title="${title}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                    <span style="flex: 1; text-align: left;">${title}</span>
                </button>
            `;
        }).join('');
        
        const searchHtml = `
            <div id="bookmark-selection-list" style="max-height: 300px; overflow-y: auto;">
                ${bookmarkListHtml}
            </div>
            <div style="padding: 0.5em; border-top: 1px solid #eaecf0; display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap;">
                <button class="bento-add-option" onclick="window.wikiApp.restoreAddBentoMenu(event)" style="justify-content: center; flex: 0 0 auto;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    <span>Back</span>
                </button>
                <input type="text" id="bookmark-search-input" placeholder="Search bookmarks..." style="flex: 1; min-width: 150px; padding: 0.5em; border: 1px solid #eaecf0; border-radius: 4px; font-size: 14px;" oninput="window.wikiApp.filterBookmarkSelection(this.value)">
                <button class="bento-add-option" onclick="window.wikiApp.addBento('random:bookmarks', event)" style="justify-content: center; flex: 0 0 auto; background: #f0f7ff; color: #0645ad; font-weight: 500;">
                    <span>Random</span>
                </button>
            </div>
        `;
        
        menu.innerHTML = searchHtml;
        menu.style.display = 'block';
        
        // Focus search input
        setTimeout(() => {
            const searchInput = document.getElementById('bookmark-search-input');
            if (searchInput) searchInput.focus();
        }, 0);
    }

    filterBookmarkSelection(searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const bookmarkList = document.getElementById('bookmark-selection-list');
        if (!bookmarkList) return;
        
        const options = bookmarkList.querySelectorAll('.bento-add-bookmark');
        options.forEach(option => {
            const name = option.querySelector('span')?.textContent || '';
            const matches = name.toLowerCase().includes(searchLower);
            option.style.display = matches ? 'flex' : 'none';
        });
    }

    showHabitSelection(event) {
        if (event) event.stopPropagation();
        
        const addCard = event.target.closest('.bento-add');
        if (!addCard) return;
        
        const menu = addCard.querySelector('.bento-add-menu');
        if (!menu) return;
        
        // Get all habits
        const habits = this.storage.getHabits();
        const currentOrder = this.storage.getSectionOrder() || [];
        const existingHabitBentos = currentOrder.filter(s => s.startsWith('habit:'));
        const availableHabits = habits.filter(habit => {
            const habitBentoId = `habit:${habit}`;
            return !existingHabitBentos.includes(habitBentoId);
        });
        
        if (availableHabits.length === 0 && habits.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">No habits yet. Create some habits first!</div>';
            menu.style.display = 'block';
            return;
        }
        
        if (availableHabits.length === 0) {
            menu.innerHTML = '<div class="bento-add-empty">All habits added</div>';
            menu.style.display = 'block';
            return;
        }
        
        // Create searchable habit list
        const habitListHtml = availableHabits.map(habit => {
            return `
                <button class="bento-add-option bento-add-habit" onclick="window.wikiApp.addBento('habit:${habit}', event)" title="${habit}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
                    <span style="flex: 1; text-align: left;">${habit}</span>
                </button>
            `;
        }).join('');
        
        const searchHtml = `
            <div id="habit-selection-list" style="max-height: 300px; overflow-y: auto;">
                ${habitListHtml}
            </div>
            <div style="padding: 0.5em; border-top: 1px solid #eaecf0; display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap;">
                <button class="bento-add-option" onclick="window.wikiApp.restoreAddBentoMenu(event)" style="justify-content: center; flex: 0 0 auto;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    <span>Back</span>
                </button>
                <input type="text" id="habit-search-input" placeholder="Search habits..." style="flex: 1; min-width: 150px; padding: 0.5em; border: 1px solid #eaecf0; border-radius: 4px; font-size: 14px;" oninput="window.wikiApp.filterHabitSelection(this.value)">
                <button class="bento-add-option" onclick="window.wikiApp.addBento('random:habits', event)" style="justify-content: center; flex: 0 0 auto; background: #f0f7ff; color: #0645ad; font-weight: 500;">
                    <span>Random</span>
                </button>
            </div>
        `;
        
        menu.innerHTML = searchHtml;
        menu.style.display = 'block';
        
        // Focus search input
        setTimeout(() => {
            const searchInput = document.getElementById('habit-search-input');
            if (searchInput) searchInput.focus();
        }, 0);
    }

    filterHabitSelection(searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const habitList = document.getElementById('habit-selection-list');
        if (!habitList) return;
        
        const options = habitList.querySelectorAll('.bento-add-habit');
        options.forEach(option => {
            const name = option.querySelector('span')?.textContent || '';
            const matches = name.toLowerCase().includes(searchLower);
            option.style.display = matches ? 'flex' : 'none';
        });
    }

    addBento(sectionName, event) {
        if (event) event.stopPropagation();
        
        const currentOrder = this.storage.getSectionOrder() || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
        
        // Allow duplicates for regular bentos (welcome, articles, bookmarks, collections, habits, webcomic)
        // But prevent duplicates for specific items (article:, album:, media:)
        const isSpecificItem = sectionName.includes(':');
        if (isSpecificItem && currentOrder.includes(sectionName)) {
            return; // Don't add duplicate specific items
        }
        
        // Add to the end of the order (before the add button)
        currentOrder.push(sectionName);
        this.storage.saveSectionOrder(currentOrder);
        
        // Re-render the page
        this.showArticle('main');
    }

    moveBentoPosition(sectionName, direction) {
        const grid = document.getElementById('bento-grid');
        if (!grid) return;
        
        const currentOrder = this.storage.getSectionOrder() || ['welcome', 'articles', 'bookmarks', 'collections', 'habits', 'webcomic'];
        const currentIndex = currentOrder.indexOf(sectionName);
        
        if (currentIndex === -1) return;
        
        let newIndex = currentIndex;
        const gridCols = 3; // Number of columns in the grid
        
        switch (direction) {
            case 'left':
                // Move one position earlier (left in grid)
                newIndex = Math.max(0, currentIndex - 1);
                break;
            case 'right':
                // Move one position later (right in grid)
                newIndex = Math.min(currentOrder.length - 1, currentIndex + 1);
                break;
            case 'up':
                // Move up one row (3 positions earlier)
                newIndex = Math.max(0, currentIndex - gridCols);
                break;
            case 'down':
                // Move down one row (3 positions later)
                newIndex = Math.min(currentOrder.length - 1, currentIndex + gridCols);
                break;
        }
        
        if (newIndex !== currentIndex) {
            // Check if this bento is currently in edit mode
            const card = grid?.querySelector(`[data-section="${sectionName}"]`);
            const isInEditMode = card && card.classList.contains('bento-editing');
            
            // Remove from current position
            currentOrder.splice(currentIndex, 1);
            // Insert at new position
            currentOrder.splice(newIndex, 0, sectionName);
            
            // Save new order
            this.storage.saveSectionOrder(currentOrder);
            
            // Store section name to add moved class and restore edit mode after re-render
            // IMPORTANT: Set these BEFORE calling showArticle so they're available during HTML generation
            this.movedBentoSection = sectionName;
            this.bentoToRestoreEditMode = isInEditMode ? sectionName : null;
            
            // Re-render the page to show the new order
            // The HTML generation will check these variables and add classes directly
            this.showArticle('main');
        }
    }

    setupWebcomicListeners() {
        // Only set initial index if not already set
        const pages = this.storage.getWebcomicPages();
        if (this.currentWebcomicPageIndex === undefined && pages.length > 0) {
            let currentPageIndex = pages.length - 1;
            for (let i = 0; i < pages.length; i++) {
                if (!this.storage.isWebcomicPageRead(pages[i].id)) {
                    currentPageIndex = i;
                    break;
                }
            }
            this.currentWebcomicPageIndex = currentPageIndex;
        } else if (pages.length === 0) {
            this.currentWebcomicPageIndex = 0;
        }
        // Ensure index is valid
        if (this.currentWebcomicPageIndex !== undefined && pages.length > 0) {
            this.currentWebcomicPageIndex = Math.max(0, Math.min(this.currentWebcomicPageIndex, pages.length - 1));
        }
        
        // Add swipe gesture support for webcomic
        const webcomicContainer = document.querySelector('.webcomic-image-container');
        if (webcomicContainer) {
            let touchStartX = 0;
            webcomicContainer.addEventListener('touchstart', (e) => {
                touchStartX = e.touches[0].clientX;
            }, { passive: true });
            webcomicContainer.addEventListener('touchend', (e) => {
                const touchEndX = e.changedTouches[0].clientX;
                const diff = touchStartX - touchEndX;
                if (Math.abs(diff) > 50) {
                    if (diff > 0) this.nextWebcomicPage();
                    else this.previousWebcomicPage();
                }
            }, { passive: true });
        }
    }

    previousWebcomicPage() {
        const pages = this.storage.getWebcomicPages();
        if (pages.length === 0) return;
        
        // Ensure index is valid
        if (this.currentWebcomicPageIndex === undefined) {
            this.currentWebcomicPageIndex = pages.length - 1;
        }
        
        if (this.currentWebcomicPageIndex > 0) {
            this.currentWebcomicPageIndex--;
            this.updateWebcomicDisplay();
        }
    }

    nextWebcomicPage() {
        const pages = this.storage.getWebcomicPages();
        if (pages.length === 0) return;
        
        // Ensure index is valid
        if (this.currentWebcomicPageIndex === undefined) {
            this.currentWebcomicPageIndex = 0;
        }
        
        if (this.currentWebcomicPageIndex < pages.length - 1) {
            this.currentWebcomicPageIndex++;
            this.updateWebcomicDisplay();
        }
    }

    goToWebcomicPage(index) {
        const pages = this.storage.getWebcomicPages();
        if (pages.length === 0 || index < 0 || index >= pages.length) return;
        this.currentWebcomicPageIndex = index;
        this.updateWebcomicDisplay();
    }

    updateWebcomicDisplay() {
        if (this.currentArticleKey === 'main') {
            const container = document.getElementById('article-container');
            const webcomicHtml = this.renderWebcomicSection();
            const webcomicSection = container.querySelector('.webcomic-section');
            if (webcomicSection) {
                webcomicSection.outerHTML = webcomicHtml;
                this.setupWebcomicListeners();
            }
        }
    }

    handleWebcomicImageClick(event, pageId) {
        // Mark as read when clicking on the image (center area)
        this.markPageAsRead(pageId);
    }

    markPageAsRead(pageId) {
        this.storage.markWebcomicPageAsRead(pageId);
        // Remove the "New" indicator immediately if it exists
        const unreadIndicator = document.getElementById('webcomic-unread-' + pageId);
        if (unreadIndicator) {
            unreadIndicator.remove();
        }
        // Force immediate update of the display
        this.updateWebcomicDisplay();
        this.showUpdateNotification('Page marked as read!');
    }

    async deleteWebcomicPage(pageId) {
        if (!confirm('Are you sure you want to delete this page?')) {
            return;
        }
        
        this.storage.deleteWebcomicPage(pageId);
        await this.loadWebcomicPages();
        this.updateWebcomicDisplay();
        this.showUpdateNotification('Page deleted!');
    }

    openUploadWebcomicModal() {
        document.getElementById('webcomic-upload-modal').style.display = 'flex';
        document.getElementById('webcomic-image-input').value = '';
        document.getElementById('webcomic-title-input').value = '';
        document.getElementById('webcomic-page-number-input').value = '';
    }

    closeUploadWebcomicModal() {
        document.getElementById('webcomic-upload-modal').style.display = 'none';
    }

    async uploadWebcomicPage() {
        const fileInput = document.getElementById('webcomic-image-input');
        const titleInput = document.getElementById('webcomic-title-input');
        const pageNumberInput = document.getElementById('webcomic-page-number-input');
        
        if (!fileInput.files || fileInput.files.length === 0) {
            alert('Please select at least one image file.');
            return;
        }

        const files = Array.from(fileInput.files);
        const invalidFiles = files.filter(file => !file.type.startsWith('image/'));
        
        if (invalidFiles.length > 0) {
            alert('Please select only image files (jpg, png, gif, etc.).');
            return;
        }

        const title = titleInput.value.trim();
        const startPageNumber = pageNumberInput.value ? parseInt(pageNumberInput.value) : null;
        
        // Show loading notification
        this.showUpdateNotification(`Uploading ${files.length} page(s)...`);
        
        let uploadedCount = 0;
        let errorCount = 0;
        
        // Process files sequentially to avoid overwhelming the browser
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const pageNumber = startPageNumber !== null ? startPageNumber + i : null;
            
            try {
                await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        try {
                            const imageData = e.target.result;
                            this.storage.addWebcomicPage(imageData, title, pageNumber);
                            uploadedCount++;
                            resolve();
                        } catch (error) {
                            errorCount++;
                            reject(error);
                        }
                    };
                    reader.onerror = () => {
                        errorCount++;
                        reject(new Error('Failed to read file'));
                    };
                    reader.readAsDataURL(file);
                });
            } catch (error) {
                console.error(`Error uploading file ${file.name}:`, error);
            }
        }
        
        await this.loadWebcomicPages();
        this.closeUploadWebcomicModal();
        this.updateWebcomicDisplay();
        
        if (errorCount === 0) {
            this.showUpdateNotification(`Successfully uploaded ${uploadedCount} page(s)!`);
        } else {
            this.showUpdateNotification(`Uploaded ${uploadedCount} page(s), ${errorCount} failed.`);
        }
    }

    // ===== RIGHT SIDEBAR UPDATE =====
    updateRightSidebar() {
        const rightSidebar = document.querySelector('.mw-sidebar-right-content');
        if (!rightSidebar) return;
        
        // Keep existing sync section, add activity and habits
        const activityHtml = this.renderActivityFeedCompact();
        const habitHtml = this.renderHabitTrackerCompact();
        
        // Find or create activity container
        let activityContainer = rightSidebar.querySelector('.sidebar-activity');
        if (!activityContainer) {
            activityContainer = document.createElement('div');
            activityContainer.className = 'sidebar-activity';
            const storageSection = rightSidebar.querySelector('.storage-section');
            if (storageSection) {
                storageSection.insertAdjacentElement('afterend', activityContainer);
            }
        }
        activityContainer.innerHTML = activityHtml;
        
        // Find or create habit container
        let habitContainer = rightSidebar.querySelector('.sidebar-habits');
        if (!habitContainer) {
            habitContainer = document.createElement('div');
            habitContainer.className = 'sidebar-habits';
            rightSidebar.appendChild(habitContainer);
        }
        habitContainer.innerHTML = habitHtml;
    }

    // ===== HABIT TRACKER (COMPACT FOR SIDEBAR) =====
    habitTrackerDate = null; // Track selected date

    renderHabitsBento() {
        const habits = this.storage.getHabits();
        if (habits.length === 0) {
            return '<p class="bento-empty">No habits yet. Click to add your first habit!</p>';
        }
        
        const today = new Date().toISOString().split('T')[0];
        const log = this.storage.getHabitLog();
        const checked = log[today] || [];
        
        // Show first 3-4 habits with checkboxes
        const habitsToShow = habits.slice(0, 4);
        const habitsHtml = habitsToShow.map((h, idx) => {
            const color = this.getHabitColor(idx);
            const streak = this.storage.getStreak(h);
            return `
                <div class="bento-habit-item">
                    <label class="habit-compact ${checked.includes(h) ? 'checked' : ''}" title="${h}">
                        <input type="checkbox" ${checked.includes(h) ? 'checked' : ''} onchange="window.wikiApp.toggleHabit('${today}', '${h}'); event.stopPropagation();">
                        <span class="habit-color-dot" style="background:${color};"></span>
                        <span>${h}</span>
                        ${streak > 1 ? `<span class="habit-streak-mini">${streak}d</span>` : ''}
                    </label>
                </div>
            `;
        }).join('');
        
        // Small activity grid preview (last 4 weeks)
        const gridHtml = this.renderHabitGrid(habits, log, 4);
        
        const moreCount = habits.length > 4 ? ` +${habits.length - 4} more` : '';
        
        return `
            <div class="bento-habits-content">
                <div class="bento-habits-list">${habitsHtml}</div>
                ${moreCount ? `<div class="bento-habits-more">${moreCount}</div>` : ''}
                <div class="bento-habits-grid">${gridHtml}</div>
            </div>
        `;
    }

    renderHabitTrackerCompact(date = null) {
        const today = date || this.habitTrackerDate || new Date().toISOString().split('T')[0];
        this.habitTrackerDate = today;
        const actualToday = new Date().toISOString().split('T')[0];
        const habits = this.storage.getHabits();
        const log = this.storage.getHabitLog();
        const checked = log[today] || [];
        
        const habitsHtml = habits.map((h, idx) => {
            const color = this.getHabitColor(idx);
            return `
                <label class="habit-compact ${checked.includes(h) ? 'checked' : ''}" title="${h}">
                    <input type="checkbox" ${checked.includes(h) ? 'checked' : ''} onchange="window.wikiApp.toggleHabit('${today}', '${h}')">
                    <span class="habit-color-dot" style="background:${color};"></span>
                    <a href="#habits" class="habit-name-link" onclick="window.wikiApp.navigate('habits'); return false;">${h}</a>
                    ${this.storage.getStreak(h) > 1 ? `<span class="habit-streak-mini">${this.storage.getStreak(h)}d</span>` : ''}
                </label>
            `;
        }).join('');
        
        // GitHub-style grid for last 8 weeks (56 days)
        const gridHtml = this.renderHabitGrid(habits, log);
        
        // Format current date nicely - single line
        const dateObj = new Date(today + 'T12:00:00');
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const isToday = today === actualToday;
        
        return `
            <div class="habit-tracker-compact" id="habit-tracker" data-date="${today}">
                <div class="habit-header">
                    <a href="#habits" class="habit-title-link" onclick="window.wikiApp.navigate('habits'); return false;"><h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon-sm"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>Habit Tracker</h3></a>
                </div>
                <div class="habit-date-nav">
                    <button class="habit-date-btn" onclick="window.wikiApp.changeHabitTrackerDate(-1)">‹</button>
                    <div class="habit-date-wrapper-single ${isToday ? 'today' : ''}" onclick="window.wikiApp.resetHabitTrackerDate()">
                        ${dateStr}
                    </div>
                    <button class="habit-date-btn" onclick="window.wikiApp.changeHabitTrackerDate(1)" ${today >= actualToday ? 'disabled' : ''}>›</button>
                </div>
                <div class="habit-list-compact">${habitsHtml}</div>
                <div class="habit-grid-container">${gridHtml}</div>
                <div class="habit-actions">
                    <button class="habit-add-btn" onclick="window.wikiApp.addHabit()">+ Add</button>
                    <button class="habit-insights-btn" onclick="window.wikiApp.navigate('habits')">View All</button>
                </div>
            </div>
        `;
    }

    // Habit colors - each habit gets a unique color
    habitColors = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c', '#e91e63', '#00bcd4'];

    getHabitColor(index) {
        return this.habitColors[index % this.habitColors.length];
    }

    renderHabitGrid(habits, log, weeks = 8) {
        if (habits.length === 0) return '<p style="font-size:11px;color:#72777d;margin:0.5em 0;">Add habits to see your progress grid</p>';
        
        // Build grid: 7 rows (days of week) x N columns (weeks)
        const today = new Date();
        
        // Get start of current week (Sunday)
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay());
        
        // Go back N weeks
        const startDate = new Date(startOfWeek);
        startDate.setDate(startDate.getDate() - ((weeks - 1) * 7));
        
        const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        
        // Build header row with day labels
        let gridHtml = '<div class="habit-calendar">';
        gridHtml += '<div class="habit-cal-row habit-cal-header">';
        gridHtml += '<div class="habit-cal-label"></div>';
        dayNames.forEach(d => gridHtml += `<div class="habit-cal-day-label">${d}</div>`);
        gridHtml += '</div>';
        
        // Build a row for each habit
        habits.forEach((habit, hIdx) => {
            const color = this.getHabitColor(hIdx);
            gridHtml += `<div class="habit-cal-row">`;
            gridHtml += `<div class="habit-cal-label" title="${habit}" style="color:${color};">${habit.charAt(0).toUpperCase()}</div>`;
            
            // For each day in the grid
            for (let w = 0; w < weeks; w++) {
                for (let d = 0; d < 7; d++) {
                    const cellDate = new Date(startDate);
                    cellDate.setDate(startDate.getDate() + (w * 7) + d);
                    const key = cellDate.toISOString().split('T')[0];
                    const dayLog = log[key] || [];
                    const done = dayLog.includes(habit);
                    const isToday = key === today.toISOString().split('T')[0];
                    const isFuture = cellDate > today;
                    const dayNum = cellDate.getDate();
                    
                    gridHtml += `<div class="habit-cal-cell ${done ? 'done' : ''} ${isToday ? 'today' : ''} ${isFuture ? 'future' : ''}" 
                        style="${done ? `background:${color};` : ''}"
                        title="${cellDate.toLocaleDateString()} - ${habit}: ${done ? 'done' : ''}"
                        ${!isFuture ? `onclick="window.wikiApp.toggleHabitCell('${key}','${habit}')"` : ''}>
                        ${isToday ? dayNum : ''}
                    </div>`;
                }
            }
            gridHtml += '</div>';
        });
        
        gridHtml += '</div>';
        
        // Legend
        gridHtml += '<div class="habit-legend">';
        habits.forEach((h, i) => {
            const color = this.getHabitColor(i);
            gridHtml += `<span class="habit-legend-item"><span class="habit-legend-dot" style="background:${color};"></span>${h}</span>`;
        });
        gridHtml += '</div>';
        
        return gridHtml;
    }

    toggleHabitCell(date, habit) {
        this.storage.toggleHabit(date, habit);
        this.updateRightSidebar();
    }

    changeHabitTrackerDate(delta) {
        const current = this.habitTrackerDate || new Date().toISOString().split('T')[0];
        const d = new Date(current + 'T12:00:00');
        d.setDate(d.getDate() + delta);
        const newDate = d.toISOString().split('T')[0];
        const today = new Date().toISOString().split('T')[0];
        // Don't go past today
        if (newDate <= today) {
            this.habitTrackerDate = newDate;
            this.updateRightSidebar();
        }
    }

    resetHabitTrackerDate() {
        this.habitTrackerDate = new Date().toISOString().split('T')[0];
        this.updateRightSidebar();
    }

    showHabitsPage() {
        const container = document.getElementById('article-container');
        if (!container) return;
        
        this.currentArticleKey = 'habits';
        const habits = this.storage.getHabits();
        const log = this.storage.getHabitLog();
        
        // Calculate stats for each habit
        const habitStats = habits.map((h, idx) => {
            const streak = this.storage.getStreak(h);
            const color = this.getHabitColor(idx);
            let totalDays = 0;
            Object.values(log).forEach(day => {
                if (day.includes(h)) totalDays++;
            });
            return { name: h, streak, totalDays, color };
        });
        
        const gridHtml = this.renderHabitGrid(habits, log);
        
        container.innerHTML = `
            ${this.renderSectionNav()}
            <div class="article-header">
                <h1>Habits</h1>
            </div>
            
            <div class="habits-page">
                <div class="habits-stats-grid">
                    ${habitStats.map(h => `
                        <div class="habit-stat-card" style="border-left: 4px solid ${h.color};">
                            <h4>${h.name}</h4>
                            <div class="habit-stat-row">
                                <span class="stat-label">Current Streak</span>
                                <span class="stat-value">${h.streak} days</span>
                            </div>
                            <div class="habit-stat-row">
                                <span class="stat-label">Total Days</span>
                                <span class="stat-value">${h.totalDays}</span>
                            </div>
                            <button class="btn-small btn-danger-small" onclick="window.wikiApp.deleteHabit('${h.name}')" style="margin-top:0.5em;">Delete</button>
                        </div>
                    `).join('')}
                    <div class="habit-stat-card add-habit-card" onclick="window.wikiApp.addHabit()">
                        <span class="add-habit-icon">+</span>
                        <span>Add Habit</span>
                    </div>
                </div>
                
                <h2>Activity Grid</h2>
                <div class="habits-full-grid">${gridHtml}</div>
            </div>
        `;
        
        // Hide TOC and show sidebar sections
        const tocContainer = document.getElementById('table-of-contents');
        if (tocContainer) {
            tocContainer.style.display = 'none';
        }
        const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
        const sidebarThoughts = document.getElementById('sidebar-thoughts');
        const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
        const sidebarMenu = document.querySelector('.mw-sidebar-menu');
        
        if (sidebarBookmarks) sidebarBookmarks.style.display = 'block';
        if (sidebarThoughts) sidebarThoughts.style.display = 'block';
        if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'block';
        if (sidebarMenu) sidebarMenu.style.display = 'block';
        
        this.updateRightSidebar();
    }

    deleteHabit(name) {
        if (confirm(`Delete habit "${name}"? This will remove all tracking data for this habit.`)) {
            const habits = this.storage.getHabits().filter(h => h !== name);
            this.storage.saveHabits(habits);
            // Also remove from log
            const log = this.storage.getHabitLog();
            Object.keys(log).forEach(date => {
                log[date] = log[date].filter(h => h !== name);
            });
            this.storage.saveHabitLog(log);
            this.showHabitsPage();
        }
    }

    showHabitInsights() {
        const habits = this.storage.getHabits();
        const log = this.storage.getHabitLog();
        
        let totalDays = 0;
        let totalCompletions = 0;
        const streaks = {};
        
        habits.forEach(h => {
            streaks[h] = this.storage.getStreak(h);
        });
        
        Object.values(log).forEach(day => {
            totalDays++;
            totalCompletions += day.length;
        });
        
        const avgPerDay = totalDays > 0 ? (totalCompletions / totalDays).toFixed(1) : 0;
        const bestHabit = Object.entries(streaks).sort((a, b) => b[1] - a[1])[0];
        
        alert(`Habit Insights\n\n` +
            `Total tracked days: ${totalDays}\n` +
            `Average habits/day: ${avgPerDay}\n` +
            `Best streak: ${bestHabit ? `${bestHabit[0]} (${bestHabit[1]} days)` : 'None yet'}\n\n` +
            `Current streaks:\n${habits.map(h => `  ${h}: ${streaks[h]} days`).join('\n')}`);
    }

    // Keep full version for potential standalone use
    renderHabitTracker(date = null) {
        return this.renderHabitTrackerCompact(date);
    }

    toggleHabit(date, habit) {
        this.storage.toggleHabit(date, habit);
        this.storage.logActivity('habit', { habit, date });
        const tracker = document.getElementById('habit-tracker');
        if (tracker) tracker.outerHTML = this.renderHabitTracker(date);
    }

    changeHabitDate(delta) {
        const tracker = document.getElementById('habit-tracker');
        if (!tracker) return;
        let currentDate = tracker.dataset.date;
        if (delta === 0) currentDate = new Date().toISOString().split('T')[0];
        else {
            const d = new Date(currentDate + 'T12:00:00');
            d.setDate(d.getDate() + delta);
            currentDate = d.toISOString().split('T')[0];
        }
        tracker.outerHTML = this.renderHabitTracker(currentDate);
    }

    addHabit() {
        const name = prompt('New habit name:');
        if (name && name.trim()) {
            const habits = this.storage.getHabits();
            habits.push(name.trim());
            this.storage.saveHabits(habits);
            const tracker = document.getElementById('habit-tracker');
            if (tracker) tracker.outerHTML = this.renderHabitTracker(tracker.dataset.date);
        }
    }

    // ===== ARCHIVE IMAGE LOADING =====
    async loadArchiveItemImage(item) {
        if (!item) return null;
        try {
            const imageData = await this.storage.getArchiveItemImageData(item);
            if (item.type === 'video') {
                const videoUrl = await this.storage.getArchiveItemVideoUrl(item);
                return { imageData, videoUrl: videoUrl || item.videoUrl };
            }
            return imageData;
        } catch (error) {
            console.warn('Failed to load image:', error);
            return item.type === 'video' ? { imageData: item.imageData || null, videoUrl: item.videoUrl || null } : (item.imageData || null);
        }
    }

    _archiveMediaFromResult(result, item) {
        if (result == null) return { imageData: null, videoUrl: null };
        if (typeof result === 'object' && 'videoUrl' in result) return { imageData: result.imageData, videoUrl: result.videoUrl || (item && item.videoUrl) };
        return { imageData: result, videoUrl: (item && item.videoUrl) || null };
    }

    // ===== MEDIA UPLOAD (in Create Modal) =====
    pendingMediaFiles = [];

    async handleMediaFiles(files) {
        const fileArray = Array.from(files);
        for (const file of fileArray) {
            if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue;
            
            const reader = new FileReader();
            await new Promise((resolve) => {
                reader.onload = async (e) => {
                    try {
                        const data = e.target.result;
                        const type = file.type.startsWith('video/') ? 'video' : 'image';
                        
                        this.pendingMediaFiles.push({ 
                            data: data, 
                            name: file.name,
                            type: type,
                            albumIds: [], // Track albums per image
                            assignmentType: 'albums', // Default to albums
                            articleIds: [], // Track articles per image
                            habitDays: [] // Track habit days: [{date: '2026-01-27', habit: 'Workout'}]
                        });
                        this.updateMediaPreview();
                    } catch (error) {
                        console.error('Error processing file:', file.name, error);
                    }
                    resolve();
                };
                reader.onerror = () => {
                    console.error('Failed to read file:', file.name);
                    resolve();
                };
                reader.readAsDataURL(file);
            });
        }
    }

    async updateMediaPreview() {
        const preview = document.getElementById('media-preview');
        if (!preview) return;
        const collections = this.storage.getAlbums(); // Will rename this function later
        const articles = await this.storage.getAllArticles();
        const habits = this.storage.getHabits();
        const articleKeys = Object.keys(articles);
        
        // Bulk assignment section (only show if multiple files)
        let bulkAssignmentHtml = '';
        if (this.pendingMediaFiles.length > 1) {
            const bulkCollectionCheckboxes = collections.map(collection => {
                // Check if ALL files have this collection
                const allHaveCollection = this.pendingMediaFiles.every(f => 
                    (f.albumIds || []).includes(collection.id)
                );
                return `
                    <label class="media-album-checkbox-label">
                        <input type="checkbox" 
                               value="${collection.id}" 
                               ${allHaveCollection ? 'checked' : ''}
                               onchange="window.wikiApp.toggleBulkCollection('${collection.id}', this.checked)">
                        <span>${collection.name}</span>
                    </label>
                `;
            }).join('');
            
            bulkAssignmentHtml = `
                <div class="bulk-assignment-section" style="margin-bottom: 1.5em; padding: 1em; background: #f8f9fa; border-radius: 8px; border: 1px solid #eaecf0;">
                    <div style="font-weight: bold; margin-bottom: 0.5em; color: #0645ad;">Assign to All Images (${this.pendingMediaFiles.length} files):</div>
                    <div class="media-preview-albums-list">
                        ${collections.length > 0 ? bulkCollectionCheckboxes : '<span class="no-albums-text">No artboards yet</span>'}
                    </div>
                    <button class="btn-small media-new-album-btn" onclick="window.wikiApp.createCollectionAndAddToAll()" style="margin-top:0.5em;">+ New Artboard</button>
                </div>
            `;
        }
        
        preview.innerHTML = bulkAssignmentHtml + this.pendingMediaFiles.map((f, i) => {
            const assignmentType = f.assignmentType || 'albums';
            
            // Collections section
            const collectionCheckboxes = collections.map(collection => {
                const checked = (f.albumIds || []).includes(collection.id) ? 'checked' : '';
                return `
                    <label class="media-album-checkbox-label">
                        <input type="checkbox" 
                               value="${collection.id}" 
                               ${checked}
                               onchange="window.wikiApp.toggleImageCollection(${i}, '${collection.id}')">
                        <span>${collection.name}</span>
                    </label>
                `;
            }).join('');
            
            // Articles section
            const articleCheckboxes = articleKeys.map(key => {
                const article = articles[key];
                const checked = (f.articleIds || []).includes(key) ? 'checked' : '';
                return `
                    <label class="media-album-checkbox-label">
                        <input type="checkbox" 
                               value="${key}" 
                               ${checked}
                               onchange="window.wikiApp.toggleImageArticle(${i}, '${key}')">
                        <span>${article.title || key}</span>
                    </label>
                `;
            }).join('');
            
            // Habit days section
            const habitDaysHtml = (f.habitDays || []).map((hd, hdIdx) => {
                const habitOptions = habits.map(h => `<option value="${h}" ${hd.habit === h ? 'selected' : ''}>${h}</option>`).join('');
                return `
                    <div class="media-habit-day-item">
                        <input type="date" 
                               value="${hd.date}" 
                               onchange="window.wikiApp.updateHabitDay(${i}, ${hdIdx}, 'date', this.value)"
                               class="media-habit-date-input">
                        <select onchange="window.wikiApp.updateHabitDay(${i}, ${hdIdx}, 'habit', this.value)" class="media-habit-select">
                            ${habitOptions}
                        </select>
                        <button class="btn-small" onclick="window.wikiApp.removeHabitDay(${i}, ${hdIdx})" style="padding:0.2em 0.4em;">×</button>
                    </div>
                `;
            }).join('');
            
            const assignmentTypeSelect = `
                <select onchange="window.wikiApp.setImageAssignmentType(${i}, this.value)" class="media-assignment-type-select">
                    <option value="albums" ${assignmentType === 'albums' ? 'selected' : ''}>Artboards</option>
                    <option value="articles" ${assignmentType === 'articles' ? 'selected' : ''}>Articles</option>
                    <option value="habit-days" ${assignmentType === 'habit-days' ? 'selected' : ''}>Habit Days</option>
                </select>
            `;
            
            let assignmentContent = '';
            if (assignmentType === 'albums') {
                assignmentContent = `
                    <div class="media-preview-albums-label">Artboards:</div>
                    <div class="media-preview-albums-list">
                        ${collections.length > 0 ? collectionCheckboxes : '<span class="no-albums-text">No artboards yet</span>'}
                    </div>
                    <button class="btn-small media-new-album-btn" onclick="window.wikiApp.createCollectionAndAddToImage(${i})" style="margin-top:0.5em;">+ New Artboard</button>
                `;
            } else if (assignmentType === 'articles') {
                assignmentContent = `
                    <div class="media-preview-albums-label">Articles:</div>
                    <div class="media-preview-albums-list">
                        ${articleKeys.length > 0 ? articleCheckboxes : '<span class="no-albums-text">No articles yet</span>'}
                    </div>
                `;
            } else if (assignmentType === 'habit-days') {
                assignmentContent = `
                    <div class="media-preview-albums-label">Habit Days:</div>
                    <div class="media-habit-days-list">
                        ${habitDaysHtml || '<span class="no-albums-text">No habit days added</span>'}
                    </div>
                    <button class="btn-small media-new-album-btn" onclick="window.wikiApp.addHabitDay(${i})" style="margin-top:0.5em;">+ Add Habit Day</button>
                `;
            }
            
            return `
                <div class="media-preview-item">
                    <div class="archive-preview-item">
                        ${f.type === 'video' 
                            ? `<video src="${f.data || f.videoUrl || f.imageUrl || ''}" ${f.videoUrl && f.imageUrl ? `poster="${f.imageUrl}"` : ''} style="width:100%;height:100%;object-fit:cover;"></video>`
                            : `<img src="${f.data || f.imageUrl || ''}" alt="${f.name}" onerror="this.style.display='none'">`}
                        <button class="remove-btn" onclick="window.wikiApp.removeMediaFile(${i})">×</button>
                    </div>
                    <div class="media-preview-albums">
                        <div class="media-assignment-type-wrapper">
                            <label class="media-assignment-type-label">Assign to:</label>
                            ${assignmentTypeSelect}
                        </div>
                        ${assignmentContent}
                    </div>
                </div>
            `;
        }).join('');
    }
    
    setImageAssignmentType(imageIndex, type) {
        const file = this.pendingMediaFiles[imageIndex];
        if (!file) return;
        file.assignmentType = type;
        this.updateMediaPreview();
    }
    
    toggleImageCollection(imageIndex, collectionId) {
        const file = this.pendingMediaFiles[imageIndex];
        if (!file) return;
        
        if (!file.albumIds) file.albumIds = [];
        const index = file.albumIds.indexOf(collectionId);
        if (index > -1) {
            file.albumIds.splice(index, 1);
        } else {
            file.albumIds.push(collectionId);
        }
        this.updateMediaPreview();
    }
    
    // Alias for backward compatibility
    
    toggleBulkCollection(collectionId, checked) {
        // Apply collection to all pending files
        this.pendingMediaFiles.forEach(file => {
            if (!file.albumIds) file.albumIds = [];
            const index = file.albumIds.indexOf(collectionId);
            if (checked && index === -1) {
                file.albumIds.push(collectionId);
            } else if (!checked && index > -1) {
                file.albumIds.splice(index, 1);
            }
        });
        this.updateMediaPreview();
    }
    
    createCollectionAndAddToAll() {
        const name = prompt('Artboard name:');
        if (name && name.trim()) {
            const collection = this.storage.saveAlbum({ name: name.trim() });
            // Add to all files
            this.pendingMediaFiles.forEach(file => {
                if (!file.albumIds) file.albumIds = [];
                if (!file.albumIds.includes(collection.id)) {
                    file.albumIds.push(collection.id);
                }
            });
            this.updateMediaPreview();
        }
    }
    
    createCollectionAndAddToImage(imageIndex) {
        const name = prompt('Artboard name:');
        if (name && name.trim()) {
            const collection = this.storage.saveAlbum({ name: name.trim() });
            const file = this.pendingMediaFiles[imageIndex];
            if (file) {
                if (!file.albumIds) file.albumIds = [];
                if (!file.albumIds.includes(collection.id)) {
                    file.albumIds.push(collection.id);
                }
            }
            this.updateMediaPreview();
        }
    }
    
    toggleImageArticle(imageIndex, articleKey) {
        const file = this.pendingMediaFiles[imageIndex];
        if (!file) return;
        
        if (!file.articleIds) file.articleIds = [];
        const index = file.articleIds.indexOf(articleKey);
        if (index > -1) {
            file.articleIds.splice(index, 1);
        } else {
            file.articleIds.push(articleKey);
        }
        this.updateMediaPreview();
    }
    
    addHabitDay(imageIndex) {
        const file = this.pendingMediaFiles[imageIndex];
        if (!file) return;
        
        if (!file.habitDays) file.habitDays = [];
        const today = new Date().toISOString().split('T')[0];
        const habits = this.storage.getHabits();
        file.habitDays.push({
            date: today,
            habit: habits[0] || ''
        });
        this.updateMediaPreview();
    }
    
    updateHabitDay(imageIndex, habitDayIndex, field, value) {
        const file = this.pendingMediaFiles[imageIndex];
        if (!file || !file.habitDays || !file.habitDays[habitDayIndex]) return;
        
        file.habitDays[habitDayIndex][field] = value;
        this.updateMediaPreview();
    }
    
    removeHabitDay(imageIndex, habitDayIndex) {
        const file = this.pendingMediaFiles[imageIndex];
        if (!file || !file.habitDays) return;
        
        file.habitDays.splice(habitDayIndex, 1);
        this.updateMediaPreview();
    }

    removeMediaFile(index) {
        this.pendingMediaFiles.splice(index, 1);
        this.updateMediaPreview();
    }

    async saveMediaItems() {
        console.log('saveMediaItems called', { fileCount: this.pendingMediaFiles.length });
        try {
            // If nothing added yet but URL field has text, act as if Add was clicked
            if (this.pendingMediaFiles.length === 0) {
                const mediaImageUrlInput = document.getElementById('media-image-url');
                const url = mediaImageUrlInput?.value?.trim() || '';
                if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                    if (this.storage._parseBskyPostUrl(url)) {
                        const { items, error } = await this.storage.fetchPostMediaFromUrl(url);
                        if (error) {
                            alert(error);
                            return;
                        }
                        for (const it of items) {
                            this.pendingMediaFiles.push({
                                data: null,
                                imageUrl: it.imageUrl,
                                videoUrl: it.videoUrl || null,
                                name: it.name || (it.type === 'video' ? 'Video from post' : 'Image from post'),
                                type: it.type || 'image',
                                albumIds: [],
                                assignmentType: 'albums',
                                articleIds: [],
                                habitDays: [],
                                source: it.source || url,
                                authorHandle: it.authorHandle,
                                authorDid: it.authorDid,
                                authorDisplayName: it.authorDisplayName,
                                postText: it.postText ?? it.textSnippet
                            });
                        }
                        if (mediaImageUrlInput) mediaImageUrlInput.value = '';
                        const sourceInput = document.getElementById('media-source');
                        if (sourceInput) sourceInput.value = '';
                        this.updateMediaPreview();
                    } else {
                        this.pendingMediaFiles.push({
                            data: null,
                            imageUrl: url,
                            name: 'Image from URL',
                            type: 'image',
                            albumIds: [],
                            assignmentType: 'albums',
                            articleIds: [],
                            habitDays: []
                        });
                        if (mediaImageUrlInput) mediaImageUrlInput.value = '';
                        this.updateMediaPreview();
                    }
                }
            }
            if (this.pendingMediaFiles.length === 0) {
                alert('Please add at least one image or video (or paste an image URL).');
                return;
            }
            
            // Uploads are stored in IndexedDB only (no disk write, no download)
            const source = document.getElementById('media-source')?.value?.trim() || '';
            let savedCount = 0;
            let errorCount = 0;
            const errors = [];
            
            // Process files sequentially to avoid overwhelming storage
            for (const f of this.pendingMediaFiles) {
                try {
                    const assignmentType = f.assignmentType || 'albums';
                    const item = {
                        name: f.name,
                        type: f.type,
                        source: f.source || source,
                        assignmentType
                    };
                    if (f.imageUrl) {
                        item.imageUrl = f.imageUrl;
                    } else {
                        item.imageData = f.data;
                    }
                    if (f.videoUrl) item.videoUrl = f.videoUrl;
                    if (f.authorHandle) item.authorHandle = f.authorHandle;
                    if (f.authorDid) item.authorDid = f.authorDid;
                    if (f.authorDisplayName) item.authorDisplayName = f.authorDisplayName;
                    if (f.postText) item.postText = f.postText;
                    if (assignmentType === 'albums') {
                        item.albumIds = f.albumIds || [];
                    } else if (assignmentType === 'articles') {
                        item.articleIds = f.articleIds || [];
                    } else if (assignmentType === 'habit-days') {
                        item.habitDays = f.habitDays || [];
                    }
                    
                    await this.storage.saveArchiveItem(item);
                    savedCount++;
                } catch (error) {
                    console.error('Error saving media item:', error, f);
                    errorCount++;
                    errors.push({ name: f.name, error: error.message });
                    if (error.message && error.message.includes('select')) {
                        alert(`Cannot save "${f.name}": ${error.message}`);
                    } else if (error.message && error.message.includes('quota')) {
                        const usage = this.storage.getStorageUsage();
                        const archiveSize = this.storage.getArchiveSize();
                        const message = `Storage quota exceeded. Cannot save "${f.name}".\n\n` +
                            `Current storage: ${usage.totalMB}MB\n` +
                            `Archive: ${archiveSize.itemCount} items (${archiveSize.sizeMB}MB)\n\n` +
                            `Please delete some items from the archive or use smaller images.`;
                        alert(message);
                    }
                }
            }
            
            if (errorCount > 0) {
                const errorDetails = errors.map(e => `- ${e.name}: ${e.error}`).join('\n');
                alert(`Saved ${savedCount} item(s), but ${errorCount} item(s) failed to save:\n\n${errorDetails}`);
            } else {
                this.storage.logActivity('archive', { count: savedCount });
                this.showUpdateNotification(`Added ${savedCount} item(s) to archive!`);
            }
            
            this.pendingMediaFiles = [];
            this.updateMediaPreview();
            // Clear Media tab form so next upload doesn't inherit source/URL
            const mediaSourceInput = document.getElementById('media-source');
            const mediaImageUrlInput = document.getElementById('media-image-url');
            if (mediaSourceInput) mediaSourceInput.value = '';
            if (mediaImageUrlInput) mediaImageUrlInput.value = '';
            this.closeModal();
            // Always show collection page so new uploads are visible
            this.navigate('collection');
        } catch (error) {
            console.error('Error in saveMediaItems:', error);
            alert('An error occurred while saving. Check console for details.');
        }
    }

    updateAlbumSelect() {
        // Update album checkboxes in preview when albums change
        if (this.pendingMediaFiles.length > 0) {
            this.updateMediaPreview();
        }
    }

    createAlbum() {
        const name = prompt('Artboard name:');
        if (name && name.trim()) {
            this.storage.saveAlbum({ name: name.trim() });
            this.updateAlbumSelect();
            // Refresh collection page if on it
            if (this.currentArticleKey === 'collection') this.showCollectionPage();
        }
    }
    
    // Alias for consistency
    async deleteAlbum(albumId) {
        const albums = this.storage.getAlbums();
        const album = albums.find(a => a.id === albumId);
        if (!album) return;
        
        if (confirm(`Are you sure you want to delete the artboard "${album.name}"? This will remove the artboard but keep all media items.`)) {
            try {
                await this.storage.deleteAlbum(albumId);
            } catch (e) {
                alert('Could not delete artboard from PDS: ' + (e.message || e));
                return;
            }
            this.updateAlbumSelect();
            if (this.currentArticleKey === 'archive' || this.currentArticleKey === 'collection') {
                this.showCollectionPage();
            }
            this.renderSections();
        }
    }
    
    createAlbumAndAddToImage(imageIndex) {
        const name = prompt('Artboard name:');
        if (name && name.trim()) {
            const album = this.storage.saveAlbum({ name: name.trim() });
            const file = this.pendingMediaFiles[imageIndex];
            if (file) {
                if (!file.albumIds) file.albumIds = [];
                if (!file.albumIds.includes(album.id)) {
                    file.albumIds.push(album.id);
                }
            }
            this.updateMediaPreview();
            // Refresh collection page if on it
            if (this.currentArticleKey === 'collection') this.showCollectionPage();
        }
    }

    // ===== BROWSE PAGE (AT Protocol feed) =====
    browseFeedCursor = null;
    browseFeedItems = [];
    browseFeedLoading = false;

    getAvailableFeeds() {
        const isLoggedIn = this.storage.storageMode === 'bluesky' && this.storage.blueskyClient?.accessJwt;
        const feeds = [];
        
        if (isLoggedIn) {
            feeds.push({ type: 'timeline', name: 'Your Timeline', description: 'Posts from people you follow' });
        }
        
        feeds.push(
            { type: 'whats-hot', name: "What's Hot", description: 'Popular posts right now', uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot' },
            { type: 'custom', name: 'Discover', description: 'Discover new content', uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/discover' }
        );
        
        // Add saved custom feeds
        const customFeeds = this.storage.getCustomFeeds();
        customFeeds.forEach(feed => {
            feeds.push({
                type: 'custom',
                name: feed.name,
                description: feed.description || '',
                uri: feed.uri
            });
        });
        
        return feeds;
    }

    formatRelativeTime(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        
        const now = new Date();
        const diffMs = now - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        const diffWeeks = Math.floor(diffDays / 7);
        const diffMonths = Math.floor(diffDays / 30);
        const diffYears = Math.floor(diffDays / 365);
        
        if (diffSecs < 60) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        if (diffWeeks < 4) return `${diffWeeks}w ago`;
        if (diffMonths < 12) return `${diffMonths}mo ago`;
        return `${diffYears}y ago`;
    }

    async showBrowsePage(cursor = null, append = false) {
        const container = document.getElementById('article-container');
        if (!container) return;
        
        // Prevent multiple simultaneous loads
        if (this.browseFeedLoading) return;
        
        this.currentArticleKey = 'browse';
        const isLoggedIn = this.storage.storageMode === 'bluesky' && this.storage.blueskyClient?.accessJwt;
        const selectedFeed = this.storage.getSelectedFeed();
        const availableFeeds = this.getAvailableFeeds();
        
        // Only initialize HTML if not appending
        if (!append) {
            const feedSelectorHtml = `
                <div class="browse-feed-selector" style="margin-bottom: 1em; display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap;">
                    <label for="browse-feed-select" style="font-weight: 600; font-size: 0.9rem;">Feed:</label>
                    <select id="browse-feed-select" style="padding: 0.4em 0.6em; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; background: white; cursor: pointer; min-width: 200px;">
                        ${availableFeeds.map(feed => {
                            const isSelected = feed.type === 'timeline' 
                                ? (selectedFeed.type === 'timeline')
                                : (selectedFeed.uri && feed.uri && selectedFeed.uri === feed.uri);
                            return `<option value="${feed.type}" data-uri="${feed.uri || ''}" ${isSelected ? 'selected' : ''}>${this.escapeHtml(feed.name)}</option>`;
                        }).join('')}
                    </select>
                    <button type="button" id="browse-feed-search-btn" class="btn-secondary" style="font-size: 0.85rem; padding: 0.4em 0.8em;">Search Feeds</button>
                    <span class="browse-feed-description" style="color: #555; font-size: 0.85rem;">
                        ${availableFeeds.find(f => {
                            if (selectedFeed.type === 'timeline') return f.type === 'timeline';
                            return f.uri && selectedFeed.uri && f.uri === selectedFeed.uri;
                        })?.description || ''}
                    </span>
                </div>
            `;
            
            container.innerHTML = `
                <div class="browse-page-header">
                    <h1>Browse Bluesky</h1>
                    ${feedSelectorHtml}
                    <div class="browse-loading" id="browse-loading">Loading feed…</div>
                </div>
                <div id="browse-grid" class="archive-page-grid"></div>
                <div id="browse-load-more" style="text-align:center;margin:1.5em 0;display:none;">
                    <button type="button" class="btn-primary" id="browse-load-more-btn">Load more</button>
                </div>
            `;
            this.browseFeedItems = [];
            // Remove old scroll listener if it exists
            if (this._browseScrollHandler) {
                window.removeEventListener('scroll', this._browseScrollHandler);
                this._browseScrollHandler = null;
            }
            
            // Set up feed selector change handler
            const feedSelect = document.getElementById('browse-feed-select');
            const feedDescription = document.querySelector('.browse-feed-description');
            if (feedSelect) {
                feedSelect.addEventListener('change', (e) => {
                    const selectedOption = e.target.options[e.target.selectedIndex];
                    const feedType = selectedOption.value;
                    const feedUri = selectedOption.getAttribute('data-uri') || '';
                    const feed = availableFeeds.find(f => {
                        if (feedType === 'timeline') return f.type === 'timeline';
                        return f.uri === feedUri;
                    });
                    
                    if (!feed) return;
                    
                    const feedData = feedType === 'timeline' 
                        ? { type: 'timeline', name: feed.name }
                        : { type: 'custom', name: feed.name, uri: feedUri };
                    
                    this.storage.setSelectedFeed(feedData);
                    if (feedDescription) {
                        feedDescription.textContent = feed.description || '';
                    }
                    
                    // Reload feed
                    this.browseFeedCursor = null;
                    this.showBrowsePage(null, false);
                });
            }
            
            // Set up feed search button
            const feedSearchBtn = document.getElementById('browse-feed-search-btn');
            if (feedSearchBtn) {
                feedSearchBtn.addEventListener('click', () => {
                    this.showFeedSearchModal();
                });
            }
        }
        
        const grid = document.getElementById('browse-grid');
        const loadingEl = document.getElementById('browse-loading');
        const loadMoreWrap = document.getElementById('browse-load-more');
        const loadMoreBtn = document.getElementById('browse-load-more-btn');
        
        if (!grid) return;
        
        this.browseFeedLoading = true;
        if (loadingEl && !append) {
            loadingEl.style.display = 'block';
        }
        if (loadMoreBtn) {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = 'Loading...';
        }
        
        try {
            const selectedFeed = this.storage.getSelectedFeed();
            const { items, cursor: nextCursor } = await this.storage.fetchBrowseFeed(cursor, 30, selectedFeed);
            this.browseFeedCursor = nextCursor;
            
            if (loadingEl) loadingEl.style.display = 'none';
            
            if (items.length === 0) {
                if (!append) {
                    grid.innerHTML = '<p class="archive-empty">No images or videos in this batch. Try again later.</p>';
                }
            } else {
                const startIdx = this.browseFeedItems.length;
                this.browseFeedItems = this.browseFeedItems.concat(items);
                
                const itemsHtml = items.map((item, idx) => {
                    const actualIdx = startIdx + idx;
                    const url = item.videoUrl || item.imageUrl;
                    const thumbUrl = item.imageUrl;
                    const author = (item.authorHandle || '').replace(/"/g, '&quot;');
                    const text = (item.textSnippet || '').replace(/"/g, '&quot;').slice(0, 80);
                    const addId = `browse-add-${actualIdx}`;
                    const relativeTime = item.createdAt ? this.formatRelativeTime(item.createdAt) : '';
                    return `
                        <div class="archive-page-item browse-item browse-item-clickable" data-browse-index="${actualIdx}">
                            ${item.type === 'video'
                                ? `<video src="${url}" class="browse-media" muted loop playsinline></video>`
                                : `<img src="${thumbUrl}" alt="${item.alt || ''}" class="browse-media" loading="lazy">`}
                            <div class="browse-item-info">
                                <div class="browse-author-row">
                                    <span class="browse-author">@${author}</span>
                                    ${relativeTime ? `<span class="browse-time">${relativeTime}</span>` : ''}
                                </div>
                                ${text ? `<p class="browse-snippet">${this.escapeHtml(text)}${(item.textSnippet || '').length > 80 ? '…' : ''}</p>` : ''}
                                <button type="button" class="btn-primary btn-small browse-add-btn" id="${addId}" data-image-url="${this.escapeHtml(url)}" data-author="${this.escapeHtml(author)}">Add to collection</button>
                            </div>
                        </div>
                    `;
                }).join('');
                
                if (append) {
                    grid.insertAdjacentHTML('beforeend', itemsHtml);
                } else {
                    grid.innerHTML = itemsHtml;
                    // Set up click handler once
                    grid.addEventListener('click', (e) => {
                        const card = e.target.closest('.browse-item');
                        if (!card) return;
                        if (e.target.closest('.browse-add-btn')) return;
                        const idx = parseInt(card.getAttribute('data-browse-index'), 10);
                        if (!isNaN(idx) && this.browseFeedItems && this.browseFeedItems[idx]) {
                            this.showBrowsePostModal(this.browseFeedItems[idx]);
                        }
                    });
                }
                
                // Set up click handlers for new items
                items.forEach((item, idx) => {
                    const actualIdx = startIdx + idx;
                    const btn = document.getElementById(`browse-add-${actualIdx}`);
                    if (btn) {
                        btn.addEventListener('click', (e) => { e.stopPropagation(); this.showBrowseAddModal(item); });
                    }
                });
            }
            
            if (nextCursor) {
                if (loadMoreWrap) loadMoreWrap.style.display = 'block';
                if (loadMoreBtn) {
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.textContent = 'Load more';
                    loadMoreBtn.onclick = () => this.showBrowsePage(nextCursor);
                }
                
                // Set up infinite scroll if not already set up
                if (!this._browseScrollHandler) {
                    this._browseScrollHandler = () => {
                        // Check if user is near bottom (within 300px)
                        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
                        const windowHeight = window.innerHeight;
                        const docHeight = document.documentElement.scrollHeight;
                        
                        if (scrollTop + windowHeight >= docHeight - 300 && !this.browseFeedLoading && nextCursor) {
                            this.showBrowsePage(nextCursor, true);
                        }
                    };
                    window.addEventListener('scroll', this._browseScrollHandler);
                }
            } else {
                if (loadMoreWrap) loadMoreWrap.style.display = 'none';
                // Remove scroll listener when no more items
                if (this._browseScrollHandler) {
                    window.removeEventListener('scroll', this._browseScrollHandler);
                    this._browseScrollHandler = null;
                }
            }
        } catch (err) {
            console.error('Browse feed error:', err);
            const msg = err && err.message ? err.message : 'Check your connection or try again.';
            if (loadingEl) {
                loadingEl.textContent = 'Could not load feed. ' + msg;
                loadingEl.style.display = 'block';
            }
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = 'Load more';
            }
        } finally {
            this.browseFeedLoading = false;
        }
        
        if (!append) {
            const tocContainer = document.getElementById('table-of-contents');
            if (tocContainer) tocContainer.style.display = 'none';
            const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
            const sidebarThoughts = document.getElementById('sidebar-thoughts');
            const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
            const sidebarMenu = document.querySelector('.mw-sidebar-menu');
            if (sidebarBookmarks) sidebarBookmarks.style.display = 'block';
            if (sidebarThoughts) sidebarThoughts.style.display = 'block';
            if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'block';
            if (sidebarMenu) sidebarMenu.style.display = 'block';
            this.updateRightSidebar();
        }
    }

    async showBrowsePostModal(item) {
        this._browsePostModalItem = item;
        const modal = document.getElementById('browse-post-modal');
        const titleEl = document.getElementById('browse-post-modal-title');
        const mediaEl = document.getElementById('browse-post-media');
        const textEl = document.getElementById('browse-post-fulltext');
        const replyText = document.getElementById('browse-post-reply-text');
        const commentsDisplayEl = document.getElementById('browse-post-comments-display');
        if (!modal || !titleEl || !mediaEl || !textEl || !replyText) return;
        titleEl.textContent = item.authorDisplayName ? `@${item.authorHandle} — ${item.authorDisplayName}` : `@${item.authorHandle}`;
        mediaEl.innerHTML = '';
        if (item.type === 'video') {
            const video = document.createElement('video');
            video.src = item.videoUrl || item.imageUrl;
            video.controls = true;
            video.classList.add('browse-post-media');
            mediaEl.appendChild(video);
        } else {
            const img = document.createElement('img');
            img.src = item.imageUrl;
            img.alt = item.alt || '';
            img.classList.add('browse-post-media');
            mediaEl.appendChild(img);
        }
        const fullText = (item.postText || item.textSnippet || '').trim();
        textEl.textContent = fullText || '(No text)';
        replyText.value = '';
        
        // Add "View on Bluesky" button if postUri is available
        const textWrap = document.querySelector('.browse-post-text-wrap');
        let viewOnBlueskyBtn = document.getElementById('browse-post-view-bluesky-btn');
        if (item.postUri && textWrap) {
            // Build Bluesky URL
            const rkey = item.postUri.split('/').pop();
            const blueskyUrl = `https://bsky.app/profile/${item.authorHandle}/post/${rkey}`;
            
            if (!viewOnBlueskyBtn) {
                viewOnBlueskyBtn = document.createElement('a');
                viewOnBlueskyBtn.id = 'browse-post-view-bluesky-btn';
                viewOnBlueskyBtn.href = blueskyUrl;
                viewOnBlueskyBtn.target = '_blank';
                viewOnBlueskyBtn.rel = 'noopener noreferrer';
                viewOnBlueskyBtn.className = 'btn-secondary';
                viewOnBlueskyBtn.style.cssText = 'margin-top: 0.5rem; display: inline-block; text-decoration: none;';
                viewOnBlueskyBtn.textContent = 'View on Bluesky →';
                textWrap.appendChild(viewOnBlueskyBtn);
            } else {
                viewOnBlueskyBtn.href = blueskyUrl;
            }
        } else if (viewOnBlueskyBtn) {
            viewOnBlueskyBtn.remove();
        }
        
        // Load and display comments
        if (commentsDisplayEl && item.postUri) {
            commentsDisplayEl.innerHTML = '<div style="color: #555; font-size: 0.9rem;">Loading comments...</div>';
            try {
                const thread = await this.storage.getBlueskyPostThread(item.postUri);
                if (thread && thread.replies && thread.replies.length > 0) {
                    commentsDisplayEl.innerHTML = this.renderBlueskyComments(thread.replies);
                } else {
                    commentsDisplayEl.innerHTML = '<div style="color: #555; font-size: 0.9rem; font-style: italic;">No comments yet.</div>';
                }
            } catch (e) {
                console.warn('Failed to load comments:', e);
                commentsDisplayEl.innerHTML = '<div style="color: #999; font-size: 0.9rem;">Could not load comments.</div>';
            }
        } else if (commentsDisplayEl) {
            commentsDisplayEl.innerHTML = '<div style="color: #555; font-size: 0.9rem; font-style: italic;">No comments yet.</div>';
        }
        
        modal.style.display = 'flex';
        const replyBtn = document.getElementById('browse-post-reply-btn');
        replyBtn.onclick = async () => {
            const text = replyText.value.trim();
            if (!text) { alert('Please enter a reply.'); return; }
            if (!item.postUri) { alert('This post cannot be replied to.'); return; }
            
            // Check if user is logged in to Bluesky
            const isLoggedIn = this.storage.storageMode === 'bluesky' && this.storage.blueskyClient?.accessJwt;
            if (!isLoggedIn) {
                // Close the browse post modal and show Bluesky connection modal
                modal.style.display = 'none';
                this.openBlueskyModal();
                return;
            }
            
            replyBtn.disabled = true;
            try {
                await this.storage.postBlueskyReply(item.postUri, text);
                this.showUpdateNotification('Reply posted!');
                replyText.value = '';
                // Reload comments after posting
                if (commentsDisplayEl && item.postUri) {
                    try {
                        const thread = await this.storage.getBlueskyPostThread(item.postUri);
                        if (thread && thread.replies && thread.replies.length > 0) {
                            commentsDisplayEl.innerHTML = this.renderBlueskyComments(thread.replies);
                        } else {
                            commentsDisplayEl.innerHTML = '<div style="color: #555; font-size: 0.9rem; font-style: italic;">No comments yet.</div>';
                        }
                    } catch (e) {
                        console.warn('Failed to reload comments:', e);
                    }
                }
                // Don't close modal, let user see their comment
            } catch (e) {
                // Check if error is due to not being connected
                if (e.message && e.message.includes('Not connected')) {
                    modal.style.display = 'none';
                    this.openBlueskyModal();
                } else {
                    alert('Could not post reply: ' + (e.message || e));
                }
            } finally {
                replyBtn.disabled = false;
            }
        };
    }
    
    renderBlueskyComments(replies) {
        if (!replies || replies.length === 0) {
            return '<div style="color: #555; font-size: 0.9rem; font-style: italic;">No comments yet.</div>';
        }
        
        const renderReply = (reply, depth = 0) => {
            if (!reply || !reply.post) return '';
            const post = reply.post;
            const author = post.author || {};
            const handle = author.handle || 'unknown';
            const displayName = author.displayName || handle;
            const text = (post.record?.text || '').trim();
            const createdAt = post.record?.createdAt ? new Date(post.record.createdAt).toLocaleString() : '';
            const postUri = post.uri || '';
            const indent = depth > 0 ? ` style="margin-left: ${Math.min(depth * 1.2, 3)}em; padding-left: 0.75em; border-left: 2px solid #e5e9ed;"` : '';
            
            let nestedReplies = '';
            if (reply.replies && reply.replies.length > 0) {
                nestedReplies = reply.replies.map(r => renderReply(r, depth + 1)).join('');
            }
            
            // Build Bluesky URL from post URI
            let blueskyUrl = '';
            if (postUri) {
                const parts = postUri.replace('at://', '').split('/');
                if (parts.length >= 3) {
                    const rkey = parts[parts.length - 1];
                    blueskyUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
                }
            }
            
            return `
                <div class="browse-post-comment"${indent} style="margin-bottom: 0.75em; padding: 0.75em; background: #f8f9fa; border-radius: 6px; overflow-wrap: break-word; word-wrap: break-word; max-width: 100%;">
                    <div style="margin-bottom: 0.5em; line-height: 1.4;">
                        <div style="font-size: 0.85rem; font-weight: 600; color: #0645ad; margin-bottom: 0.15em;">@${this.escapeHtml(handle)}</div>
                        ${displayName !== handle ? `<div style="font-size: 0.8rem; color: #555; margin-bottom: 0.15em;">${this.escapeHtml(displayName)}</div>` : ''}
                        ${createdAt ? `<div style="font-size: 0.75rem; color: #999;">${createdAt}</div>` : ''}
                    </div>
                    <div style="font-size: 0.9rem; color: #333; white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word; line-height: 1.5;">${this.escapeHtml(text).replace(/\n/g, '<br>')}</div>
                    ${nestedReplies}
                </div>
            `;
        };
        
        return '<div style="margin-bottom: 1rem;"><strong style="font-size: 0.9rem; display: block; margin-bottom: 0.75em;">Comments</strong>' + replies.map(r => renderReply(r, 0)).join('') + '</div>';
    }

    async showFeedSearchModal() {
        // Create or get modal
        let modal = document.getElementById('browse-feed-search-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'browse-feed-search-modal';
            modal.className = 'article-modal';
            modal.style.display = 'none';
            document.body.appendChild(modal);
        }
        
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h2>Search Feeds</h2>
                    <button class="modal-close" id="browse-feed-search-close">&times;</button>
                </div>
                <div class="modal-body">
                    <div style="margin-bottom: 1em;">
                        <label for="feed-search-input" style="display: block; margin-bottom: 0.5em; font-weight: 600;">Search feeds or paste feed URI:</label>
                        <div style="display: flex; gap: 0.5em;">
                            <input type="text" id="feed-search-input" placeholder="Search popular feeds or paste at:// URI..." style="flex: 1; padding: 0.5em; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem;">
                            <button type="button" id="feed-search-btn" class="btn-primary">Search</button>
                        </div>
                        <small style="color: #72777d; display: block; margin-top: 0.5em;">Tip: Paste a feed URI (at://...) or search popular feeds by name</small>
                    </div>
                    <div id="feed-search-results" style="max-height: 400px; overflow-y: auto;">
                        <p style="color: #555; font-style: italic; text-align: center; padding: 2em;">Enter a search term or paste a feed URI to find feeds</p>
                    </div>
                </div>
            </div>
        `;
        
        modal.style.display = 'flex';
        
        const closeBtn = document.getElementById('browse-feed-search-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.style.display = 'none';
            });
        }
        
        // Close on backdrop click (handled by general modal click handler in setupEventListeners)
        
        const searchInput = document.getElementById('feed-search-input');
        const searchBtn = document.getElementById('feed-search-btn');
        const resultsEl = document.getElementById('feed-search-results');
        
        // Show popular feeds on load
        const showPopularFeeds = async () => {
            resultsEl.innerHTML = '<p style="color: #555; text-align: center; padding: 2em;">Loading popular feeds...</p>';
            try {
                const feeds = this.storage.getPopularFeeds();
                // Fetch full info for each feed
                const feedsWithInfo = await Promise.all(feeds.map(async (feed) => {
                    const info = await this.storage.getFeedGeneratorInfo(feed.uri);
                    return info || feed;
                }));
                displayFeeds(feedsWithInfo.filter(f => f !== null));
            } catch (e) {
                resultsEl.innerHTML = `<p style="color: #d32f2f; text-align: center; padding: 2em;">Error loading feeds: ${this.escapeHtml(e.message || 'Unknown error')}</p>`;
            }
        };
        
        const displayFeeds = (feeds) => {
            if (feeds.length === 0) {
                resultsEl.innerHTML = '<p style="color: #555; font-style: italic; text-align: center; padding: 2em;">No feeds found. Try pasting a feed URI (at://...) directly.</p>';
                return;
            }
            
            const customFeeds = this.storage.getCustomFeeds();
            const customFeedUris = new Set(customFeeds.map(f => f.uri));
            
            resultsEl.innerHTML = feeds.map(feed => {
                const isSaved = customFeedUris.has(feed.uri);
                return `
                    <div class="feed-search-result" style="padding: 1em; border: 1px solid #e5e9ed; border-radius: 6px; margin-bottom: 0.75em; background: #f8f9fa;">
                        <div style="display: flex; align-items: flex-start; gap: 0.75em;">
                            ${feed.avatar ? `<img src="${feed.avatar}" alt="" style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;">` : '<div style="width: 48px; height: 48px; border-radius: 6px; background: #e5e9ed; display: flex; align-items: center; justify-content: center; color: #999; font-size: 1.5rem;">📰</div>'}
                            <div style="flex: 1; min-width: 0;">
                                <div style="font-weight: 600; font-size: 0.95rem; margin-bottom: 0.25em; word-break: break-word;">${this.escapeHtml(feed.name)}</div>
                                ${feed.description ? `<div style="font-size: 0.85rem; color: #555; margin-bottom: 0.5em; word-break: break-word;">${this.escapeHtml(feed.description)}</div>` : ''}
                                <div style="display: flex; align-items: center; gap: 1em; font-size: 0.8rem; color: #999;">
                                    ${feed.creator ? `<span>by @${this.escapeHtml(feed.creator)}</span>` : ''}
                                    ${feed.likeCount > 0 ? `<span>${feed.likeCount} likes</span>` : ''}
                                </div>
                                <div style="font-size: 0.75rem; color: #999; margin-top: 0.25em; font-family: monospace; word-break: break-all;">${this.escapeHtml(feed.uri)}</div>
                            </div>
                            <button type="button" class="feed-add-btn ${isSaved ? 'btn-secondary' : 'btn-primary'}" data-feed-uri="${this.escapeHtml(feed.uri)}" data-feed-name="${this.escapeHtml(feed.name)}" data-feed-desc="${this.escapeHtml(feed.description || '')}" style="font-size: 0.85rem; padding: 0.4em 0.8em; white-space: nowrap;">
                                ${isSaved ? '✓ Saved' : 'Add'}
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
            
            // Add click handlers for add buttons
            resultsEl.querySelectorAll('.feed-add-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const uri = e.target.getAttribute('data-feed-uri');
                    const name = e.target.getAttribute('data-feed-name');
                    const desc = e.target.getAttribute('data-feed-desc');
                    
                    if (customFeedUris.has(uri)) {
                        // Remove feed
                        this.storage.removeCustomFeed(uri);
                        this.showUpdateNotification(`Removed "${name}"`);
                        e.target.textContent = 'Add';
                        e.target.className = 'feed-add-btn btn-primary';
                    } else {
                        // Add feed
                        this.storage.saveCustomFeed({ uri, name, description: desc });
                        this.showUpdateNotification(`Added "${name}"`);
                        e.target.textContent = '✓ Saved';
                        e.target.className = 'feed-add-btn btn-secondary';
                    }
                    
                    // Reload browse page to update feed list
                    this.browseFeedCursor = null;
                    this.showBrowsePage(null, false);
                });
            });
        };
        
        const performSearch = async () => {
            const query = searchInput.value.trim();
            if (!query) {
                await showPopularFeeds();
                return;
            }
            
            resultsEl.innerHTML = '<p style="color: #555; text-align: center; padding: 2em;">Searching...</p>';
            searchBtn.disabled = true;
            
            try {
                const feeds = await this.storage.searchFeedGenerators(query);
                displayFeeds(feeds);
            } catch (e) {
                resultsEl.innerHTML = `<p style="color: #d32f2f; text-align: center; padding: 2em;">Error searching feeds: ${this.escapeHtml(e.message || 'Unknown error')}</p>`;
            } finally {
                searchBtn.disabled = false;
            }
        };
        
        // Show popular feeds on modal open
        showPopularFeeds();
                    const customFeeds = this.storage.getCustomFeeds();
                    const customFeedUris = new Set(customFeeds.map(f => f.uri));
                    
                    resultsEl.innerHTML = feeds.map(feed => {
                        const isSaved = customFeedUris.has(feed.uri);
                        return `
                            <div class="feed-search-result" style="padding: 1em; border: 1px solid #e5e9ed; border-radius: 6px; margin-bottom: 0.75em; background: #f8f9fa;">
                                <div style="display: flex; align-items: flex-start; gap: 0.75em;">
                                    ${feed.avatar ? `<img src="${feed.avatar}" alt="" style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;">` : '<div style="width: 48px; height: 48px; border-radius: 6px; background: #e5e9ed; display: flex; align-items: center; justify-content: center; color: #999; font-size: 1.5rem;">📰</div>'}
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-weight: 600; font-size: 0.95rem; margin-bottom: 0.25em; word-break: break-word;">${this.escapeHtml(feed.name)}</div>
                                        ${feed.description ? `<div style="font-size: 0.85rem; color: #555; margin-bottom: 0.5em; word-break: break-word;">${this.escapeHtml(feed.description)}</div>` : ''}
                                        <div style="display: flex; align-items: center; gap: 1em; font-size: 0.8rem; color: #999;">
                                            ${feed.creator ? `<span>by @${this.escapeHtml(feed.creator)}</span>` : ''}
                                            ${feed.likeCount > 0 ? `<span>${feed.likeCount} likes</span>` : ''}
                                        </div>
                                    </div>
                                    <button type="button" class="feed-add-btn ${isSaved ? 'btn-secondary' : 'btn-primary'}" data-feed-uri="${this.escapeHtml(feed.uri)}" data-feed-name="${this.escapeHtml(feed.name)}" data-feed-desc="${this.escapeHtml(feed.description || '')}" style="font-size: 0.85rem; padding: 0.4em 0.8em; white-space: nowrap;">
                                        ${isSaved ? '✓ Saved' : 'Add'}
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('');
                    
                    // Add click handlers for add buttons
                    resultsEl.querySelectorAll('.feed-add-btn').forEach(btn => {
                        btn.addEventListener('click', async (e) => {
                            const uri = e.target.getAttribute('data-feed-uri');
                            const name = e.target.getAttribute('data-feed-name');
                            const desc = e.target.getAttribute('data-feed-desc');
                            
                            if (customFeedUris.has(uri)) {
                                // Remove feed
                                this.storage.removeCustomFeed(uri);
                                this.showUpdateNotification(`Removed "${name}"`);
                                e.target.textContent = 'Add';
                                e.target.className = 'feed-add-btn btn-primary';
                            } else {
                                // Add feed
                                this.storage.saveCustomFeed({ uri, name, description: desc });
                                this.showUpdateNotification(`Added "${name}"`);
                                e.target.textContent = '✓ Saved';
                                e.target.className = 'feed-add-btn btn-secondary';
                            }
                            
                            // Reload browse page to update feed list
                            this.browseFeedCursor = null;
                            this.showBrowsePage(null, false);
                        });
                    });
                }
            } catch (e) {
                resultsEl.innerHTML = `<p style="color: #d32f2f; text-align: center; padding: 2em;">Error searching feeds: ${this.escapeHtml(e.message || 'Unknown error')}</p>`;
            } finally {
                searchBtn.disabled = false;
            }
        };
        
        if (searchBtn) {
            searchBtn.addEventListener('click', performSearch);
        }
        
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    performSearch();
                }
            });
            searchInput.focus();
        }
    }

    showBrowseAddModal(item) {
        this._browseAddModalItem = item;
        const modal = document.getElementById('browse-add-modal');
        const listEl = document.getElementById('browse-add-artboard-list');
        const noteEl = document.getElementById('browse-add-note');
        const descEl = modal.querySelector('.browse-add-desc');
        const newArtboardWrap = document.getElementById('browse-add-new-artboard-wrap');
        const newArtboardNameInput = document.getElementById('browse-add-new-artboard-name');
        const createArtboardBtn = document.getElementById('browse-add-create-artboard-btn');
        if (!modal || !listEl || !noteEl) return;

        // Check if item already exists in archive
        const archive = this.storage.getArchive();
        const url = item.videoUrl || item.imageUrl;
        const existingItem = archive.find(a => {
            // Match by imageUrl/videoUrl or postUri
            const urlMatch = (a.imageUrl === url || a.videoUrl === url);
            const postUriMatch = item.postUri && a.source && a.source.includes(item.postUri.split('/').pop());
            return urlMatch || postUriMatch;
        });
        
        const existingAlbumIds = existingItem ? (existingItem.albumIds || []) : [];
        const existingAlbums = existingAlbumIds.length > 0 
            ? this.storage.getAlbums().filter(a => existingAlbumIds.includes(a.id))
            : [];

        const refreshArtboardList = (checkNewAlbumId = null) => {
            const albums = this.storage.getAlbums();
            const albumsToCheck = checkNewAlbumId ? [checkNewAlbumId, ...existingAlbumIds] : existingAlbumIds;
            
            if (albums.length === 0) {
                listEl.innerHTML = '<p class="browse-add-desc">No artboards yet. Create one below.</p>';
                if (newArtboardWrap) {
                    newArtboardWrap.style.display = 'block';
                    const label = newArtboardWrap.querySelector('label');
                    if (label) label.textContent = 'New artboard name';
                }
            } else {
                listEl.innerHTML = albums.map(a => {
                    const isChecked = albumsToCheck.includes(a.id);
                    const isExisting = existingAlbumIds.includes(a.id);
                    return `
                        <label style="${isExisting ? 'background: #e8f4f8; padding: 0.5em; border-radius: 4px; border-left: 3px solid #0645ad;' : ''}">
                            <input type="checkbox" name="browse-add-artboard" value="${this.escapeHtml(a.id)}" ${isChecked ? 'checked' : ''}>
                            <span>${this.escapeHtml(a.name)}${isExisting ? ' <span style="color: #0645ad; font-size: 0.85em; font-weight: 600;">(already in)</span>' : ''}</span>
                        </label>
                    `;
                }).join('');
                if (newArtboardWrap) {
                    newArtboardWrap.style.display = 'block';
                    const label = newArtboardWrap.querySelector('label');
                    if (label) label.textContent = 'Or create another artboard:';
                }
            }
            
            // Update description to show existing collections
            if (descEl && existingAlbums.length > 0) {
                const albumNames = existingAlbums.map(a => a.name).join(', ');
                descEl.innerHTML = `Select which artboard(s) to add this to:<br><small style="color: #0645ad; font-weight: 600;">Already in: ${this.escapeHtml(albumNames)}</small>`;
            } else if (descEl) {
                descEl.textContent = 'Select which artboard(s) to add this to:';
            }
        };

        refreshArtboardList();
        noteEl.value = '';
        if (newArtboardNameInput) newArtboardNameInput.value = '';

        if (createArtboardBtn && newArtboardNameInput) {
            createArtboardBtn.onclick = () => {
                const name = newArtboardNameInput.value.trim();
                if (!name) {
                    alert('Please enter an artboard name.');
                    return;
                }
                const album = this.storage.saveAlbum({ name });
                newArtboardNameInput.value = '';
                refreshArtboardList(album.id);
                this.showUpdateNotification(`Created "${album.name}". It's selected—click Add to add this item to it.`);
            };
        }

        modal.style.display = 'flex';
        const submitBtn = document.getElementById('browse-add-submit-btn');
        submitBtn.onclick = async () => {
            let selected = Array.from(document.querySelectorAll('input[name="browse-add-artboard"]:checked')).map(el => el.value);
            const note = noteEl.value.trim();
            const url = item.videoUrl || item.imageUrl;
            
            // If user typed a new artboard name but didn't click "Create artboard", create it now and add to selection
            if (newArtboardNameInput && newArtboardNameInput.value.trim()) {
                const name = newArtboardNameInput.value.trim();
                const album = this.storage.saveAlbum({ name });
                if (!selected.includes(album.id)) {
                    selected = [...selected, album.id];
                }
                newArtboardNameInput.value = '';
            }
            
            try {
                if (existingItem) {
                    // Item already exists - merge albumIds
                    const currentAlbumIds = existingItem.albumIds || [];
                    const mergedAlbumIds = [...new Set([...currentAlbumIds, ...selected])];
                    const updates = { albumIds: mergedAlbumIds };
                    if (note && note !== existingItem.userNote) {
                        updates.userNote = note;
                    }
                    await this.storage.updateArchiveItem(existingItem.id, updates);
                    const newlyAdded = selected.filter(id => !currentAlbumIds.includes(id));
                    if (newlyAdded.length > 0) {
                        this.showUpdateNotification(`Added to ${newlyAdded.length} new artboard(s).`);
                    } else {
                        this.showUpdateNotification('Item already in selected artboards.');
                    }
                } else {
                    // New item
                    const archiveItem = {
                        imageUrl: url,
                        name: item.authorHandle ? `@${item.authorHandle}` : 'From feed',
                        type: item.type || 'image',
                        source: item.postUri ? `https://bsky.app/profile/${item.authorHandle}/post/${(item.postUri || '').split('/').pop()}` : '',
                        albumIds: selected,
                        assignmentType: 'albums',
                        articleIds: [],
                        habitDays: [],
                        authorHandle: item.authorHandle,
                        authorDid: item.authorDid,
                        authorDisplayName: item.authorDisplayName,
                        postText: item.postText ?? item.textSnippet
                    };
                    if (note) archiveItem.userNote = note;
                    await this.storage.saveArchiveItem(archiveItem);
                    this.showUpdateNotification(selected.length ? `Added to ${selected.length} artboard(s).` : 'Added to your archive.');
                }
                modal.style.display = 'none';
                if (this.currentArticleKey === 'collection') this.showCollectionPage(this.currentCollectionFilter);
            } catch (e) {
                console.error(e);
                alert('Failed to add: ' + (e.message || 'Unknown error'));
            }
        };
    }

    async addBrowseItemToCollection(item) {
        this.showBrowseAddModal(item);
    }

    // ===== COLLECTION PAGE =====
    async showCollectionPage(albumFilter = null) {
        const container = document.getElementById('article-container');
        if (!container) return;
        
        this.currentArticleKey = 'collection';
        // Store current filter for edit mode preservation (only if not null/undefined)
        if (albumFilter !== null && albumFilter !== undefined) {
            this.currentCollectionFilter = albumFilter;
        } else {
            // Clear stored filter when on "All"
            this.currentCollectionFilter = null;
        }
        
        const albums = this.storage.getAlbums();
        let items = this.storage.getArchive();
        if (albumFilter) {
            items = items.filter(i => {
                // Support both old single albumId and new albumIds array
                const itemAlbums = i.albumIds || (i.albumId ? [i.albumId] : []);
                return itemAlbums.includes(albumFilter);
            });
        }
        
        const currentAlbum = albumFilter ? albums.find(a => a.id === albumFilter) : null;
        
        const albumsHtml = albums.length > 0 ? `
            <div class="archive-albums-row">
                <button class="album-pill ${!albumFilter ? 'active' : ''}" onclick="${this.collectionEditMode ? `window.wikiApp.toggleCollectionSelection('all')` : `window.wikiApp.navigate('collection')`}">All</button>
                ${albums.map(a => {
                    const isSelected = this.selectedCollections.has(a.id);
                    return `
                    <div class="album-pill-wrapper">
                        <button class="album-pill ${albumFilter === a.id ? 'active' : ''} ${this.collectionEditMode && isSelected ? 'collection-pill-selected' : ''}" onclick="${this.collectionEditMode ? `window.wikiApp.toggleCollectionSelection('${a.id}')` : `window.wikiApp.filterCollectionByAlbum('${a.id}')`}">
                            ${this.collectionEditMode ? `<input type="checkbox" class="collection-pill-checkbox" ${isSelected ? 'checked' : ''} onchange="window.wikiApp.toggleCollectionSelection('${a.id}')" onclick="event.stopPropagation()">` : ''}
                            ${a.name}
                        </button>
                    </div>
                `;
                }).join('')}
                ${!this.collectionEditMode ? `<button class="album-pill add-album" onclick="window.wikiApp.createAlbum()">+ New Artboard</button>` : ''}
            </div>
        ` : '';
        
        const itemsHtml = items.length > 0 ? items.map(item => {
            const isSelected = this.selectedCollectionItems.has(item.id);
            return `
            <div class="archive-page-item ${this.collectionEditMode ? 'collection-item-selectable' : ''} ${isSelected ? 'collection-item-selected' : ''}" data-item-id="${item.id}" onclick="${this.collectionEditMode ? `window.wikiApp.toggleCollectionItemSelection('${item.id}')` : `window.wikiApp.viewArchiveItemPage('${item.id}')`}">
                ${this.collectionEditMode ? `<div class="collection-item-checkbox"><input type="checkbox" data-item-id="${item.id}" ${isSelected ? 'checked' : ''} onchange="window.wikiApp.toggleCollectionItemSelection('${item.id}')" onclick="event.stopPropagation()"></div>` : ''}
                <div class="archive-page-item-media">
                    ${item.type === 'video' 
                        ? `<video data-item-id="${item.id}" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                        : `<img data-item-id="${item.id}" alt="${item.name || 'Image'}" style="background: #f0f0f0;">`}
                    <div class="archive-item-overlay"></div>
                    <div class="archive-item-pds-badge">${this.getPdsSyncCloudIcon()}</div>
                </div>
                <div class="archive-item-meta" title="Click to view details and source URL">${this.getArchiveItemMetaLabel(item)}</div>
            </div>
        `;
        }).join('') : '<p class="archive-empty">No items yet. Click the + button to add media!</p>';
        
        // Load images/videos asynchronously after rendering (auth-resolved URLs for getBlob so embeds work after re-login)
        setTimeout(() => {
            items.forEach(item => {
                this.loadArchiveItemImage(item).then(result => {
                    const imageData = result && typeof result === 'object' && result.videoUrl !== undefined ? result.imageData : result;
                    const videoUrl = result && typeof result === 'object' ? result.videoUrl : null;
                    const wrapper = document.querySelector(`.archive-page-item[data-item-id="${item.id}"]`);
                    if (!wrapper) return;
                    if (item.type === 'video') {
                        const videoEl = wrapper.querySelector('video');
                        if (videoEl) {
                            const src = videoUrl || item.videoUrl || imageData;
                            if (src) videoEl.src = src;
                            if (imageData) videoEl.poster = imageData;
                        }
                    } else {
                        const imgEl = wrapper.querySelector('img');
                        if (imgEl && imageData) imgEl.src = imageData;
                    }
                }).catch(error => {
                    console.error('Failed to load image for item', item.id, error);
                });
            });
        }, 100);
        
        container.innerHTML = `
            ${this.renderSectionNav()}
            <div class="article-header">
                <h1>${currentAlbum ? currentAlbum.name : 'Artboards'}${this.getPdsSyncCloudIcon()}</h1>
                <div class="article-header-upload-wrapper">
                    <button class="btn-primary archive-upload-btn" onclick="window.wikiApp.openCreateModal('media')" style="display: inline-flex; align-items: center;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                        Upload Media
                    </button>
                    ${this.collectionEditMode ? `
                    <div class="archive-page-actions" style="margin-top: 0.5em; display: flex; justify-content: center; gap: 0.5em; flex-wrap: wrap;">
                        <button class="btn-secondary collection-select-all-btn" onclick="window.wikiApp.selectAllCollectionItems()" style="display: inline-flex; align-items: center;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                                <polyline points="9 11 12 14 22 4"></polyline>
                                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                            </svg>
                            Select All
                        </button>
                        <button class="btn-danger collection-delete-btn" onclick="window.wikiApp.deleteSelectedCollectionItems()" id="collection-delete-btn" style="display: ${this.selectedCollectionItems.size > 0 || this.selectedCollections.size > 0 ? 'inline-flex' : 'none'}; align-items: center;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                            Delete (${this.selectedCollectionItems.size + this.selectedCollections.size})
                        </button>
                    </div>
                    ` : ''}
                </div>
                <div class="article-header-actions">
                    <button type="button" class="${this.collectionEditMode ? 'btn-primary' : 'btn-secondary'} collection-edit-btn" id="collection-edit-btn" style="display: inline-flex; align-items: center;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                        ${this.collectionEditMode ? 'Cancel' : 'Edit'}
                    </button>
                </div>
            </div>
            ${albumsHtml}
            <div class="archive-page-grid">${itemsHtml}</div>
        `;
        
        // Hide TOC and show sidebar sections
        const tocContainer = document.getElementById('table-of-contents');
        if (tocContainer) {
            tocContainer.style.display = 'none';
        }
        const sidebarBookmarks = document.getElementById('sidebar-bookmarks');
        const sidebarThoughts = document.getElementById('sidebar-thoughts');
        const sidebarRecentArticles = document.getElementById('sidebar-recent-articles');
        const sidebarMenu = document.querySelector('.mw-sidebar-menu');
        
        if (sidebarBookmarks) sidebarBookmarks.style.display = 'block';
        if (sidebarThoughts) sidebarThoughts.style.display = 'block';
        if (sidebarRecentArticles) sidebarRecentArticles.style.display = 'block';
        if (sidebarMenu) sidebarMenu.style.display = 'block';
        
        // Set up edit button event listener
        const editBtn = document.getElementById('collection-edit-btn');
        if (editBtn) {
            // Remove any existing listeners by cloning and replacing
            const newEditBtn = editBtn.cloneNode(true);
            editBtn.parentNode.replaceChild(newEditBtn, editBtn);
            // Add fresh event listener
            newEditBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    this.toggleCollectionEditMode();
                } catch (err) {
                    console.error('Error toggling collection edit mode:', err);
                    alert('Error: ' + (err.message || 'Could not toggle edit mode'));
                }
            });
        }
        
        this.updateRightSidebar();
    }

    async viewArchiveItemPage(id) {
        const item = this.storage.getArchive().find(a => a.id === id);
        if (!item) return;
        
        const albums = this.storage.getAlbums();
        // Support both old single albumId and new albumIds array
        const itemAlbums = item.albumIds || (item.albumId ? [item.albumId] : []);
        
        const albumCheckboxes = albums.map(a => `
            <label class="album-checkbox">
                <input type="checkbox" name="edit-album" value="${a.id}" ${itemAlbums.includes(a.id) ? 'checked' : ''}>
                <span>${a.name}</span>
            </label>
        `).join('');
        
        // Load image/video URL (poster or image data; auth-resolved for getBlob)
        const mediaResult = await this.loadArchiveItemImage(item);
        const { imageData, videoUrl } = this._archiveMediaFromResult(mediaResult, item);
        const videoSrc = item.type === 'video' ? (videoUrl || imageData) : '';
        const postText = (item.postText || item.textSnippet || '').trim();
        const hasAuthor = !!(item.authorHandle || item.authorDid);
        const profileHref = item.source || (item.authorHandle ? `https://bsky.app/profile/${item.authorHandle}` : (item.authorDid ? `https://bsky.app/profile/${item.authorDid}` : ''));
        const authorLabel = (item.authorHandle || item.authorDid) ? `@${this.escapeHtml(item.authorHandle || item.authorDid)}` : '';
        const postAndAuthorBlock = (postText || hasAuthor) ? `
                    <div class="archive-lightbox-post-author">
                        ${hasAuthor ? `<div class="archive-lightbox-author">Posted by ${profileHref ? `<a href="${this.escapeHtml(profileHref)}" target="_blank" rel="noopener">${authorLabel}</a>` : authorLabel}</div>` : ''}
                        ${postText ? `<div class="archive-lightbox-post-text">${this.escapeHtml(postText)}</div>` : ''}
                    </div>
                ` : '';
        // Editable lightbox view
        const overlay = document.createElement('div');
        overlay.className = 'archive-lightbox';
        overlay.id = 'archive-lightbox';
        overlay.innerHTML = `
            <div class="archive-lightbox-content">
                <button class="lightbox-close" onclick="document.getElementById('archive-lightbox').remove()">&times;</button>
                ${item.type === 'video' 
                    ? `<video src="${videoSrc || ''}" ${imageData ? `poster="${imageData}"` : ''} controls autoplay></video>`
                    : `<img src="${imageData || ''}" alt="${item.name || 'Image'}">`}
                ${postAndAuthorBlock}
                <div class="archive-lightbox-form">
                    <div class="form-row">
                        <label>Source URL</label>
                        <input type="url" id="edit-archive-source" value="${item.source || ''}" placeholder="https://...">
                    </div>
                    <div class="form-row">
                        <label>Albums</label>
                        <div class="album-checkboxes" id="edit-archive-albums">
                            ${albums.length > 0 ? albumCheckboxes : '<span class="no-albums">No albums yet</span>'}
                        </div>
                        <button class="btn-small" onclick="window.wikiApp.createAlbumFromLightbox()" style="margin-top:0.5em;">+ New Artboard</button>
                    </div>
                    <div class="form-row">
                        <label>Tags</label>
                        <input type="text" id="edit-archive-tags" value="${item.tags?.join(', ') || ''}" placeholder="comma, separated, tags">
                    </div>
                    <div class="lightbox-actions">
                        <button class="btn-primary" onclick="window.wikiApp.saveArchiveItemEdit('${item.id}')">Save Changes</button>
                        <button class="btn-danger" onclick="window.wikiApp.deleteArchiveItem('${item.id}')">Delete</button>
                    </div>
                </div>
            </div>
        `;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    createAlbumFromLightbox() {
        const name = prompt('Artboard name:');
        if (name && name.trim()) {
            const album = this.storage.saveAlbum({ name: name.trim() });
            // Add new checkbox
            const container = document.getElementById('edit-archive-albums');
            if (container) {
                const noAlbums = container.querySelector('.no-albums');
                if (noAlbums) noAlbums.remove();
                const label = document.createElement('label');
                label.className = 'album-checkbox';
                label.innerHTML = `<input type="checkbox" name="edit-album" value="${album.id}" checked><span>${album.name}</span>`;
                container.appendChild(label);
            }
        }
    }

    saveArchiveItemEdit(id) {
        const source = document.getElementById('edit-archive-source')?.value?.trim() || '';
        const checkedAlbums = document.querySelectorAll('#edit-archive-albums input[name="edit-album"]:checked');
        const albumIds = Array.from(checkedAlbums).map(cb => cb.value);
        const tags = (document.getElementById('edit-archive-tags')?.value || '').split(',').map(t => t.trim()).filter(t => t);
        
        this.storage.updateArchiveItem(id, { source, albumIds, tags });
        document.getElementById('archive-lightbox')?.remove();
        this.showCollectionPage();
        this.showUpdateNotification('Item updated!');
    }

    async deleteArchiveItem(id) {
        if (!confirm('Delete this item?')) return;
        try {
            await this.storage.deleteArchiveItem(id);
        } catch (e) {
            alert('Could not delete item from PDS: ' + (e.message || e));
            return;
        }
        document.getElementById('archive-lightbox')?.remove();
        this.showCollectionPage();
    }

    filterByAlbum(albumId) {
        this.showCollectionPage(albumId);
    }

    navigateToCollection(albumId) {
        // Navigate directly to a specific collection from bento
        // Save current state (homepage) before navigating so back button goes to homepage
        const currentHash = window.location.hash || '#main';
        // Push current state to history so back button returns here
        window.history.pushState({ route: currentHash.replace('#', '') || 'main' }, '', currentHash);
        // Now navigate to collection with filter and update hash
        window.location.hash = '#collection';
        this.showCollectionPage(albumId);
    }

    filterCollectionByAlbum(albumId) {
        // Filter collection by album - stay on collection page but update filter
        this.showCollectionPage(albumId);
        // Ensure URL hash is set to collection
        if (window.location.hash !== '#collection') {
            window.history.replaceState(null, '', '#collection');
        }
    }
    
    // Alias for backward compatibility
    toggleCollectionEditMode() {
        try {
            this.collectionEditMode = !this.collectionEditMode;
            if (!this.collectionEditMode) {
                // Clear selections when exiting edit mode
                this.selectedCollectionItems.clear();
                this.selectedCollections.clear();
            }
            // Re-render the page to show checkboxes, preserving current filter
            if (this.currentArticleKey === 'collection') {
                // Use stored filter if available, otherwise null (All)
                const albumFilter = this.currentCollectionFilter || null;
                this.showCollectionPage(albumFilter);
            }
        } catch (err) {
            console.error('Error in toggleCollectionEditMode:', err);
            // Reset state on error
            this.collectionEditMode = false;
            this.selectedCollectionItems.clear();
            this.selectedCollections.clear();
            throw err;
        }
    }

    toggleCollectionItemSelection(itemId) {
        if (this.selectedCollectionItems.has(itemId)) {
            this.selectedCollectionItems.delete(itemId);
        } else {
            this.selectedCollectionItems.add(itemId);
        }
        const checkbox = document.querySelector(`input[data-item-id="${itemId}"]`);
        if (checkbox) {
            checkbox.checked = this.selectedCollectionItems.has(itemId);
        }
        const item = document.querySelector(`.archive-page-item[data-item-id="${itemId}"]`);
        if (item) {
            item.classList.toggle('collection-item-selected', this.selectedCollectionItems.has(itemId));
        }
        this.updateCollectionSelectionUI();
    }

    toggleCollectionSelection(collectionId) {
        if (collectionId === 'all') {
            // Toggle all collections
            const albums = this.storage.getAlbums();
            const allSelected = albums.every(a => this.selectedCollections.has(a.id));
            if (allSelected) {
                albums.forEach(a => this.selectedCollections.delete(a.id));
            } else {
                albums.forEach(a => this.selectedCollections.add(a.id));
            }
        } else {
            if (this.selectedCollections.has(collectionId)) {
                this.selectedCollections.delete(collectionId);
            } else {
                this.selectedCollections.add(collectionId);
            }
        }
        // Update UI - re-render to show checkbox states
        const albumFilter = this.currentCollectionFilter || null;
        this.showCollectionPage(albumFilter);
    }

    selectAllCollectionItems() {
        const items = this.storage.getArchive();
        const albumFilter = this.currentCollectionFilter || null;
        
        // Only select all visible media items (not collections)
        let itemsToSelect = items;
        if (albumFilter) {
            itemsToSelect = items.filter(i => {
                const itemAlbums = i.albumIds || (i.albumId ? [i.albumId] : []);
                return itemAlbums.includes(albumFilter);
            });
        }
        
        // Check if all items are already selected
        const allSelected = itemsToSelect.length > 0 && itemsToSelect.every(item => this.selectedCollectionItems.has(item.id));
        
        if (allSelected) {
            // Deselect all
            itemsToSelect.forEach(item => this.selectedCollectionItems.delete(item.id));
        } else {
            // Select all
            itemsToSelect.forEach(item => this.selectedCollectionItems.add(item.id));
        }
        
        this.updateCollectionSelectionUI();
        // Re-render to show all selected
        this.showCollectionPage(albumFilter);
    }

    updateCollectionSelectionUI() {
        const deleteBtn = document.getElementById('collection-delete-btn');
        if (deleteBtn) {
            const totalSelected = this.selectedCollectionItems.size + this.selectedCollections.size;
            deleteBtn.style.display = totalSelected > 0 ? 'inline-flex' : 'none';
            // Ensure button has btn-danger class
            deleteBtn.className = 'btn-danger collection-delete-btn';
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:0.5em;">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Delete (${totalSelected})
            `;
        }
    }

    async deleteSelectedCollectionItems() {
        const totalSelected = this.selectedCollectionItems.size + this.selectedCollections.size;
        if (totalSelected === 0) return;
        if (!confirm(`Are you sure you want to delete ${totalSelected} item(s)?`)) return;
        
        const collectionsToDelete = Array.from(this.selectedCollections);
        const itemsToDelete = Array.from(this.selectedCollectionItems);
        try {
            for (const albumId of collectionsToDelete) {
                await this.storage.deleteAlbum(albumId);
            }
            for (const itemId of itemsToDelete) {
                await this.storage.deleteArchiveItem(itemId);
            }
        } catch (e) {
            alert('Could not delete from PDS: ' + (e.message || e));
            return;
        }
        
        this.selectedCollectionItems.clear();
        this.selectedCollections.clear();
        this.collectionEditMode = false;
        
        const albumFilter = this.currentCollectionFilter || null;
        if (albumFilter && collectionsToDelete.includes(albumFilter)) {
            this.showCollectionPage(null);
        } else {
            this.showCollectionPage(albumFilter);
        }
    }

    renderCaptures(forBento = false, bentoSize = null) {
        if (forBento) {
            // Show albums list in bento - show 9 slots (3x3) for small, 6 for medium/large
            const albums = this.storage.getAlbums();
            
            // Determine album size based on bento size
            const cols = bentoSize?.cols || 1;
            let albumSizeClass = 'bento-albums-small';
            let totalSlots = 9; // 3x3 grid for small size
            if (cols === 2) {
                albumSizeClass = 'bento-albums-medium';
                totalSlots = 6; // 6 slots for medium
            } else if (cols === 3) {
                albumSizeClass = 'bento-albums-large';
                totalSlots = 9; // 3x3 grid for large size
            }
            
            const archive = this.storage.getArchive();
            const albumsHtml = albums.map(album => {
                const albumItems = archive.filter(item => {
                    const itemAlbums = item.albumIds || (item.albumId ? [item.albumId] : []);
                    return itemAlbums.includes(album.id);
                });
                // Pick a random item from the collection for the thumbnail (or use stored index)
                let randomItem = null;
                if (albumItems.length > 0) {
                    // Get or set a stored random index for this album in collections bento
                    const albumThumbKey = `album-thumb-${album.id}-index`;
                    let storedIndex = localStorage.getItem(albumThumbKey);
                    if (storedIndex === null || parseInt(storedIndex) >= albumItems.length) {
                        // Generate new random index and store it
                        storedIndex = Math.floor(Math.random() * albumItems.length).toString();
                        localStorage.setItem(albumThumbKey, storedIndex);
                    }
                    const randomIndex = parseInt(storedIndex);
                    randomItem = albumItems[randomIndex];
                }
                const itemId = randomItem ? randomItem.id : null;
                const thumbnail = randomItem 
                    ? (randomItem.type === 'video'
                        ? `<video data-album-thumb-id="${itemId}" class="bento-album-thumb" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                        : `<img data-album-thumb-id="${itemId}" alt="${album.name}" class="bento-album-thumb" style="background: #f0f0f0;">`)
                    : `<div class="bento-album-thumb bento-album-placeholder"></div>`;
                
                // Load thumbnail asynchronously
                if (randomItem) {
                    setTimeout(() => {
                        this.loadArchiveItemImage(randomItem).then(result => {
                            const { imageData, videoUrl } = this._archiveMediaFromResult(result, randomItem);
                            const el = document.querySelector(`[data-album-thumb-id="${itemId}"]`);
                            if (!el) return;
                            if (randomItem.type === 'video') {
                                const src = videoUrl || imageData;
                                if (src) el.src = src;
                                if (imageData) el.poster = imageData;
                            } else if (imageData) {
                                el.src = imageData;
                            }
                        });
                    }, 100);
                }
                
                return `
                    <div class="bento-album-item" draggable="true" data-album-id="${album.id}" data-album-name="${album.name}" onclick="event.stopPropagation(); window.wikiApp.filterCollectionByAlbum('${album.id}');" title="Click to view artboard">
                        ${thumbnail}
                        <div class="bento-album-info">
                            <span class="bento-album-name">${album.name}</span>
                        </div>
                    </div>
                `;
            }).join('');
            
            // Add empty placeholder slots to always show the required total
            const emptySlotsNeeded = Math.max(0, totalSlots - albums.length);
            const emptySlotsHtml = Array(emptySlotsNeeded).fill(null).map(() => `
                    <div class="bento-album-item bento-album-empty" style="opacity: 0.3; cursor: pointer;" onclick="event.stopPropagation(); window.wikiApp.openCreateModal('media');" title="Click to create a new artboard">
                        <div class="bento-album-thumb bento-album-placeholder"></div>
                        <div class="bento-album-info">
                            <span class="bento-album-name" style="color: #72777d;">Empty</span>
                        </div>
                    </div>
            `).join('');
            
            return `<div class="bento-albums-list ${albumSizeClass}">${albumsHtml}${emptySlotsHtml}</div>`;
        }
        
        // Show recent archive items on homepage (non-bento)
        const items = this.storage.getArchive().slice(0, 6);
        if (items.length === 0) return '';
        
        const html = items.map(item => {
            const itemId = item.id;
            return `
            <div class="archive-thumb">
                ${item.type === 'video'
                    ? `<video data-capture-thumb-id="${itemId}" controls playsinline style="background: #f0f0f0;" onclick="event.stopPropagation()"></video>`
                    : `<img data-capture-thumb-id="${itemId}" alt="${item.name || 'Image'}" style="background: #f0f0f0;">`}
            </div>
        `;
        }).join('');
        
        // Load thumbnails asynchronously
        setTimeout(() => {
            items.forEach(item => {
                this.loadArchiveItemImage(item).then(result => {
                    const { imageData, videoUrl } = this._archiveMediaFromResult(result, item);
                    const el = document.querySelector(`[data-capture-thumb-id="${item.id}"]`);
                    if (!el) return;
                    if (item.type === 'video') {
                        const src = videoUrl || imageData;
                        if (src) el.src = src;
                        if (imageData) el.poster = imageData;
                    } else if (imageData) {
                        el.src = imageData;
                    }
                });
            });
        }, 100);
        
        return `<div class="captures-section"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon-sm"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>Artboards</h2><div class="archive-thumb-row">${html}</div><a href="#collection" data-route="collection" style="display:block;margin-top:0.5em;font-size:13px;">View All</a></div>`;
    }

    // ===== AUTO-SAVE & DRAFTS =====
    autoSaveTimer = null;

    setupAutoSave() {
        // Auto-save every 30 seconds when editing
        if (this.quill) {
            this.quill.on('text-change', () => {
                this.updateAutosaveStatus('editing');
                clearTimeout(this.autoSaveTimer);
                this.autoSaveTimer = setTimeout(() => this.autoSaveDraft(), 3000);
            });
        }
    }

    autoSaveDraft() {
        const titleInput = document.getElementById('article-title');
        const modal = document.getElementById('article-modal');
        if (!modal || modal.style.display === 'none') return;
        
        const title = titleInput?.value?.trim() || '';
        const content = this.quill ? this.convertFromHTML(this.quill.root.innerHTML) : '';
        
        if (title || content) {
            this.storage.saveDraft(this.currentArticleKey, { title, content });
            this.updateAutosaveStatus('saved');
        }
    }

    saveDraft() {
        this.autoSaveDraft();
        this.showUpdateNotification('Draft saved!');
    }

    updateAutosaveStatus(status) {
        const el = document.getElementById('autosave-status');
        if (!el) return;
        
        if (status === 'editing') {
            el.textContent = 'Editing...';
            el.className = 'autosave-status';
        } else if (status === 'saved') {
            el.textContent = 'Draft saved';
            el.className = 'autosave-status saved';
        }
    }

    // ===== PINNED ARTICLES =====
    renderPinnedArticles() {
        const pinned = this.storage.getPinnedArticles().filter(k => this.articles[k]);
        if (pinned.length === 0) return '';
        
        const html = pinned.map(k => 
            `<a href="#${k}" data-route="${k}" class="pinned-item">${this.articles[k].title}</a>`
        ).join('');
        
        return `<div class="pinned-section"><h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon-sm"><path d="M12 2v8m0 0l4-4m-4 4l-4-4m4 4v10"/><circle cx="12" cy="18" r="2"/></svg>Pinned</h3><div class="pinned-list">${html}</div></div>`;
    }

    togglePin(key) {
        this.storage.togglePinArticle(key);
        this.showArticle(key);
    }

    // ===== ACTIVITY FEED =====
    renderActivityFeedCompact() {
        const feed = this.storage.getActivityFeed().slice(0, 5);
        if (feed.length === 0) return '<div class="activity-feed-compact"><h3>Activity</h3><p style="color:#72777d;font-size:12px;">No recent activity</p></div>';
        
        const icons = { habit: '', capture: '', article: '', comment: '', remix: '' };
        const html = feed.map(a => {
            const icon = icons[a.type] || '•';
            let text = '';
            if (a.type === 'habit') text = a.data.habit;
            else if (a.type === 'capture') text = `<a href="${a.data.url}" target="_blank">${a.data.title?.slice(0,20) || 'Link'}</a>`;
            else if (a.type === 'article') text = `<a href="#${a.data.key}" data-route="${a.data.key}">${a.data.title?.slice(0,20) || 'Article'}</a>`;
            else if (a.type === 'remix') text = 'Remixed article';
            else text = a.type;
            return `<div class="activity-compact-item">${icon} ${text}</div>`;
        }).join('');
        
        return `<div class="activity-feed-compact"><h3>Activity</h3>${html}</div>`;
    }

    renderActivityFeed() {
        const feed = this.storage.getActivityFeed().slice(0, 5);
        if (feed.length === 0) return '';
        
        const icons = { habit: '', capture: '', article: '', comment: '', remix: '' };
        const html = feed.map(a => {
            const icon = icons[a.type] || '•';
            const time = new Date(a.timestamp).toLocaleDateString();
            let text = '';
            if (a.type === 'habit') text = `Completed <strong>${a.data.habit}</strong>`;
            else if (a.type === 'capture') text = `Captured <a href="${a.data.url}" target="_blank">${a.data.title}</a>`;
            else if (a.type === 'article') text = `Edited <a href="#${a.data.key}" data-route="${a.data.key}">${a.data.title}</a>`;
            else text = JSON.stringify(a.data);
            return `<div class="activity-item"><span class="activity-icon">${icon}</span><span class="activity-text">${text}</span><span class="activity-time">${time}</span></div>`;
        }).join('');
        
        return `<div class="activity-feed"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon-sm"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>Recent Activity</h2>${html}</div>`;
    }

    // ===== RANDOM ARTICLE =====
    randomArticle() {
        const keys = Object.keys(this.articles).filter(k => k !== 'main');
        if (keys.length === 0) { alert('No articles yet!'); return; }
        const randomKey = keys[Math.floor(Math.random() * keys.length)];
        this.navigate(randomKey);
    }

    // ===== BACKLINKS =====
    renderBacklinks(key) {
        const backlinks = this.storage.getBacklinks(key);
        if (backlinks.length === 0) return '';
        
        const html = backlinks.map(b => 
            `<a href="#${b.key}" data-route="${b.key}" class="backlink-item">${b.title}</a>`
        ).join('');
        
        return `<div class="backlinks-section"><h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="section-icon-sm"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Links to this page</h3><div class="backlinks-list">${html}</div></div>`;
    }

    // ===== BOTTOM SHEET =====
    openBottomSheet() {
        document.getElementById('bottom-sheet').classList.add('active');
    }

    closeBottomSheet() {
        document.getElementById('bottom-sheet').classList.remove('active');
    }
}

// Initialize app
let wikiApp;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        wikiApp = new WikiApp();
        window.wikiApp = wikiApp;
    });
} else {
    wikiApp = new WikiApp();
    window.wikiApp = wikiApp;
}
