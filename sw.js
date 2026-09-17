"use strict";

// OwO Web: generic failed-background-request degradation.
// Core navigation, authentication, form, API, upload and download requests always retain real failures.

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
]);

const DISPLAY_DESTINATIONS = new Set([
    "image", "font", "audio", "video", "track",
]);

const ESSENTIAL_TERMS = [
    "login", "logout", "signin", "signout", "session", "account",
    "profile", "auth", "oauth", "token", "csrf", "xsrf", "verify",
    "challenge", "captcha", "submit", "checkout", "payment", "purchase",
    "order", "cart", "upload", "download", "message", "comment", "save",
    "create", "update", "delete", "graphql", "rpc", "webhook",
];

const BACKGROUND_TERMS = [
    "analytics", "telemetry", "metric", "metrics", "beacon", "collect",
    "tracking", "track-event", "track_event", "event", "events", "stat",
    "stats", "statistics", "insight", "insights", "performance", "perf",
    "exposure", "impression", "conversion", "diagnostic", "diagnostics",
    "rum", "pageview", "page-view", "page_view", "view-event", "heartbeat",
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

function containsTerm(value, terms) {
    const normalized = String(value || "").toLowerCase();
    return terms.some((term) => normalized.includes(term));
}

function isNavigationOrCore(request) {
    return request.mode === "navigate" || CORE_DESTINATIONS.has(request.destination);
}

function isDisplayResource(request) {
    return DISPLAY_DESTINATIONS.has(request.destination);
}

function isSafeBackgroundFailure(request, target) {
    if (!target || isNavigationOrCore(request) || isDisplayResource(request)) return false;
    if (request.destination !== "") return false;
    if (request.method === "GET" || request.method === "HEAD") return false;

    const semanticText = `${target.pathname} ${target.search}`.toLowerCase();
    if (containsTerm(semanticText, ESSENTIAL_TERMS)) return false;

    // Strong browser signal first; semantic matching covers XHR-based background reports.
    return request.keepalive === true || containsTerm(semanticText, BACKGROUND_TERMS);
}

function softFailureResponse() {
    return new Response(null, {
        status: 204,
        statusText: "No Content",
        headers: {
            "Cache-Control": "no-store",
            "X-OwO-Background-Degraded": "1",
        },
    });
}

async function proxyFetchWithGenericFallback(event) {
    const request = event.request;
    const target = originalTarget(request.url);

    try {
        return await scramjet.fetch(event);
    } catch (error) {
        if (isSafeBackgroundFailure(request, target)) {
            if (globalThis.__owoLoginDiagnosticLogEnabled) {
                console.info("[OwOb] Background request degraded after transport failure", {
                    method: request.method,
                    destination: request.destination,
                    target: target?.href || request.url,
                    error: String(error?.message || error),
                });
            }
            return softFailureResponse();
        }
        throw error;
    }
}

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        await scramjet.loadConfig();
        if (scramjet.route(event)) {
            return proxyFetchWithGenericFallback(event);
        }
        return fetch(event.request);
    })());
});
