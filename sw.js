"use strict";

// OwO Web 2.4.8: robust Scramjet frame navigation and login-session persistence.

importScripts("./Scramjet/scramjet.all.js");

const { ScramjetServiceWorker } = self.$scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});


const OPTIONAL_HOSTS = new Set([
    "www.google-analytics.com",
    "analytics.google.com",
    "stats.g.doubleclick.net",
    "googleads.g.doubleclick.net",
    "www.googleadservices.com",
    "www.clarity.ms",
    "connect.facebook.net",
    "tr.line.me",
]);

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

function emptyOptionalResponse(request) {
    const target = originalTarget(request.url);
    if (!target || !OPTIONAL_HOSTS.has(target.hostname)) return null;
    if (request.destination === "script") {
        return new Response("/* Optional telemetry disabled by OwO Web. */", {
            status: 200,
            headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
    }
    return new Response(null, { status: 204 });
}

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        const optionalResponse = emptyOptionalResponse(event.request);
        if (optionalResponse) return optionalResponse;
        await scramjet.loadConfig();
        if (scramjet.route(event)) {
            return scramjet.fetch(event);
        }
        return fetch(event.request);
    })());
});
