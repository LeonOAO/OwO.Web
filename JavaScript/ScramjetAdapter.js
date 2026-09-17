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

const OWOB_LOG_STORAGE_KEY = "owo.browser.loginDiagnosticLog";
const OWOB_LOG_MESSAGE_TYPE = "OWOB_LOGIN_DIAGNOSTIC_LOG";

let controller = null;
let connection = null;
let initializedWisp = "";
let initialization = null;
let runtimeScriptPromise = null;
let diagnosticLogState = readDiagnosticLogState();

function normalizeDiagnosticLogState(value) {
    return String(value || "").trim().toUpperCase() === "ON" ? "ON" : "OFF";
}

function readDiagnosticLogState() {
    try {
        return normalizeDiagnosticLogState(window.localStorage.getItem(OWOB_LOG_STORAGE_KEY) || "OFF");
    } catch (_) {
        return "OFF";
    }
}

function sendDiagnosticLogState(worker) {
    const target = worker || navigator.serviceWorker.controller;
    if (!target) return false;

    target.postMessage({
        type: OWOB_LOG_MESSAGE_TYPE,
        value: diagnosticLogState,
    });
    return true;
}

function publishDiagnosticLogState(registration) {
    sendDiagnosticLogState(registration?.active);
    sendDiagnosticLogState(registration?.waiting);
    sendDiagnosticLogState(registration?.installing);
    sendDiagnosticLogState();
}

function setDiagnosticLogState(value) {
    diagnosticLogState = normalizeDiagnosticLogState(value);

    try {
        window.localStorage.setItem(OWOB_LOG_STORAGE_KEY, diagnosticLogState);
    } catch (_) {}

    publishDiagnosticLogState();
    console.info(`[OwOb] Login diagnostic log: ${diagnosticLogState}`);
    if (diagnosticLogState === "OFF") printDiagnosticErrorTable("切換為計數模式");
    return diagnosticLogState;
}

function initializeDiagnosticLogControl() {
    const api = globalThis.OwOb && typeof globalThis.OwOb === "object"
        ? globalThis.OwOb
        : {};

    Object.defineProperty(api, "Log", {
        configurable: true,
        enumerable: true,
        get() {
            return diagnosticLogState;
        },
        set(value) {
            setDiagnosticLogState(value);
        },
    });

    globalThis.OwOb = api;

    const errorsApi = {};
    Object.defineProperties(errorsApi, {
        List: { enumerable: true, value: () => { printDiagnosticErrorTable(); return { ...diagnosticErrorCounts }; } },
        Clear: { enumerable: true, value: () => clearDiagnosticErrors(true) },
        Counts: { enumerable: true, get: () => ({ ...diagnosticErrorCounts }) },
    });
    Object.defineProperty(api, "Errors", { configurable: true, enumerable: true, value: errorsApi });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
        sendDiagnosticLogState();
    });

    console.info(`[OwOb] Login diagnostic log: ${diagnosticLogState}`);
    console.info(
        `[OwOb] 輸入 OwOb.Log = "${diagnosticLogState === "ON" ? "OFF" : "ON"}" ` +
        `${diagnosticLogState === "ON" ? "關閉" : "開啟"}登入診斷紀錄`
    );
}

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
    publishDiagnosticLogState(registration);
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


const OWOB_ERROR_CATEGORIES = Object.freeze({
    bareMuxInitialization: "Bare-Mux 初始化",
    serviceWorkerRuntime: "Service Worker 執行",
    transportTls: "Transport／TLS 連線",
    optionalNetwork: "選用服務網路",
    mainDocumentNetwork: "主文件網路",
    requiredApiNetwork: "必要 API 網路",
    loginSessionChain: "登入 Session 鏈",
    cookieCsrf: "Cookie／CSRF 配對",
    arrayCompatibility: "Array 相容性",
    selectorCompatibility: "Selector 相容性",
    readonlyArray: "唯讀陣列",
    iteratorCompatibility: "Iterator 相容性",
    touchEventCompatibility: "TouchEvent 相容性",
    urlRewriteCompatibility: "URL 重寫相容性",
    reactHydrationCompatibility: "React／Hydration 相容性",
    moduleLoadingCompatibility: "模組載入相容性",
    scriptLoading: "JavaScript 載入",
    resourceLoading: "靜態資源載入",
    widgetValidation: "聊天元件驗證",
    permissionSecurity: "權限／安全限制",
    unknown: "未分類錯誤",
});

const QUIET_TABLE_DELAY_MS = 8000;
const FIRST_NOTICE_LIMIT = 1;
let diagnosticErrorCounts = createDiagnosticErrorCounts();
let diagnosticErrorPageKey = "";
let diagnosticErrorPrintTimer = null;
let diagnosticErrorSignatures = new Map();
let diagnosticErrorsSinceLastSummary = 0;

function createDiagnosticErrorCounts() {
    return Object.fromEntries(Object.keys(OWOB_ERROR_CATEGORIES).map((key) => [key, 0]));
}

function normalizeDiagnosticText(value) {
    return String(value || "")
        .replace(/https?:\/\/[^\s)]+/gi, "<URL>")
        .replace(/:\d+:\d+/g, ":#:#")
        .replace(/\b\d{4,}\b/g, "#")
        .replace(/\s+/g, " ")
        .trim();
}

function classifyDiagnosticError(message, stack) {
    const text = `${message}\n${stack}`;
    const isScramjetNetworkFailure =
        /Request failed with error code|SSL connect error|ERROR FROM SERVICE WORKER FETCH/i.test(text) ||
        (/scramjet\.all\.js|Transport\/index\.mjs/i.test(text) && /fetch|network|request|HTTP 5\d\d|ERR_ABORTED/i.test(text)) ||
        (/net::ERR_ABORTED|Internal Server Error/i.test(text) && /scramjet|\/scramjet\//i.test(text));

    // Network stacks frequently contain framework, module and URL-rewrite frames.
    // Classify the transport cause before any framework compatibility heuristic.
    if (isScramjetNetworkFailure) {
        return /analytics|telemetry|beacon|metrics|performance|pageview|impression|exposure|conversion|diagnostic|heartbeat|event/i.test(text)
            ? "optionalNetwork"
            : "transportTls";
    }
    if (/invalid MessagePort|All clients returned an invalid MessagePort|bare-mux SharedWorker/i.test(text)) return "bareMuxInitialization";
    if (/ERROR FROM SERVICE WORKER|Service Worker.*(?:failed|error)|Failed to register.*Service Worker/i.test(text)) return "serviceWorkerRuntime";
    if (/error code 35|SSL connect error|TLS|certificate/i.test(text)) return /improving\.|analytics|telemetry|doubleclick|googletagmanager/i.test(text) ? "optionalNetwork" : "transportTls";
    if (/improving\.|analytics|telemetry|doubleclick|googletagmanager|webvitals|wide_event/i.test(text)) return "optionalNetwork";
    if (/login|session-chain|Session Lock|csrfMatches|sessionMatches/i.test(text) && /false|failed|mismatch|error/i.test(text)) return "loginSessionChain";
    if (/cookie|csrf|xsrf|authenticity/i.test(text) && /false|failed|mismatch|invalid/i.test(text)) return "cookieCsrf";
    if (/Array\.prototype\.|comparison function|Cannot convert undefined or null to object/i.test(text)) return "arrayCompatibility";
    if (/querySelector|querySelectorAll|matches.*valid selector|selector is empty/i.test(text)) return "selectorCompatibility";
    if (/read only property ['"]length|Cannot add property.*not extensible|Array\.push/i.test(text)) return "readonlyArray";
    if (/Constructor Iterator requires ['"]new|Iterator/i.test(text)) return "iteratorCompatibility";
    if (/TouchEvent|provided event type.*invalid/i.test(text)) return "touchEventCompatibility";
    if (/Failed to construct ['"]URL|Invalid URL|URL constructor/i.test(text)) return "urlRewriteCompatibility";
    if (/Minified React error|hydration|Hydration|ReactDOM/i.test(text)) return "reactHydrationCompatibility";
    if (/Cannot find module|ChunkLoadError|Loading chunk .* failed|dynamic import/i.test(text)) return "moduleLoadingCompatibility";
    if (/Failed to load script|script.*(?:failed|error)|SyntaxError.*module/i.test(text)) return "scriptLoading";
    if (/widget key|CHAT BOX|Unprocessable Content/i.test(text)) return "widgetValidation";
    if (/SecurityError|NotAllowedError|Permission denied|blocked by/i.test(text)) return "permissionSecurity";
    if (/Failed to load resource|HTTP [45]\d\d|status of [45]\d\d/i.test(text)) return "resourceLoading";
    return "unknown";
}

function diagnosticSignature(category, message, stack) {
    const firstUsefulFrame = String(stack || "").split("\n").find((line) => /\bat\b|https?:/i.test(line)) || "";
    return `${category}|${normalizeDiagnosticText(message)}|${normalizeDiagnosticText(firstUsefulFrame)}`;
}

function printDiagnosticErrorTable(reason = "目前頁面") {
    if (diagnosticErrorSignatures.size === 0) return;
    if (!Object.values(diagnosticErrorCounts).some((count) => count > 0)) return;
    console.groupCollapsed(`[OwOb Errors] 統計表｜${reason}`);
    for (const [key, label] of Object.entries(OWOB_ERROR_CATEGORIES)) {
        console.info(`${label}：${diagnosticErrorCounts[key]}`);
    }
    console.info(`錯誤簽章：${diagnosticErrorSignatures.size}`);
    console.groupEnd();
}

function scheduleDiagnosticErrorTable() {
    if (diagnosticLogState === "ON") return;
    if (diagnosticErrorPrintTimer) clearTimeout(diagnosticErrorPrintTimer);
    diagnosticErrorPrintTimer = window.setTimeout(() => {
        diagnosticErrorPrintTimer = null;
        if (diagnosticErrorsSinceLastSummary > 0) {
            printDiagnosticErrorTable("錯誤停止 8 秒後摘要");
            diagnosticErrorsSinceLastSummary = 0;
        }
    }, QUIET_TABLE_DELAY_MS);
}

function clearDiagnosticErrors(announce = true) {
    diagnosticErrorCounts = createDiagnosticErrorCounts();
    diagnosticErrorSignatures = new Map();
    diagnosticErrorsSinceLastSummary = 0;
    if (diagnosticErrorPrintTimer) {
        clearTimeout(diagnosticErrorPrintTimer);
        diagnosticErrorPrintTimer = null;
    }
    if (announce) console.info("[OwOb Errors] 統計表已清除");
    printDiagnosticErrorTable("新頁面重置");
    return { ...diagnosticErrorCounts };
}

function beginDiagnosticPage(url) {
    const nextKey = String(url || "");
    if (nextKey === diagnosticErrorPageKey) return;
    diagnosticErrorPageKey = nextKey;
    clearDiagnosticErrors(false);
}

function sanitizeDiagnosticText(value) {
    return String(value || "")
        .replace(/data:application\/javascript;base64,[A-Za-z0-9+/=]+/gi, "data:application/javascript;base64,[redacted]")
        .replace(/([?&](?:token|key|session|sid|auth|code|state|cookie|credential)=)[^&\s]*/gi, "$1[redacted]")
        .replace(/(Cookie\s*[:=]\s*)[^\n]*/gi, "$1[redacted]")
        .replace(/VM\d+/g, "VM")
        .replace(/:\d+:\d+/g, ":line:column");
}

function recordDiagnosticError(message, stack, metadata = {}) {
    // Compatibility telemetry is opt-in. When OFF it emits no classifications,
    // summaries or copies of rewritten URLs and cannot influence page behavior.
    if (diagnosticLogState !== "ON") return null;

    const cleanMessage = sanitizeDiagnosticText(message || "未知錯誤");
    const cleanStack = sanitizeDiagnosticText(stack || "");
    const safeMetadata = sanitizeDiagnosticText(JSON.stringify(metadata));
    const diagnosticText = `${cleanMessage}\n${cleanStack}\n${safeMetadata}`;

    // Runtime startup and rewrite advisory messages are informational. They do
    // not represent page compatibility failures and must not enter statistics.
    if (/bare-mux:|initializing scramjet client|Creating SingletonBox|last version of scramjet v1|extraneous query parameter|Assuming <form> element/i.test(diagnosticText) &&
        !/Request failed|SSL connect error|Internal Server Error|net::ERR_|Session lock is unavailable/i.test(diagnosticText)) {
        return null;
    }

    const category = classifyDiagnosticError(cleanMessage, diagnosticText);
    const signature = diagnosticSignature(category, cleanMessage, cleanStack);
    const priorOccurrence = diagnosticErrorSignatures.get(signature) || 0;
    const occurrence = priorOccurrence + 1;
    diagnosticErrorSignatures.set(signature, occurrence);

    // One root signature counts once even when console.error, error and
    // unhandledrejection report the same failure through separate channels.
    if (priorOccurrence > 0) return category;

    diagnosticErrorCounts[category] += 1;
    diagnosticErrorsSinceLastSummary += 1;

    if (diagnosticLogState === "ON") {
        console.warn(`[OwOb Errors] ${OWOB_ERROR_CATEGORIES[category]}｜第 ${occurrence} 次`, cleanMessage, cleanStack, safeMetadata);
    } else if (occurrence <= FIRST_NOTICE_LIMIT) {
        console.info(`[OwOb Errors] 新增類別：${OWOB_ERROR_CATEGORIES[category]}｜累計 ${diagnosticErrorCounts[category]} 筆`);
    }
    scheduleDiagnosticErrorTable();
    return category;
}

window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "OWOB_COMPATIBILITY_ERROR") return;
    recordDiagnosticError(data.message, data.stack, data.metadata || {});
});

window.addEventListener("error", (event) => {
    if (!event.error && !event.message) return;
    recordDiagnosticError(event.message, event.error?.stack || "", { source: event.filename || "window" });
});

window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    recordDiagnosticError(reason?.message || reason, reason?.stack || "", { source: "unhandledrejection" });
});

initializeDiagnosticLogControl();

window.owoScramjetAdapter = Object.freeze({
    async getUrl({ target, wisp }) {
        const targetUrl = new URL(target).href;
        beginDiagnosticPage(targetUrl);
        const activeController = await initializeRuntime(wisp);
        return activeController.encodeUrl(targetUrl);
    },

    async reset() {
        initializedWisp = "";
        connection = null;
    },

    files: FILES,
});
