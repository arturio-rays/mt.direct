/* ======== Video Player Module ======== */
(function () {
    const CONFIG = {
        youtube: {
            embedBaseUrl: 'https://www.youtube.com/embed/',
            moreVideosUrl: 'https://www.youtube.com/@mobiltelefonru',
            subscriptionUrl: 'https://www.youtube.com/@mobiltelefonru?sub_confirmation=1',
            parseVideoId: videoId => videoId,
            formatEmbedUrl: (videoId, config) => `${config.embedBaseUrl}${videoId}`,
            formatAutoplayUrl: (videoId, config) => `${config.embedBaseUrl}${videoId}?autoplay=1`
        },
        vk: {
            embedBaseUrl: 'https://vk.com/video_ext.php',
            moreVideosUrl: 'https://vk.com/videos-35905857',
            subscriptionUrl: 'https://vk.com/public35905857',
            parseVideoId: videoId => {
                if (typeof videoId !== 'string' || !videoId.includes('_')) {
                    Utils.log('error', `Невалидный videoId для VK: ${videoId}`);
                    return null;
                }
                return videoId.split('_');
            },
            formatEmbedUrl: (videoId, config) => {
                const parsed = config.parseVideoId(videoId);
                if (!parsed) return '';
                const [ownerId, id] = parsed;
                return `${config.embedBaseUrl}?oid=${ownerId}&id=${id}`;
            },
            formatAutoplayUrl: (videoId, config) => {
                const parsed = config.parseVideoId(videoId);
                if (!parsed) return '';
                const [ownerId, id] = parsed;
                return `${config.embedBaseUrl}?oid=${ownerId}&id=${id}&autoplay=1`;
            },
        },
        common: {
            videoId: video => video.id,
            thumbnail: video => video.thumbnail,
            title: video => video.title,
            description: video => video.description
        },
        constants: {
            MAX_DESCRIPTION_LENGTH: 100,
            STATIC_VIDEOS_COUNT: 4,
            SERVER_URL: 'http://localhost:3000',
            RETRY_ATTEMPTS: 3,
            RETRY_DELAY: 1000,
            TOAST_DURATION: 3000
        }
    };

    const Utils = {
        debounce(func, wait) {
            let timeout;
            return function (...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        },
        log(level, message) {
            const levels = { info: console.log, warn: console.warn, error: console.error };
            (levels[level] || console.log)(`[VideoPlayer] ${message}`);
        },
        showToast(message, options = {}) {
            const toastQueue = Utils.toastQueue || (Utils.toastQueue = []);
            toastQueue.push({ message, options });
            if (toastQueue.length > 1) return;
            const processToast = () => {
                const { message, options } = toastQueue[0];
                const toast = document.createElement('div');
                toast.className = 'toast';
                toast.innerHTML = options.retry
                    ? `${message} <button class="toast-retry">Попробовать снова</button>`
                    : message;
                document.body.appendChild(toast);
                if (options.retry) {
                    toast.querySelector('.toast-retry').addEventListener('click', () => {
                        toast.classList.add('fade-out');
                        setTimeout(() => { toast.remove(); options.retry(); }, 300);
                    });
                }
                toast.addEventListener('click', () => {
                    toast.classList.add('fade-out');
                    setTimeout(() => toast.remove(), 300);
                });
                setTimeout(() => {
                    toast.classList.add('fade-out');
                    setTimeout(() => {
                        toast.remove();
                        toastQueue.shift();
                        if (toastQueue.length) processToast();
                    }, 300);
                }, CONFIG.constants.TOAST_DURATION);
            };
            processToast();
        }
    };

    const VideoPlayer = {
        currentPlatform: 'youtube',
        previousPlatform: null,
        videoCache: { youtube: [], vk: [] },
        videoData: [],
        subscriberCounts: { youtube: '0', vk: '0' },
        domCache: { youtube: {}, vk: {} },
        selectors: {
            mainIframe: platform => `video-player-${platform}`,
            mainThumbnail: platform => `main-video-thumbnail-${platform}`,
            mainTitle: platform => `main-video-title-${platform}`,
            mainDescription: platform => `video-description-${platform}`,
            staticVideos: platform => `.additional-video-item[data-platform="${platform}"]:not(.dynamic)`,
            additionalContainer: 'additional-videos',
            moreVideosLink: '.more-videos a',
            subscriptionLink: '.subscription .subscribe-btn',
            platformCount: '.subscription .platform-count',
            platformLinks: '.platformLink'
        },
        observer: null,

        initDomCache() {
            ['youtube', 'vk'].forEach(platform => {
                const cache = {
                    mainIframe: document.getElementById(this.selectors.mainIframe(platform)),
                    mainThumbnail: document.getElementById(this.selectors.mainThumbnail(platform)),
                    mainTitle: document.getElementById(this.selectors.mainTitle(platform)),
                    mainDescription: document.getElementById(this.selectors.mainDescription(platform)),
                    staticVideos: document.querySelectorAll(this.selectors.staticVideos(platform)),
                    additionalContainer: document.getElementById(this.selectors.additionalContainer),
                    moreVideosLink: document.querySelector(this.selectors.moreVideosLink),
                    subscriptionLink: document.querySelector(this.selectors.subscriptionLink),
                    platformCount: document.querySelector(this.selectors.platformCount),
                    platformLinks: document.querySelectorAll(this.selectors.platformLinks)
                };
                if (!cache.mainIframe || !cache.mainThumbnail || !cache.additionalContainer) {
                    Utils.log('error', `Не найдены необходимые DOM-элементы для платформы ${platform}`);
                }
                this.domCache[platform] = cache;
            });
        },

        bindPlatformLinks() {
            ['youtube', 'vk'].forEach(platform => {
                const link = document.querySelector(`${this.selectors.platformLinks}[data-platform="${platform}"]`);
                if (link) {
                    const handler = () => {
                        if (this.currentPlatform !== platform) {
                            this.debouncedToggleVideo(platform);
                        }
                    };
                    link.addEventListener('click', handler);
                    this.eventListeners = this.eventListeners || [];
                    this.eventListeners.push({ element: link, type: 'click', handler });
                }
            });
        },

        getConfig(platform) {
            return { ...CONFIG.common, ...CONFIG[platform] };
        },

        updateElementStyles(selector, platform, styles = {}) {
            document.querySelectorAll(selector).forEach(el => {
                el.classList.remove('youtube', 'vk');
                el.classList.add(platform);
                Object.assign(el.style, styles);
            });
        },

        updatePlatformLinks(subscriberCount) {
            const config = this.getConfig(this.currentPlatform);
            const { moreVideosLink, subscriptionLink, platformCount } = this.domCache[this.currentPlatform];
            if (moreVideosLink) moreVideosLink.href = config.moreVideosUrl;
            this.updateElementStyles('.more-videos', this.currentPlatform);
            if (subscriptionLink) {
                subscriptionLink.href = config.subscriptionUrl;
                this.updateElementStyles('.subscription .subscribe-btn', this.currentPlatform);
            }
            if (platformCount) platformCount.textContent = subscriberCount || '0';
        },

        togglePlatformVideos() {
            document.querySelectorAll('.main-video-wrapper, .additional-video-item').forEach(video => {
                const shouldDisplay = video.dataset.platform === this.currentPlatform;
                video.style.display = shouldDisplay ? 'flex' : 'none';
                if (shouldDisplay && video.classList.contains('loaded')) {
                    const skeleton = video.querySelector('.skeleton');
                    const skeletonTexts = video.querySelectorAll('.skeleton-text');
                    const loadedContents = video.querySelectorAll('.loaded-content');
                    if (skeleton) skeleton.style.display = 'none';
                    skeletonTexts.forEach(text => text.style.display = 'none');
                    loadedContents.forEach(content => content.style.display = 'block');
                }
            });
        },

        async loadVideos(platform, isInitialLoad = false) {
            if (this.videoCache[platform].length) {
                this.videoData = this.videoCache[platform];
                this.updateVideos();
                this.updatePlatformLinks(this.subscriberCounts[platform]);
                return Promise.resolve(true);
            }

            const spinner = document.getElementById('loading-spinner');
            if (spinner) spinner.style.display = 'flex';

            const attemptFetch = async (attempt = 1) => {
                try {
                    const response = await fetch(`${CONFIG.constants.SERVER_URL}/api/videos/${platform}`);
                    if (!response.ok) throw new Error(`HTTP ошибка: ${response.status}`);
                    const { videos, subscriberCount } = await response.json();

                    if (!Array.isArray(videos) || !videos.length) {
                        throw new Error(`Видео с ${platform} не загружены!`);
                    }

                    this.videoCache[platform] = videos;
                    this.subscriberCounts[platform] = subscriberCount || '0';
                    this.videoData = videos;
                    this.updatePlatformLinks(this.subscriberCounts[platform]);
                    this.updateVideos();
                    return true;
                } catch (error) {
                    if (attempt < CONFIG.constants.RETRY_ATTEMPTS) {
                        Utils.log('warn', `Попытка ${attempt} загрузки ${platform} не удалась, повтор через ${CONFIG.constants.RETRY_DELAY}ms`);
                        await new Promise(resolve => setTimeout(resolve, CONFIG.constants.RETRY_DELAY));
                        return attemptFetch(attempt + 1);
                    }
                    Utils.log('error', `Ошибка загрузки ${platform} после ${CONFIG.constants.RETRY_ATTEMPTS} попыток: ${error.message}`);
                    return false;
                }
            };

            return attemptFetch().then(success => {
                if (spinner) spinner.style.display = 'none';
                if (!success) {
                    if (!isInitialLoad && this.previousPlatform && this.previousPlatform !== platform) {
                        Utils.showToast(`Не удалось загрузить видео с ${platform}. Возвращаемся к ${this.previousPlatform}.`);
                        this.currentPlatform = this.previousPlatform;
                        this.updatePlatformUI();
                        this.videoData = this.videoCache[this.currentPlatform];
                        this.updateVideos();
                    } else if (!isInitialLoad) {
                        Utils.showToast(`Не удалось загрузить видео с ${platform}. Попробуйте позже.`, {
                            retry: () => this.loadVideos(platform, isInitialLoad)
                        });

                        setTimeout(() => this.loadVideos(platform, isInitialLoad), 30000);
                    }
                }
                return success;
            });
        },

        async initialLoad() {
            this.initDomCache();
            this.bindPlatformLinks();
            this.setupIntersectionObserver();
            const youtubeSuccess = await this.loadVideos('youtube', true);
            if (!youtubeSuccess) {
                Utils.log('info', 'YouTube не загрузился, пробуем VK');
                const vkSuccess = await this.loadVideos('vk', true);
                if (!vkSuccess) {
                    Utils.showToast('Не удалось загрузить видео. Проверьте интернет и попробуйте снова.', {
                        retry: () => this.initialLoad()
                    });
                } else {
                    this.currentPlatform = 'vk';
                    this.updatePlatformUI();
                }
            } else {
                this.updatePlatformLinks(this.subscriberCounts.youtube);
                this.togglePlatformVideos();
            }
        },

        setupIntersectionObserver() {
            if (!('IntersectionObserver' in window)) {
                Utils.log('warn', 'IntersectionObserver не поддерживается, ленивая загрузка отключена');
                return;
            }
            this.observer = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const videoItem = entry.target;
                        videoItem.classList.add('visible');
                        observer.unobserve(videoItem);
                    }
                });
            }, { rootMargin: '100px' });

            ['youtube', 'vk'].forEach(platform => {
                this.domCache[platform].staticVideos.forEach(video => this.observer.observe(video));
            });
        },

        setMainVideo(video, index = 0) {
            if (!video) return;

            const config = this.getConfig(this.currentPlatform);
            const videoId = config.videoId(video);
            if (!videoId) {
                Utils.log('warn', 'Некорректный videoId, пропускаем setMainVideo');
                return;
            }

            const { mainIframe, mainThumbnail, mainTitle, mainDescription } = this.domCache[this.currentPlatform];
            if (!mainIframe || !mainThumbnail) {
                Utils.log('warn', 'Элементы для main video не найдены');
                return;
            }

            const thumbnailImg = mainThumbnail.querySelector('img');
            const skeleton = mainThumbnail.querySelector('.skeleton');
            const playButton = mainThumbnail.querySelector('.play-button');
            const titleSkeleton = mainTitle.querySelector('.skeleton-text');
            const descriptionSkeletons = mainDescription.querySelectorAll('.skeleton-text');

            if (thumbnailImg && thumbnailImg.src !== config.thumbnail(video)) {
                thumbnailImg.src = config.thumbnail(video);
                thumbnailImg.alt = config.title(video);
                document.querySelectorAll('link[rel="preload"][as="image"]').forEach(link => link.remove());
                const link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = config.thumbnail(video);
                document.head.appendChild(link);
            }

            if (mainIframe.src !== config.formatEmbedUrl(videoId, config)) {
                mainIframe.src = config.formatEmbedUrl(videoId, config) || '';
            }

            if (mainTitle && mainTitle.textContent !== config.title(video)) {
                mainTitle.textContent = config.title(video) || '';
            }

            const description = (config.description(video) || '').substring(0, CONFIG.constants.MAX_DESCRIPTION_LENGTH) + '...';
            if (mainDescription && mainDescription.textContent !== description) {
                mainDescription.textContent = description;
            }

            mainThumbnail.parentElement.classList.add('loaded');
            if (skeleton) skeleton.style.display = 'none';
            if (playButton) playButton.style.display = 'block';
            if (thumbnailImg) thumbnailImg.style.display = 'block';
            if (titleSkeleton) titleSkeleton.style.display = 'none';
            descriptionSkeletons.forEach(s => s.style.display = 'none');

            mainThumbnail.style.display = 'flex';
            mainIframe.style.display = 'none';
            mainThumbnail.onclick = () => this.playMainVideo(videoId);

            this.videoData.splice(index, 1);
            this.videoData.unshift(video);
            this.videoCache[this.currentPlatform] = this.videoData;
        },

        playMainVideo(videoId) {
            const config = this.getConfig(this.currentPlatform);
            const { mainIframe, mainThumbnail } = this.domCache[this.currentPlatform];
            if (!mainIframe || !mainThumbnail) return;
            mainThumbnail.style.display = 'none';
            mainIframe.style.display = 'block';
            mainIframe.src = config.formatAutoplayUrl(videoId, config);
        },

        updateVideos() {
            if (!this.videoData.length) {
                Utils.log('warn', 'Нет данных для обновления видео');
                return;
            }

            const config = this.getConfig(this.currentPlatform);
            this.setMainVideo(this.videoData[0], 0);
            this.updateStaticVideos(config);
            this.updateDynamicVideos(config);
        },

        updateStaticVideos(config) {
            const { staticVideos } = this.domCache[this.currentPlatform];
            staticVideos.forEach(video => video.style.display = 'none');

            for (let i = 1; i < Math.min(CONFIG.constants.STATIC_VIDEOS_COUNT, this.videoData.length); i++) {
                const video = this.videoData[i];
                const videoItem = staticVideos[i - 1];
                if (videoItem) {
                    this.updateVideoItem(videoItem, video, config, i);
                    videoItem.style.display = 'flex';
                }
            }
        },

        updateDynamicVideos(config) {
            const { additionalContainer } = this.domCache[this.currentPlatform];
            const fragment = document.createDocumentFragment();
            additionalContainer.querySelectorAll('.additional-video-item.dynamic').forEach(video => video.remove());

            for (let i = CONFIG.constants.STATIC_VIDEOS_COUNT; i < this.videoData.length; i++) {
                const video = this.videoData[i];
                const videoItem = this.createVideoItem(video, config, i);
                if (this.observer) this.observer.observe(videoItem);
                fragment.appendChild(videoItem);
            }
            additionalContainer.appendChild(fragment);
        },

        updateVideoItem(videoItem, video, config, index) {
            const currentVideoId = videoItem.dataset.videoId;
            if (currentVideoId === config.videoId(video)) return;

            videoItem.dataset.videoId = config.videoId(video);
            videoItem.onclick = () => this.debouncedSwapVideo(index);

            const thumbnailImg = videoItem.querySelector('.additional-video-thumbnail img');
            const skeleton = videoItem.querySelector('.skeleton');
            const playButton = videoItem.querySelector('.play-button');
            const title = videoItem.querySelector('.additional-video-title .loaded-content');
            const skeletonText = videoItem.querySelector('.additional-video-title .skeleton-text');

            if (thumbnailImg && thumbnailImg.src !== config.thumbnail(video)) {
                thumbnailImg.src = config.thumbnail(video);
                thumbnailImg.alt = config.title(video);
            }
            if (playButton) {
                playButton.classList.remove('youtube', 'vk');
                playButton.classList.add(this.currentPlatform);
            }
            if (title && title.textContent !== config.title(video)) {
                title.textContent = config.title(video);
            }

            videoItem.classList.add('loaded');
            if (skeleton) skeleton.style.display = 'none';
            if (playButton) playButton.style.display = 'flex';
            if (thumbnailImg) thumbnailImg.style.display = 'block';
            if (skeletonText) skeletonText.style.display = 'none';
            if (title) title.style.display = 'block';
        },

        createVideoItem(video, config, index) {
            const template = document.createElement('template');
            template.innerHTML = `
                <div class="additional-video-item dynamic" data-platform="${this.currentPlatform}">
                    <button class="additional-video-thumbnail" aria-label="Воспроизвести видео ${index + 1}">
                        <div class="skeleton" style="width: 100%; height: 150px; border-radius: 8px;"></div>
                        <img src="${config.thumbnail(video)}" alt="${config.title(video)}" loading="lazy" style="display: none;">
                        <span class="play-button small ${this.currentPlatform}" aria-hidden="true" style="display: none;"></span>
                    </button>
                    <h3 class="additional-video-title">
                        <span class="skeleton-text" style="width: 80%; height: 16px; display: block;"></span>
                        <span class="loaded-content" style="display: none;">${config.title(video)}</span>
                    </h3>
                </div>
            `;
            const videoItem = template.content.firstElementChild;
            videoItem.dataset.videoId = config.videoId(video);
            videoItem.onclick = () => this.debouncedSwapVideo(index);
            return videoItem;
        },

        swapVideo(index) {
            if (index >= this.videoData.length) return;
            const newMainVideo = this.videoData[index];
            this.setMainVideo(newMainVideo, index);
            this.updateVideos();
        },

        toggleVideo(newPlatform) {
            if (!CONFIG[newPlatform]) {
                Utils.log('error', `Платформа ${newPlatform} не поддерживается`);
                return;
            }

            Utils.log('info', `Переключение на платформу: ${newPlatform}`);

            const currentIframe = this.domCache[this.currentPlatform].mainIframe;
            if (currentIframe) currentIframe.src = '';

            this.previousPlatform = this.currentPlatform;
            this.currentPlatform = newPlatform;
            this.updatePlatformUI();

            const spinner = document.getElementById('loading-spinner');
            if (spinner) spinner.style.display = 'flex';

            this.updateElementStyles(`#${this.selectors.mainThumbnail(newPlatform)}`, newPlatform, { display: 'flex' });

            this.loadVideos(newPlatform).then(success => {
                if (spinner) spinner.style.display = 'none';
                if (success) {
                    Utils.log('info', `Успешно загружены видео для ${newPlatform}`);
                } else {
                    Utils.log('warn', `Не удалось загрузить видео для ${newPlatform}, UI уже обновлен`);
                }
            }).catch(error => {
                if (spinner) spinner.style.display = 'none';
                Utils.log('error', `Ошибка загрузки видео на платформе ${newPlatform}: ${error.message}`);
            });
        },

        updatePlatformUI() {
            Utils.log('info', `Обновление UI для платформы: ${this.currentPlatform}`);

            document.querySelectorAll(this.selectors.platformLinks).forEach(link => {
                const platform = link.dataset.platform;
                link.classList.toggle('active', this.currentPlatform === platform);
                link.classList.toggle('inactive', this.currentPlatform !== platform);
            });

            this.updateElementStyles('.play-button', this.currentPlatform);
            this.updatePlatformLinks(this.subscriberCounts[this.currentPlatform]);
            this.togglePlatformVideos();
        },

        cleanup() {
            if (this.eventListeners) {
                this.eventListeners.forEach(({ element, type, handler }) => {
                    element.removeEventListener(type, handler);
                });
                this.eventListeners = [];
            }
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            document.querySelectorAll('link[rel="preload"][as="image"]').forEach(link => link.remove());
        },

        debouncedSwapVideo: null,
        debouncedToggleVideo: null,
        eventListeners: null
    };

    VideoPlayer.debouncedSwapVideo = Utils.debounce((index) => VideoPlayer.swapVideo(index), 300);
    VideoPlayer.debouncedToggleVideo = Utils.debounce((platform) => VideoPlayer.toggleVideo(platform), 200);

    window.VideoPlayer = VideoPlayer;

    VideoPlayer.initialLoad();
})();