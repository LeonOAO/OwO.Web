"use strict";

const KEY = "owo.browser.settings.v2.2";
const cfg = window.OWO_CONFIG || {};
const DUCKDUCKGO_HOME = "https://duckduckgo.com/";
const DUCKDUCKGO_SEARCH = "https://duckduckgo.com/?q=";

let settings = loadSettings();
let tabs = [];
let activeId = null;
let identitySyncTimers = [];

const $ = (selector) => document.querySelector(selector);
const el = {
    tabList: $("#tabList"),
    address: $("#address"),
    start: $("#start"),
    content: $("#content"),
    frame: $("#frame"),
    notice: $("#notice"),
    noticeText: $("#noticeText"),
    status: $("#status"),
    connection: $("#connection"),
    progress: $("#progress"),
    dialog: $("#settingsDialog"),
    closeSettings: $("#closeSettings"),
    settingsForm: $("#settingsForm"),
    wisp: $("#wisp"),
    preflight: $("#preflight"),
    lamp: $("#lamp"),
    testTitle: $("#testTitle"),
    testDetail: $("#testDetail"),
    siteIcon: $("#siteIcon"),
};

function loadSettings() {
    try {
        return {
            engine: cfg.defaultEngine === "ultraviolet" ? "ultraviolet" : "scramjet",
            wispUrl: cfg.defaultWispUrl || "",
            preflightEnabled: cfg.preflightEnabled !== false,
            ...JSON.parse(localStorage.getItem(KEY) || "{}"),
        };
    } catch {
        return { engine: "scramjet", wispUrl: "", preflightEnabled: true };
    }
}

function saveSettings() {
    localStorage.setItem(KEY, JSON.stringify(settings));
    updateConnection();
}

function updateConnection() {
    const engineName = settings.engine === "scramjet" ? "Scramjet" : "Ultraviolet";
    el.connection.textContent = `${engineName} · ${settings.wispUrl || "Wisp 尚未設定"}`;
}

function activeTab() {
    return tabs.find((tab) => tab.id === activeId);
}

function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function addTab() {
    const id = newId();
    tabs.push({
        id,
        title: "新分頁",
        url: "",
        favicon: "",
        history: [],
        index: -1,
    });
    activeId = id;
    renderTabs();
    showHome();
}

function createFaviconElement(tabData) {
    const icon = document.createElement("span");
    icon.className = "tab-favicon";

    if (tabData.favicon) {
        const image = document.createElement("img");
        image.src = tabData.favicon;
        image.alt = "";
        image.addEventListener("error", () => {
            icon.replaceChildren(document.createTextNode(tabData.url ? "◇" : "＋"));
        }, { once: true });
        icon.append(image);
    } else {
        icon.textContent = tabData.url ? "◇" : "＋";
    }

    return icon;
}

function renderTabs() {
    el.tabList.replaceChildren(...tabs.map((tabData) => {
        const tab = document.createElement("div");
        tab.className = `tab ${tabData.id === activeId ? "active" : ""}`;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(tabData.id === activeId));
        tab.tabIndex = 0;

        const icon = createFaviconElement(tabData);
        const title = document.createElement("span");
        title.className = "tab-title";
        title.textContent = tabData.title;
        title.title = tabData.title;

        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.textContent = "×";
        close.title = "關閉分頁";
        close.setAttribute("aria-label", `關閉 ${tabData.title}`);

        tab.append(icon, title, close);
        tab.addEventListener("click", () => activateTab(tabData.id));
        tab.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateTab(tabData.id);
            }
        });
        close.addEventListener("click", (event) => {
            event.stopPropagation();
            closeTab(tabData.id);
        });
        return tab;
    }));
}

async function activateTab(id) {
    activeId = id;
    renderTabs();
    const tab = activeTab();
    if (!tab?.url) {
        showHome();
        return;
    }
    updateBrowserIdentity(tab);
    await openCurrentTab();
}

function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);
    tabs = tabs.filter((tab) => tab.id !== id);
    if (!tabs.length) {
        addTab();
        return;
    }
    if (activeId === id) {
        activeId = tabs[Math.max(0, index - 1)]?.id || tabs[0].id;
    }
    void activateTab(activeId);
}

function clearIdentitySyncTimers() {
    identitySyncTimers.forEach((timer) => clearTimeout(timer));
    identitySyncTimers = [];
}

function showHome() {
    clearIdentitySyncTimers();
    el.start.hidden = false;
    el.content.hidden = true;
    el.notice.hidden = true;
    el.address.value = "";
    el.frame.removeAttribute("src");
    el.status.textContent = "已就緒";
    if (el.siteIcon) el.siteIcon.textContent = "◇";
    document.title = "OwO Browser";
}

function looksLikeSearch(text) {
    if (/\s/.test(text)) return true;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(text)) return false;
    if (/^localhost(?::\d+)?(?:\/|$)/i.test(text)) return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/|$)/.test(text)) return false;
    return !text.includes(".");
}

function normalizeTarget(value) {
    const text = String(value || "").trim();
    if (!text) throw new Error("請輸入網址或搜尋內容。");

    const candidate = looksLikeSearch(text)
        ? `${DUCKDUCKGO_SEARCH}${encodeURIComponent(text)}`
        : (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(text) ? text : `https://${text}`);

    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) {
        throw new Error("網址需使用 http:// 或 https://。");
    }
    return url.href;
}

function normalizeWisp(value = settings.wispUrl) {
    const text = String(value || "").trim();
    if (!text) throw new Error("請先填入 Wisp 位址。");
    const url = new URL(text);
    if (!/^wss?:$/.test(url.protocol)) {
        throw new Error("Wisp 需以 ws:// 或 wss:// 開頭。");
    }
    if (location.protocol === "https:" && url.protocol !== "wss:") {
        throw new Error("GitHub Pages 使用 HTTPS，Wisp 請使用 wss://。");
    }
    return url.href;
}

function testSocket(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const socket = new WebSocket(url);
        const timer = setTimeout(() => finish(new Error("連線逾時")), timeout);

        function finish(error) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            try { socket.close(); } catch {}
            error ? reject(error) : resolve();
        }

        socket.addEventListener("open", () => finish());
        socket.addEventListener("error", () => finish(new Error("WebSocket 握手失敗")));
    });
}

async function navigate(value) {
    try {
        const url = normalizeTarget(value);
        const tab = activeTab();
        tab.url = url;
        tab.title = new URL(url).hostname;
        tab.favicon = "";
        tab.history = tab.history.slice(0, tab.index + 1);
        tab.history.push(url);
        tab.index = tab.history.length - 1;
        updateBrowserIdentity(tab);
        renderTabs();
        await openCurrentTab();
    } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
    }
}

async function openCurrentTab() {
    const tab = activeTab();
    if (!tab?.url) {
        showHome();
        return;
    }

    el.progress.classList.add("loading");
    el.status.textContent = "正在建立工作階段";

    try {
        const wisp = normalizeWisp();
        if (settings.preflightEnabled) await testSocket(wisp);
        await showEngineView(tab.url, wisp);
    } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
    } finally {
        el.progress.classList.remove("loading");
    }
}

async function showEngineView(target, wisp = settings.wispUrl) {
    el.start.hidden = true;
    el.content.hidden = true;
    el.notice.hidden = true;

    const adapter = settings.engine === "scramjet"
        ? window.owoScramjetAdapter
        : window.owoUltravioletAdapter;

    if (!adapter?.getUrl && !adapter?.launch) {
        showNotice(`${settings.engine === "scramjet" ? "Scramjet" : "Ultraviolet"} Runtime Adapter 尚未接入。`);
        return;
    }

    const result = adapter.getUrl
        ? await adapter.getUrl({ target, wisp })
        : await adapter.launch({ target, wisp, frame: el.frame });

    if (typeof result === "string") {
        el.frame.src = result;
        el.content.hidden = false;
    }
    el.status.textContent = "已開啟";
}

function showNotice(message) {
    el.start.hidden = true;
    el.content.hidden = true;
    el.notice.hidden = false;
    el.noticeText.textContent = message;
    el.status.textContent = "執行提示";
}

function moveHistory(delta) {
    const tab = activeTab();
    const next = tab.index + delta;
    if (next < 0 || next >= tab.history.length) return;
    tab.index = next;
    tab.url = tab.history[next];
    tab.title = new URL(tab.url).hostname;
    tab.favicon = "";
    updateBrowserIdentity(tab);
    renderTabs();
    void openCurrentTab();
}

function openSettings() {
    el.wisp.value = settings.wispUrl;
    el.preflight.checked = settings.preflightEnabled;
    document.querySelectorAll('[name="engine"]').forEach((radio) => {
        radio.checked = radio.value === settings.engine;
    });
    el.lamp.className = "";
    el.testTitle.textContent = "尚未檢測";
    el.testDetail.textContent = "可先測試 Wisp 連線。";
    el.dialog.showModal();
}

function resolvePageFavicon(doc, pageUrl) {
    const iconLinks = doc.querySelectorAll([
        'link[rel~="icon"]',
        'link[rel="shortcut icon"]',
        'link[rel="apple-touch-icon"]',
        'link[rel="apple-touch-icon-precomposed"]',
    ].join(","));

    for (const iconLink of iconLinks) {
        try {
            const href = iconLink.getAttribute("href");
            if (!href) continue;

            const candidate = new URL(href, pageUrl);
            if (!/^https?:$/.test(candidate.protocol)) continue;
            if (candidate.origin === location.origin) continue;
            return candidate.href;
        } catch {
            // Continue searching other icon declarations.
        }
    }

    return "";
}

let displayedSiteIconUrl = "";

function setSiteIcon(favicon) {
    if (!el.siteIcon) return;

    const normalized = String(favicon || "").trim();
    if (normalized === displayedSiteIconUrl) return;

    if (!normalized) {
        displayedSiteIconUrl = "";
        el.siteIcon.replaceChildren(document.createTextNode("◇"));
        return;
    }

    let parsed;
    try {
        parsed = new URL(normalized);
    } catch {
        return;
    }

    if (!/^https?:$/.test(parsed.protocol) || parsed.origin === location.origin) return;

    const image = document.createElement("img");
    image.alt = "";
    image.addEventListener("load", () => {
        displayedSiteIconUrl = parsed.href;
    }, { once: true });
    image.addEventListener("error", () => {
        if (displayedSiteIconUrl === parsed.href) displayedSiteIconUrl = "";
        if (image.isConnected) {
            el.siteIcon.replaceChildren(document.createTextNode("◇"));
        }
    }, { once: true });
    image.src = parsed.href;
    el.siteIcon.replaceChildren(image);
}

function updateBrowserIdentity(tab) {
    if (!tab || tab.id !== activeId) return;
    el.address.value = tab.url || "";
    setSiteIcon(tab.favicon || "");
    document.title = tab.url ? `${tab.title} - OwO Browser` : "OwO Browser";
}

function readFrameIdentity() {
    const tab = activeTab();
    if (!tab?.url) return;

    let pageUrl = tab.url;
    let pageTitle = "";
    let favicon = "";

    try {
        const frameWindow = el.frame.contentWindow;
        const frameDocument = el.frame.contentDocument;
        const frameUrl = frameWindow?.location?.href;

        if (frameUrl && frameUrl !== "about:blank") {
            pageUrl = frameUrl;
        }
        pageTitle = String(frameDocument?.title || "").trim();
        favicon = frameDocument ? resolvePageFavicon(frameDocument, pageUrl) : "";
    } catch {
        pageUrl = tab.url;
    }

    try {
        const parsed = new URL(pageUrl);
        if (parsed.origin === location.origin && tab.url) {
            pageUrl = tab.url;
        }
    } catch {
        pageUrl = tab.url;
    }

    tab.url = pageUrl;
    tab.title = pageTitle || new URL(tab.url).hostname;
    if (favicon) tab.favicon = favicon;
    updateBrowserIdentity(tab);
    renderTabs();
}

function scheduleFrameIdentitySync() {
    clearIdentitySyncTimers();
    [100, 500, 1200, 2500].forEach((delay) => {
        identitySyncTimers.push(window.setTimeout(readFrameIdentity, delay));
    });
}

$("#addTab").addEventListener("click", addTab);
$("#addressForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void navigate(el.address.value);
});
$("#startForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void navigate($("#startInput").value);
});
document.querySelectorAll("[data-url]").forEach((button) => {
    button.addEventListener("click", () => void navigate(button.dataset.url));
});
$("#home").addEventListener("click", () => {
    const tab = activeTab();
    tab.url = "";
    tab.title = "新分頁";
    tab.favicon = "";
    tab.history = [];
    tab.index = -1;
    renderTabs();
    showHome();
});
$("#noticeHome").addEventListener("click", () => $("#home").click());
$("#back").addEventListener("click", () => moveHistory(-1));
$("#forward").addEventListener("click", () => moveHistory(1));
$("#reload").addEventListener("click", async () => {
    const tab = activeTab();
    if (!tab?.url) {
        showHome();
        return;
    }

    el.status.textContent = "正在重新連線";
    el.progress.classList.add("loading");

    try {
        el.frame.src = "about:blank";
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await openCurrentTab();
    } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
    } finally {
        el.progress.classList.remove("loading");
    }
});
$("#settings").addEventListener("click", openSettings);
$("#startSettings").addEventListener("click", openSettings);
$("#star").addEventListener("click", () => {
    $("#star").textContent = $("#star").textContent === "☆" ? "★" : "☆";
});

el.closeSettings.addEventListener("click", () => el.dialog.close());
el.dialog.addEventListener("click", (event) => {
    if (event.target === el.dialog) el.dialog.close();
});
el.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        settings = {
            engine: $('[name="engine"]:checked')?.value || "scramjet",
            wispUrl: normalizeWisp(el.wisp.value),
            preflightEnabled: el.preflight.checked,
        };
        saveSettings();
        el.dialog.close();
        el.status.textContent = "設定已儲存";
    } catch (error) {
        el.lamp.className = "bad";
        el.testTitle.textContent = "設定錯誤";
        el.testDetail.textContent = error instanceof Error ? error.message : String(error);
    }
});
$("#testButton").addEventListener("click", async () => {
    el.testTitle.textContent = "正在測試";
    el.testDetail.textContent = "建立 WebSocket 握手...";
    el.lamp.className = "";
    try {
        await testSocket(normalizeWisp(el.wisp.value));
        el.lamp.className = "ok";
        el.testTitle.textContent = "連線成功";
        el.testDetail.textContent = "Wisp 已接受握手。";
    } catch (error) {
        el.lamp.className = "bad";
        el.testTitle.textContent = "連線失敗";
        el.testDetail.textContent = error instanceof Error ? error.message : String(error);
    }
});

el.frame.addEventListener("load", scheduleFrameIdentitySync);

updateConnection();
addTab();
