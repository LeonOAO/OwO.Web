import { BareMuxConnection } from "../BareMux/index.mjs";

const ROOT_URL = new URL("../", import.meta.url);
const FILES = Object.freeze({
    serviceWorker: new URL("sw.js", ROOT_URL).href,
    scramjetAll: new URL("Scramjet/scramjet.all.js", ROOT_URL).href,
    scramjetWasm: new URL("Scramjet/scramjet.wasm.wasm", ROOT_URL).href,
    scramjetSync: new URL("Scramjet/scramjet.sync.js", ROOT_URL).href,
    bareMuxWorker: new URL("BareMux/worker.js", ROOT_URL).href,
    libcurlTransport: new URL("Transport/index.mjs", ROOT_URL).href,
});

let controller = null;
let connection = null;
let initializedWisp = "";
let initialization = null;
let runtimeScriptPromise = null;

function ensureSecureContext() {
    if (!window.isSecureContext && location.hostname !== "localhost") {
        throw new Error("Scramjet 需要 HTTPS 或 localhost，無法從 file:// 直接啟動。");
    }
    if (!("serviceWorker" in navigator)) {
        throw new Error("目前瀏覽器不支援 Service Worker。");
    }
    if (!("SharedWorker" in window)) {
        throw new Error("目前瀏覽器不支援 Bare-Mux 所需的 SharedWorker。");
    }
}

function validateWisp(value) {
    const url = new URL(String(value || "").trim());
    if (!/^wss?:$/.test(url.protocol)) {
        throw new Error("Wisp 位址必須使用 ws:// 或 wss://。");
    }
    if (location.protocol === "https:" && url.protocol !== "wss:") {
        throw new Error("HTTPS 網站只能使用 wss:// Wisp。");
    }
    return url.href;
}

function loadRuntimeScript() {
    if (typeof window.$scramjetLoadController === "function") {
        return Promise.resolve();
    }
    if (runtimeScriptPromise) return runtimeScriptPromise;

    runtimeScriptPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-owo-scramjet-runtime="true"]');
        const script = existing || document.createElement("script");

        const finish = () => {
            if (typeof window.$scramjetLoadController === "function") {
                resolve();
            } else {
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
    if (typeof loader !== "function") {
        throw new Error("Scramjet Runtime 控制器載入失敗。");
    }

    const { ScramjetController } = loader();
    controller = new ScramjetController({
        prefix: `${ROOT_URL.pathname}scramjet/`,
        files: {
            // Scramjet v1 stores these values in IndexedDB and compares them
            // as same-origin pathnames inside its Service Worker.
            wasm: new URL(FILES.scramjetWasm).pathname,
            all: new URL(FILES.scramjetAll).pathname,
            sync: new URL(FILES.scramjetSync).pathname,
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
    await navigator.serviceWorker.ready;
    return registration;
}

async function ensureTransport(wisp) {
    if (!connection) {
        connection = new BareMuxConnection(FILES.bareMuxWorker);
    }
    if (initializedWisp !== wisp) {
        await connection.setTransport(FILES.libcurlTransport, [{ websocket: wisp }]);
        initializedWisp = wisp;
    }
}

async function initializeRuntime(wispValue) {
    const wisp = validateWisp(wispValue);

    if (!initialization) {
        initialization = (async () => {
            ensureSecureContext();

            // Bare-Mux must be ready before Scramjet's Service Worker starts.
            // Otherwise the worker repeatedly waits for a SharedWorker MessagePort.
            await ensureTransport(wisp);
            await ensureScramjetController();
            await ensureServiceWorker();
        })().catch((error) => {
            initialization = null;
            throw error;
        });
    }

    await initialization;

    // Reapply the transport only when the user changes the Wisp URL.
    await ensureTransport(wisp);
    return controller;
}

window.owoScramjetAdapter = Object.freeze({
    async getUrl({ target, wisp }) {
        const targetUrl = new URL(target).href;
        const activeController = await initializeRuntime(wisp);
        return activeController.encodeUrl(targetUrl);
    },

    async reset() {
        initializedWisp = "";
        connection = null;
    },

    files: FILES,
});
