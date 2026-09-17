"use strict";

// OwO Web: conservative generic background-failure handling.
// Authentication, session, account, form, API mutation, upload and download
// traffic always follows the original Scramjet result and error behavior.

importScripts("./Scramjet/scramjet.all.js");

const { ScramjetServiceWorker } = self.$scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

globalThis.__owoLoginDiagnosticLogEnabled = false;

self.addEventListener("message", (event) => {
    if (event?.data?.type !== "OWOB_LOGIN_DIAGNOSTIC_LOG") return;
    globalThis.__owoLoginDiagnosticLogEnabled =
        String(event.data.value || "").trim().toUpperCase() === "ON";
});

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

const CORE_DESTINATIONS = new Set([
    "document", "iframe", "frame", "script", "style", "worker",
    "sharedworker", "serviceworker", "object", "embed", "manifest",
    "image", "font", "audio", "video", "track",
]);

const LOGIN_AND_STATE_TERMS = [
    "login", "logout", "signin", "signout", "log-in", "log-out",
    "session", "account", "profile", "identity", "credential", "password",
    "passwd", "auth", "oauth", "sso", "saml", "token", "refresh-token",
    "refresh_token", "csrf", "xsrf", "verify", "verification", "challenge",
    "captcha", "mfa", "2fa", "otp", "callback", "consent",
];

const HIGH_RISK_ACTION_TERMS = [
    "submit", "save", "create", "update", "delete", "remove", "edit",
    "send", "message", "comment", "reply", "publish", "follow", "like",
    "vote", "subscribe", "unsubscribe", "checkout", "payment", "purchase",
    "order", "cart", "upload", "attachment", "graphql", "mutation", "rpc",
    "webhook",
];

const LOW_RISK_ACTION_TERMS = [
    "download",
];

const STRONG_BACKGROUND_TERMS = [
    "analytics", "telemetry", "beacon", "collect", "tracking", "track-event",
    "track_event", "metrics", "statistics", "insights", "performance",
    "pageview", "page-view", "page_view", "impression", "exposure",
    "conversion", "diagnostic", "rum", "heartbeat", "event-log",
    "event_log", "client-event", "client_event",
];

function decodeProxyTarget(value) {
    let decoded = String(value || "");
    for (let pass = 0; pass < 3; pass += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    return decoded;
}

function originalTarget(requestUrl) {
    try {
        const parsedRequest = new URL(requestUrl);
        const marker = "/scramjet/";
        const index = parsedRequest.pathname.indexOf(marker);
        if (index < 0) return null;

        const encodedPath = parsedRequest.pathname.slice(index + marker.length);
        const decodedPath = decodeProxyTarget(encodedPath);
        const candidate = `${decodedPath}${parsedRequest.search}${parsedRequest.hash}`;
        return new URL(candidate);
    } catch {
        return null;
    }
}

function containsAny(value, terms) {
    const normalized = String(value || "").toLowerCase();
    return terms.some((term) => normalized.includes(term));
}

function requestDescription(request, target) {
    const contentType = request.headers.get("content-type") || "";
    const accept = request.headers.get("accept") || "";
    return `${target?.pathname || ""} ${target?.search || ""} ${contentType} ${accept}`.toLowerCase();
}

function isStructurallyProtectedRequest(request, target) {
    if (!target) return true;
    if (request.mode === "navigate") return true;
    if (request.destination === "document" || request.destination === "iframe") return true;
    return false;
}

function requestStructure(request, target) {
    const path = String(target?.pathname || "").toLowerCase();
    const queryNames = new Set();
    const queryText = [];
    for (const [name, value] of target?.searchParams || []) {
        queryNames.add(String(name).toLowerCase());
        queryText.push(`${String(name).toLowerCase()}=${String(value).toLowerCase()}`);
    }
    return {
        path,
        queryNames,
        queryText: queryText.join("&"),
        contentType: (request.headers.get("content-type") || "").toLowerCase(),
        accept: (request.headers.get("accept") || "").toLowerCase(),
    };
}

function isProtectedAuthenticationRequest(request, target) {
    if (isStructurallyProtectedRequest(request, target)) return true;
    const { path, contentType } = requestStructure(request, target);
    const pathHasState = containsAny(path, LOGIN_AND_STATE_TERMS);
    const formPost = request.method === "POST" &&
        /application\/x-www-form-urlencoded|multipart\/form-data/i.test(contentType);
    const hasAuthHeader = request.headers.has("authorization") ||
        request.headers.has("x-csrf-token") || request.headers.has("x-xsrf-token");
    return hasAuthHeader || (pathHasState && formPost);
}

function isExplicitBackgroundRequest(request, target) {
    if (!target || isProtectedAuthenticationRequest(request, target)) return false;
    const { path, queryNames, queryText, contentType, accept } = requestStructure(request, target);
    const endpointText = `${path} ${contentType} ${accept}`;

    const collectionEndpoint = /(?:^|\/)(?:g\/collect|collect|beacon|telemetry|metrics|analytics|conversion|viewthroughconversion|tag\.gif)(?:\/|$)/i.test(path);
    const eventEndpoint = /\/(?:t|e)\/(?:ias|iaoi|page|event)[_-]/i.test(path);
    const eventName = ["en", "event", "event_name", "type"].some((name) => queryNames.has(name)) &&
        /(?:^|&)(?:en|event|event_name|type)=(?:page_view|scroll|user_engagement|form_start|form_submit|impression|conversion)(?:&|$)/i.test(queryText);
    const measurementParam = ["epn.percent_scrolled", "tfd", "tid", "gtm", "experiment", "time_since_page_load", "initial_state", "tab_position"].some((name) => queryNames.has(name));
    const strongEndpoint = containsAny(endpointText, STRONG_BACKGROUND_TERMS);

    if (collectionEndpoint || eventEndpoint) return true;
    if (eventName && measurementParam) return true;
    if (strongEndpoint && (request.destination === "" || request.destination === "image")) return true;

    const shortEndpoint = /^\/(?:e|t|b|c|s|v|p)(?:\/|$)/i.test(path);
    return request.keepalive === true && shortEndpoint;
}

function transparentPixelResponse() {
    const bytes = Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
    return new Response(bytes, { status: 200, headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "no-store",
        "X-OwO-Background-Degraded": "pixel",
    }});
}

function backgroundResponseFor(request) {
    if (request.destination === "image") return transparentPixelResponse();
    return backgroundSuccessResponse();
}

function isOptionalBackgroundScript(request, target) {
    if (!target || request.destination !== "script" || request.method !== "GET") return false;
    const text = requestDescription(request, target);
    const security = ["challenge", "captcha", "verify", "security", "auth", "oauth", "sso", "saml", "login", "signin", "session", "token", "csrf", "xsrf", "credential", "identity", "consent", "callback", "cdn-cgi"];
    const optional = ["analytics", "telemetry", "beacon", "metrics", "statistics", "insights", "performance", "rum", "tracking", "tag-manager", "tagmanager"];
    if (containsAny(text, security) || containsAny(text, LOGIN_AND_STATE_TERMS)) return false;
    return containsAny(text, optional);
}

function emptyJavaScriptResponse() {
    return new Response("", { status: 200, headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-OwO-Background-Degraded": "script",
    }});
}

function backgroundSuccessResponse() {
    return new Response(null, {
        status: 204,
        statusText: "No Content",
        headers: {
            "Cache-Control": "no-store",
            "X-OwO-Background-Degraded": "1",
        },
    });
}

function logBackgroundDegradation(stage, request, target, detail) {
    if (!globalThis.__owoLoginDiagnosticLogEnabled) return;
    console.info("[OwOb] Optional background request degraded", {
        stage,
        method: request.method,
        destination: request.destination,
        keepalive: request.keepalive,
        target: target?.href || request.url,
        detail,
    });
}

function challengeResourceKind(request, target) {
    if (request.method !== "GET") return "";

    const accept = String(request.headers.get("accept") || "").toLowerCase();
    const destination = String(request.destination || "").toLowerCase();
    const values = [target?.pathname || "", target?.href || "", request.url || ""]
        .map(decodeProxyTarget);
    const challengePath = values.find((value) =>
        /\/cdn-cgi\/challenge-platform\//i.test(value)
    ) || "";

    if (!challengePath) return "";

    const javascriptResource =
        destination === "script" ||
        /javascript|ecmascript/.test(accept) ||
        /\/(?:scripts\/)?jsd\/[^?#]+(?:\.js)?(?:[?#]|$)/i.test(challengePath);

    return javascriptResource ? "javascript" : "";
}

function isGeneratedChallengeScript(request, target) {
    return challengeResourceKind(request, target) === "javascript";
}

function optionalUiModuleKind(request, target) {
    if (String(request.method || "").toUpperCase() !== "GET") return "";

    const host = String(target?.hostname || "").toLowerCase();
    const path = String(target?.pathname || "");

    // Current Cyberbiz chat-box bootstrap. Stopping the optional bootstrap is
    // safer than changing its verification API responses after initialization.
    if (
        host === "cdn.cybassets.com" &&
        /\/appmarket\/api\/common\/attachments\/entrypoint\/8766542902afa60f4adda3c555c06025d2c27771ea85a6fc657a91cddbe5c59f\.js$/i.test(path)
    ) {
        return "javascript";
    }

    // Fallback for the chat module if a page already contains its direct asset.
    if (host === "message-widget.cyberbiz.io" && /\/assets\/index-[^/]+\.js$/i.test(path)) {
        return "javascript";
    }

    // Optional customer-chat and analytics scripts known to fail in Transport.
    if (host === "connect.facebook.net" && /\/sdk\/xfbml\.customerchat\.js$/i.test(path)) {
        return "javascript";
    }
    if (host === "www.clarity.ms" && /^\/tag\//i.test(path)) {
        return "javascript";
    }

    return "";
}

function emptyOptionalUiModuleResponse() {
    return new Response("", {
        status: 200,
        headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            "X-OwO-Optional-Ui-Disabled": "1",
        },
    });
}

function isRawMissingChallengeScriptRequest(request) {
    if (String(request.method || "").toUpperCase() !== "GET") return false;

    const rawUrl = String(request.url || "");
    const decodedUrl = decodeProxyTarget(rawUrl);
    return [rawUrl, decodedUrl].some((value) =>
        /(?:%2f|\/)cdn-cgi(?:%2f|\/)challenge-platform(?:%2f|\/)scripts(?:%2f|\/)jsd(?:%2f|\/)main\.js(?:[?#]|$)/i.test(value)
    );
}

async function publishServiceDiagnostic(message, metadata = {}) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
        client.postMessage({
            type: "OWOB_SERVICE_DIAGNOSTIC",
            message: String(message || "Proxy service diagnostic"),
            metadata,
        });
    }
}

async function handleScramjetRequest(event) {
    const request = event.request;
    const target = originalTarget(request.url);
    const backgroundScript = isOptionalBackgroundScript(request, target);
    const background = isExplicitBackgroundRequest(request, target);
    const optionalUiModule = optionalUiModuleKind(request, target);

    if (optionalUiModule === "javascript") {
        event.waitUntil(publishServiceDiagnostic(
            `Optional UI module disabled: ${target?.hostname || "third-party"}`,
            {
                service: target?.hostname || "third-party",
                targetPath: target?.pathname || "",
                status: 200,
                method: request.method,
                destination: request.destination || "script",
                disabled: true,
            }
        ));
        return emptyOptionalUiModuleResponse();
    }

    if (isGeneratedChallengeScript(request, target)) return emptyJavaScriptResponse();

    if (backgroundScript) {
        logBackgroundDegradation("before-transport-script", request, target, "classified optional script");
        return emptyJavaScriptResponse();
    }

    // Strongly identified background reports are stopped before Transport so a
    // failed TLS handshake cannot create repeated Runtime and HTTP 500 messages.
    if (background) {
        logBackgroundDegradation("before-transport", request, target, "classified background request");
        return backgroundResponseFor(request);
    }

    try {
        const response = await scramjet.fetch(event);

        if (response.status >= 400) {
            const targetText = target?.href || request.url;
            const optionalService = /connect\.facebook\.net|message\.cyberbiz\.io|clarity\.ms/i.test(targetText);
            if (optionalService) {
                let service = "third-party";
                let targetPath = "";
                try {
                    const parsedTarget = new URL(targetText);
                    service = parsedTarget.hostname;
                    targetPath = parsedTarget.pathname;
                } catch (_) {}
                event.waitUntil(publishServiceDiagnostic(
                    `${service} returned HTTP ${response.status}`,
                    {
                        service,
                        targetPath,
                        status: response.status,
                        method: request.method,
                        destination: request.destination || "unknown",
                    }
                ));
            }
        }

        // A challenge script keeps its real request, redirects and cookies. Only
        // a final 404 is converted to valid empty JavaScript to avoid page noise.
        if (
            response.status === 404 &&
            (() => {
                const values = [target?.pathname || "", target?.href || "", request.url || "", response.url || ""];
                for (const value of [...values]) {
                    try { values.push(decodeURIComponent(value)); } catch (_) {}
                }
                return challengeResourceKind(request, target) === "javascript" ||
                    values.some((value) => /\/cdn-cgi\/challenge-platform\/(?:scripts\/)?jsd\//i.test(decodeProxyTarget(value)));
            })()
        ) {
            return emptyJavaScriptResponse();
        }

        // Missing cross-origin favicons are optional display resources. Return
        // an empty image response so a 404 does not become a page-level error.
        if (
            response.status === 404 &&
            request.destination === "image" &&
            /\.(?:ico|png|gif|jpe?g|webp)(?:$|[?#])/i.test(target?.href || "")
        ) {
            return new Response(null, {
                status: 204,
                headers: {
                    "Cache-Control": "public, max-age=300",
                    "X-OwO-Optional-Image-Degraded": "1",
                },
            });
        }

        return response;
    } catch (error) {
        // Every request reaching Transport is protected or unclassified, so its
        // original exception is preserved for authentication and application logic.
        throw error;
    }
}

function quietDirectFetchFailure(request) {
    if (request.destination === "image") return transparentPixelResponse();
    if (request.destination === "script") return emptyJavaScriptResponse();
    return new Response("", {
        status: 503,
        statusText: "Service Unavailable",
        headers: {
            "Cache-Control": "no-store",
            "X-OwO-Direct-Fetch-Degraded": "1",
        },
    });
}

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        try {
            // This exact generated JSD URL is known to return 404 after rewrite.
            // Handle it before config loading and routing because dynamically
            // injected PendingScript requests may expose an empty destination.
            if (isRawMissingChallengeScriptRequest(event.request)) {
                return emptyJavaScriptResponse();
            }

            await scramjet.loadConfig();
            if (scramjet.route(event)) {
                return await handleScramjetRequest(event);
            }
            try {
                return await fetch(event.request);
            } catch (_) {
                return quietDirectFetchFailure(event.request);
            }
        } catch (error) {
            // Authentication and navigation failures retain an explicit HTTP
            // result, while optional resource failures use type-correct output.
            if (event.request.mode === "navigate" || event.request.destination === "document") {
                return new Response("Proxy request failed", {
                    status: 502,
                    statusText: "Bad Gateway",
                    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
                });
            }
            return quietDirectFetchFailure(event.request);
        }
    })());
});
