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

const USER_ACTION_TERMS = [
    "submit", "save", "create", "update", "delete", "remove", "edit",
    "send", "message", "comment", "reply", "post", "publish", "follow",
    "like", "vote", "subscribe", "unsubscribe", "checkout", "payment",
    "purchase", "order", "cart", "upload", "download", "attachment",
    "graphql", "mutation", "rpc", "webhook",
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

function isProtectedRequest(request, target) {
    if (!target) return true;
    if (request.mode === "navigate") return true;
    if (CORE_DESTINATIONS.has(request.destination)) return true;
    if (request.method === "GET" || request.method === "HEAD") return true;

    const description = requestDescription(request, target);
    return containsAny(description, LOGIN_AND_STATE_TERMS) ||
        containsAny(description, USER_ACTION_TERMS);
}

function isExplicitBackgroundRequest(request, target) {
    if (isProtectedRequest(request, target)) return false;
    if (request.destination !== "") return false;

    const description = requestDescription(request, target);
    if (containsAny(description, STRONG_BACKGROUND_TERMS)) return true;

    // sendBeacon and fetch keepalive provide a browser-level background signal.
    // A short endpoint is accepted only with this signal, never from its path alone.
    const shortEndpoint = /^\/(?:e|t|b|c|s|v|p)(?:\/|$)/i.test(target.pathname);
    return request.keepalive === true && shortEndpoint;
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

async function handleScramjetRequest(event) {
    const request = event.request;
    const target = originalTarget(request.url);
    const background = isExplicitBackgroundRequest(request, target);

    // Strongly identified background reports are stopped before Transport so a
    // failed TLS handshake cannot create repeated Runtime and HTTP 500 messages.
    if (background) {
        logBackgroundDegradation("before-transport", request, target, "classified background request");
        return backgroundSuccessResponse();
    }

    try {
        const response = await scramjet.fetch(event);

        // This branch handles transports that convert an exception to an HTTP 5xx.
        // Protected requests never enter this branch because background is false.
        if (background && response.status >= 500) {
            logBackgroundDegradation("after-response", request, target, `HTTP ${response.status}`);
            return backgroundSuccessResponse();
        }

        return response;
    } catch (error) {
        // Preserve the original exception for every non-background request,
        // including all authentication and state-changing operations.
        if (!background) throw error;

        logBackgroundDegradation(
            "after-exception",
            request,
            target,
            String(error?.message || error)
        );
        return backgroundSuccessResponse();
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
