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

async function ensureScramjetController() {
    if (controller) return controller;
    if (typeof window.$scramjetLoadController !== "function") {
        throw new Error("Scramjet Runtime 未載入，請確認 Scramjet/scramjet.all.js 存在。");
    }

    const { ScramjetController } = window.$scramjetLoadController();
    controller = new ScramjetController({
        files: {
            wasm: FILES.scramjetWasm,
            all: FILES.scramjetAll,
            sync: FILES.scramjetSync,
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
