/* ======== App Utilities and Features ======== */
(function () {
    // Утилиты
    const Utils = {
        debounce(func, wait) {
            let timeout;
            return function (...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        }
    };

    /* ======== Mobile Menu Block ======== */
    function setupMenuToggles() {
        const menus = [
            { button: '.burger-menu', menu: '.mobile-menu' },
            { button: '.social-menu', menu: '.mobile-social' }
        ];

        menus.forEach(({ button, menu }) => {
            const btn = document.querySelector(button);
            const menuEl = document.querySelector(menu);
            if (btn && menuEl) {
                const debouncedToggle = Utils.debounce(() => toggleMenu(menuEl, btn, menus), 200);
                btn.addEventListener('click', debouncedToggle);
                menuEl.addEventListener('click', (e) => {
                    if (e.target.tagName === 'A' && menuEl.classList.contains('active')) {
                        closeAllMenus();
                    }
                });
            }
        });

        const overlay = document.querySelector('.overlay');
        if (overlay) {
            const debouncedClose = Utils.debounce(closeAllMenus, 200);
            overlay.addEventListener('click', debouncedClose);
        }

        const debouncedEscape = Utils.debounce((e) => {
            if (e.key === 'Escape' && menus.some(({ menu }) => document.querySelector(menu)?.classList.contains('active'))) {
                closeAllMenus();
            }
        }, 200);
        document.addEventListener('keydown', debouncedEscape);
    }

    function toggleMenu(menu, button, menus) {
        const isOpen = menu.classList.contains('active');
        closeAllMenus();
        if (!isOpen) {
            menu.classList.add('active');
            button.classList.add('active');
            document.querySelector('.overlay').classList.add('active');
            button.querySelector('.open').style.display = 'none';
            button.querySelector('.close').style.display = 'inline';
        }
    }

    function closeAllMenus() {
        document.querySelectorAll('.mobile-menu, .mobile-social, .overlay, .burger-menu, .social-menu').forEach(el => {
            el.classList.remove('active');
            if (el.matches('.burger-menu, .social-menu')) {
                el.querySelector('.open').style.display = 'inline';
                el.querySelector('.close').style.display = 'none';
            }
        });
    }

    /* ======== Dark Theme Block ======== */
    function setupDarkTheme() {
        const toggleBtn = document.getElementById('theme-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                setTheme(newTheme);
            });
        }

        const savedTheme = localStorage.getItem('theme') || 'light';
        setTheme(savedTheme);

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', (e) => {
            const newTheme = e.matches ? 'dark' : 'light';
            if (!localStorage.getItem('theme')) {
                setTheme(newTheme);
            }
        });
    }

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }

    /* ======== Layout and Zoom Block ======== */
    function updateLayout() {
        const vpWidth = window.innerWidth;
        const zoom = window.outerWidth / window.innerWidth;
        const virtualWidth = vpWidth * zoom;
        const stats = document.getElementById('stats');

        if (vpWidth < 1280) {
            document.documentElement.style.removeProperty('--container-width');
            document.documentElement.style.removeProperty('--font-size');
            if (stats) {
                stats.textContent = `Viewport: ${vpWidth}px\nZoom: ${(zoom * 100).toFixed(0)}%\nJS не активен ниже 1280px`;
            }
            return;
        }

        const containerWidth = 853.4 + (Math.max(1280, Math.min(virtualWidth, 5120)) - 1280) * (3413 - 853.4) / (5120 - 1280);
        const fontSize = 8 + (Math.max(1280, Math.min(virtualWidth, 5120)) - 1280) * (32 - 8) / (5120 - 1280);

        document.documentElement.style.setProperty('--container-width', `${containerWidth}px`);
        document.documentElement.style.setProperty('--font-size', `${fontSize}px`);

        if (stats) {
            stats.textContent = `Viewport: ${vpWidth}px\nZoom: ${(zoom * 100).toFixed(0)}%\nVirtual width: ${virtualWidth.toFixed(0)}px\nContainer: ${containerWidth.toFixed(0)}px\nFont-size: ${fontSize.toFixed(2)}px`;
        }
    }

    const debouncedUpdateLayout = Utils.debounce(updateLayout, 100);

    /* ======== Initialization ======== */
    window.addEventListener('resize', debouncedUpdateLayout);
    setupMenuToggles();
    setupDarkTheme();
    updateLayout();
})();