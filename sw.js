"use strict";

// OwO Web: conservative generic background-failure handling.
// Authentication, session, account, form, API mutation, upload and download
// traffic always follows the original Scramjet result and error behavior.

importScripts("./Scramjet/scramjet.all.js?v=2.2.1");

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

function originalTarget(requestUrl) {
    try {
        const marker = "/scramjet/";
        const index = requestUrl.indexOf(marker);
        if (index < 0) return null;
        return new URL(decodeURIComponent(requestUrl.slice(index + marker.length)));
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

function isGeneratedChallengeScript(request, target) {
    if (request.method !== "GET") return false;
    const values = [target?.pathname || "", target?.href || "", request.url || ""];
    for (const value of [...values]) {
        try { values.push(decodeURIComponent(value)); } catch (_) {}
    }
    return values.some((value) => /\/cdn-cgi\/challenge-platform\/scripts\/jsd\/main\.js(?:[?#]|$)/i.test(value));
}

async function handleScramjetRequest(event) {
    const request = event.request;
    const target = originalTarget(request.url);
    const backgroundScript = isOptionalBackgroundScript(request, target);
    const background = isExplicitBackgroundRequest(request, target);

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

        // A challenge script keeps its real request, redirects and cookies. Only
        // a final 404 is converted to valid empty JavaScript to avoid page noise.
        if (
            response.status === 404 &&
            (() => {
                const values = [target?.pathname || "", target?.href || "", request.url || "", response.url || ""];
                for (const value of [...values]) {
                    try { values.push(decodeURIComponent(value)); } catch (_) {}
                }
                return values.some((value) => /\/cdn-cgi\/challenge-platform\//i.test(value));
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

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        await scramjet.loadConfig();
        if (scramjet.route(event)) {
            return handleScramjetRequest(event);
        }
        return fetch(event.request);
    })());
});
