import { BareMuxConnection } from "../BareMux/index.mjs";

const ROOT_URL = new URL("../", import.meta.url);
const VERSION = "2.4.5";
const FILES = Object.freeze({
    serviceWorker: new URL(`sw.js?v=${VERSION}`, ROOT_URL).href,
    scramjetAll: new URL("Scramjet/scramjet.all.js", ROOT_URL).href,
    scramjetWasm: new URL("Scramjet/scramjet.wasm.wasm", ROOT_URL).href,
    scramjetSync: new URL("Scramjet/scramjet.sync.js", ROOT_URL).href,
    bareMuxWorker: new URL("BareMux/worker.js", ROOT_URL).href,
    libcurlTransport: new URL("Transport/index.mjs", ROOT_URL).href,
});

let controller = null;
let connection = null;
let transportReady = null;
let initializedWisp = "";
let initialization = null;
let runtimeScriptPromise = null;
let activeFrameElement = null;
let activeScramjetFrame = null;
let activeUrlListener = null;

try {
    connection = new BareMuxConnection(FILES.bareMuxWorker);
    console.info(`載入 ScramjetAdapter.js ${VERSION}`);
} catch (error) {
    console.warn("BareMux 預先初始化失敗，將於開啟頁面時重試。", error);
}

function ensureSecureContext() {
    if (!window.isSecureContext && location.hostname !== "localhost") {
        throw new Error("Scramjet 需要 HTTPS 或 localhost，無法從 file:// 直接啟動。");
    }
    if (!("serviceWorker" in navigator)) throw new Error("目前瀏覽器不支援 Service Worker。");
    if (!("SharedWorker" in window)) throw new Error("目前瀏覽器不支援 Bare-Mux 所需的 SharedWorker。");
}

function validateWisp(value) {
    const url = new URL(String(value || "").trim());
    if (!/^wss?:$/.test(url.protocol)) throw new Error("Wisp 位址必須使用 ws:// 或 wss://。");
    if (location.protocol === "https:" && url.protocol !== "wss:") {
        throw new Error("HTTPS 網站只能使用 wss:// Wisp。");
    }
    return url.href;
}

function loadRuntimeScript() {
    if (typeof window.$scramjetLoadController === "function") return Promise.resolve();
    if (runtimeScriptPromise) return runtimeScriptPromise;
    runtimeScriptPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-owo-scramjet-runtime="true"]');
        const script = existing || document.createElement("script");
        const finish = () => {
            if (typeof window.$scramjetLoadController === "function") resolve();
            else {
                runtimeScriptPromise = null;
                reject(new Error("Scramjet Runtime 已下載，但控制器介面未建立。請清除網站快取後重試。"));
            }
        };
        const fail = () => {
            runtimeScriptPromise = null;
            reject(new Error(`Scramjet Runtime 載入失敗：${FILES.scramjetAll}`));
        };
        script.addEventListener("load", finish, { once: true });
        script.addEventListener("error", fail, { once: true });
        if (!existing) {
            script.src = FILES.scramjetAll;
            script.async = true;
            script.dataset.owoScramjetRuntime = "true";
            document.head.appendChild(script);
        }
    });
    return runtimeScriptPromise;
}

async function ensureScramjetController() {
    if (controller) return controller;
    await loadRuntimeScript();
    const loader = window.$scramjetLoadController;
    if (typeof loader !== "function") throw new Error("Scramjet Runtime 控制器載入失敗。");
    const { ScramjetController } = loader();
    controller = new ScramjetController({
        prefix: `${ROOT_URL.pathname}scramjet/`,
        files: {
            wasm: new URL(FILES.scramjetWasm).pathname,
            all: new URL(FILES.scramjetAll).pathname,
            sync: new URL(FILES.scramjetSync).pathname,
        },
        flags: {
            serviceworkers: false,
            syncxhr: false,
            strictRewrites: false,
            rewriterLogs: false,
            captureErrors: false,
            cleanErrors: false,
            scramitize: false,
            sourcemaps: false,
            destructureRewrites: false,
            interceptDownloads: false,
            allowInvalidJs: true,
            allowFailedIntercepts: true,
        },
        siteFlags: {
            "shop\.funbox\.com\.tw": {
                strictRewrites: false,
                captureErrors: false,
                scramitize: false,
                destructureRewrites: false,
                allowInvalidJs: true,
                allowFailedIntercepts: true,
            },
        },
    });
    await Promise.resolve(controller.init());
    return controller;
}

async function ensureServiceWorker() {
    const registration = await navigator.serviceWorker.register(FILES.serviceWorker, {
        scope: ROOT_URL.pathname,
        updateViaCache: "none",
    });
    await registration.update();
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }
    return registration;
}

async function ensureTransport(wisp) {
    if (initializedWisp === wisp && connection) return;
    if (transportReady) return transportReady;

    transportReady = (async () => {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                if (!connection) connection = new BareMuxConnection(FILES.bareMuxWorker);
                await connection.setTransport(FILES.libcurlTransport, [{ websocket: wisp }]);
                const transportName = await connection.getTransport();
                if (!transportName) throw new Error("BareMux Transport 未回傳名稱。");
                await new Promise((resolve) => setTimeout(resolve, 250));
                const confirmedName = await connection.getTransport();
                if (!confirmedName) throw new Error("BareMux Transport 健康檢查失敗。");
                initializedWisp = wisp;
                return;
            } catch (error) {
                lastError = error;
                connection = null;
                initializedWisp = "";
                if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
            }
        }
        throw new Error(`BareMux 初始化失敗：${lastError instanceof Error ? lastError.message : String(lastError)}`);
    })().finally(() => {
        transportReady = null;
    });

    return transportReady;
}

async function initializeRuntime(wispValue) {
    const wisp = validateWisp(wispValue);
    if (!initialization) {
        initialization = (async () => {
            ensureSecureContext();
            await ensureTransport(wisp);
            await ensureScramjetController();
            await ensureServiceWorker();
        })().catch((error) => {
            initialization = null;
            throw error;
        });
    }
    await initialization;
    await ensureTransport(wisp);
    return controller;
}

function installLoginSubmitFallback(frameElement) {
    const frameWindow = frameElement?.contentWindow;
    const frameDocument = frameElement?.contentDocument;
    if (!frameWindow || !frameDocument) return false;
    if (frameDocument.__owoLoginFallbackInstalled) return true;

    const findLoginForm = () => frameDocument.querySelector(
        'form#customer_login[method="post"], form#customer_login[method="POST"]'
    );

    const attachToLoginForm = () => {
        const form = findLoginForm();
        if (!form) return false;
        if (frameDocument.__owoLoginFallbackInstalled) return true;

        Object.defineProperty(frameDocument, "__owoLoginFallbackInstalled", {
            value: true,
            configurable: true,
        });

        let fallbackTimer = 0;

        const lockAndSubmit = () => {
            if (form.dataset.owoSubmitting === "true") return;
            if (!form.checkValidity()) {
                form.reportValidity();
                return;
            }

            form.dataset.owoSubmitting = "true";
            frameWindow.clearTimeout(fallbackTimer);

            const button = form.querySelector('button[type="submit"], input[type="submit"]');
            if (button) button.disabled = true;

            console.info("[OwO] 登入表單已交由原生 POST 提交。");
            frameWindow.HTMLFormElement.prototype.submit.call(form);
        };

        const scheduleFallback = (reason) => {
            frameWindow.clearTimeout(fallbackTimer);
            fallbackTimer = frameWindow.setTimeout(() => {
                if (!frameDocument.contains(form)) return;
                if (form.dataset.owoSubmitting === "true") return;
                console.warn(`[OwO] ${reason}，執行原生登入 POST 保底。`);
                lockAndSubmit();
            }, 350);
        };

        form.addEventListener("submit", () => {
            if (form.dataset.owoSubmitting === "true") return;
            scheduleFallback("網站 Submit 未產生導覽");
        }, true);

        form.addEventListener("click", (event) => {
            const button = event.target?.closest?.('button[type="submit"], input[type="submit"]');
            if (!button || button.form !== form) return;
            if (form.dataset.owoSubmitting === "true") return;
            scheduleFallback("登入按鈕未產生導覽");
        }, true);

        console.info("[OwO] 已啟用登入提交保底 v2.4.5。");
        return true;
    };

    if (attachToLoginForm()) return true;

    const observer = new frameWindow.MutationObserver(() => {
        if (!attachToLoginForm()) return;
        observer.disconnect();
    });

    const observeTarget = frameDocument.documentElement || frameDocument;
    observer.observe(observeTarget, { childList: true, subtree: true });

    frameWindow.setTimeout(() => {
        observer.disconnect();
        if (!frameDocument.__owoLoginFallbackInstalled) {
            console.info("[OwO] 此頁未偵測到登入表單，不啟用提交保底。");
        }
    }, 10000);

    return false;
}

function bindFrame(frameElement, activeController, onUrlChange) {
    if (activeFrameElement !== frameElement || !activeScramjetFrame) {
        activeFrameElement = frameElement;
        activeScramjetFrame = activeController.createFrame(frameElement);
        activeUrlListener = null;
        frameElement.addEventListener("load", () => {
            try { installLoginSubmitFallback(frameElement); }
            catch (error) { console.warn("[OwO] 登入提交保底初始化失敗。", error); }
        });
    }
    if (onUrlChange && activeUrlListener !== onUrlChange) {
        activeUrlListener = onUrlChange;
        activeScramjetFrame.addEventListener("urlchange", (event) => {
            const url = event?.url || activeScramjetFrame?.url?.href;
            if (url) activeUrlListener(url);
            setTimeout(() => {
                try { installLoginSubmitFallback(frameElement); }
                catch (error) { console.warn("[OwO] 登入提交保底重新掛載失敗。", error); }
            }, 0);
        });
    }
    return activeScramjetFrame;
}

window.owoScramjetAdapter = Object.freeze({
    async launch({ target, wisp, frame, onUrlChange }) {
        const targetUrl = new URL(target).href;
        const activeController = await initializeRuntime(wisp);
        const proxyFrame = bindFrame(frame, activeController, onUrlChange);
        proxyFrame.go(targetUrl);
    },
    async reload() {
        if (!activeScramjetFrame) return false;
        activeScramjetFrame.reload();
        return true;
    },
    async back() {
        if (!activeScramjetFrame) return false;
        activeScramjetFrame.back();
        return true;
    },
    async forward() {
        if (!activeScramjetFrame) return false;
        activeScramjetFrame.forward();
        return true;
    },
    getCurrentUrl() {
        try { return activeScramjetFrame?.url?.href || ""; } catch { return ""; }
    },
    async reset() {
        initializedWisp = "";
        transportReady = null;
        connection = null;
        activeFrameElement = null;
        activeScramjetFrame = null;
        activeUrlListener = null;
    },
    files: FILES,
});
