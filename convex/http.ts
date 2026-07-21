import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

function getAllowedOrigin(request: Request): string | null {
    const origin = request.headers.get("Origin");
    const configuredOrigins = (process.env.ALLOWED_WEB_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (configuredOrigins.length === 0) return "*";
    if (!origin) return configuredOrigins[0] ?? null;
    return configuredOrigins.includes(origin) ? origin : null;
}

function corsHeaders(allowedOrigin: string): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
        "Vary": "Origin",
    };
}

function bytesToBase64(bytes: Uint8Array): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index];
        const second = bytes[index + 1];
        const third = bytes[index + 2];
        const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
        output += alphabet[(value >> 18) & 63];
        output += alphabet[(value >> 12) & 63];
        output += second === undefined ? "=" : alphabet[(value >> 6) & 63];
        output += third === undefined ? "=" : alphabet[value & 63];
    }
    return output;
}

/**
 * CORS preflight handler for /ably/token
 */
http.route({
    path: "/ably/token",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => {
        const allowedOrigin = getAllowedOrigin(request);
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, {
            status: 204,
            headers: corsHeaders(allowedOrigin),
        });
    }),
});

/**
 * Ably token endpoint for dashboard authentication
 * This allows the dashboard to get Ably tokens securely
 * 
 * Note: You'll need to set ABLY_API_KEY in Convex environment variables
 */
http.route({
    path: "/ably/token",
    method: "GET",
    handler: httpAction(async (_ctx, request) => {
        const allowedOrigin = getAllowedOrigin(request);
        if (!allowedOrigin) {
            return new Response(JSON.stringify({ error: "Origin not allowed" }), {
                status: 403,
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            });
        }
        const responseHeaders = corsHeaders(allowedOrigin);
        const ablyApiKey = process.env.ABLY_API_KEY;

        if (!ablyApiKey) {
            console.error("ABLY_API_KEY not configured in Convex environment variables");
            return new Response(
                JSON.stringify({ 
                    error: "Ably API key not configured",
                    help: "Set ABLY_API_KEY in Convex dashboard under Settings > Environment Variables"
                }),
                {
                    status: 500,
                    headers: { 
                        "Content-Type": "application/json",
                        ...responseHeaders
                    }
                }
            );
        }

        try {
            // Create a token request using Ably REST API
            const [keyName, keySecret] = ablyApiKey.split(":");
            
            if (!keyName || !keySecret) {
                throw new Error("Invalid ABLY_API_KEY format. Expected 'keyName:keySecret'");
            }

            const timestamp = Date.now();
            const ttl = 3600000; // 1 hour
            const nonce = globalThis.crypto.randomUUID();

            // Get clientId from query params if provided
            const url = new URL(request.url);
            const requestedClientId = url.searchParams.get("clientId") || "dashboard-web";
            const clientId = /^[A-Za-z0-9._-]{1,64}$/.test(requestedClientId)
                ? requestedClientId
                : "dashboard-web";
            const dashboardChannel = process.env.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";
            const esp32Channel = process.env.ESP32_ABLY_CHANNEL_NAME || "EcoTele";
            const capability = JSON.stringify({
                [dashboardChannel]: ["subscribe", "history"],
                [esp32Channel]: ["subscribe", "history"],
            });

            // For simple token requests, we can return basic token params
            // The client will use these to request a token from Ably
            const tokenParams = {
                keyName: keyName,
                timestamp: timestamp,
                ttl: ttl,
                capability,
                clientId: clientId,
                nonce,
            };

            // Sign the token request
            const signText = [
                keyName,
                ttl,
                capability,
                clientId,
                timestamp,
                nonce,
            ].join("\n");
            const signingKey = await globalThis.crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(keySecret),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign"],
            );
            const signature = await globalThis.crypto.subtle.sign(
                "HMAC",
                signingKey,
                new TextEncoder().encode(signText),
            );
            const mac = bytesToBase64(new Uint8Array(signature));

            const tokenRequest = {
                ...tokenParams,
                mac: mac,
            };

            return new Response(
                JSON.stringify(tokenRequest),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        ...responseHeaders
                    }
                }
            );
        } catch (error) {
            console.error("Ably token error:", error);
            return new Response(
                JSON.stringify({ error: "Failed to create Ably token request" }),
                {
                    status: 500,
                    headers: { 
                        "Content-Type": "application/json",
                        ...responseHeaders
                    }
                }
            );
        }
    }),
});

/**
 * CORS preflight handler for /health
 */
http.route({
    path: "/health",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => {
        const allowedOrigin = getAllowedOrigin(request);
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(null, {
            status: 204,
            headers: corsHeaders(allowedOrigin),
        });
    }),
});

/**
 * Health check endpoint
 */
http.route({
    path: "/health",
    method: "GET",
    handler: httpAction(async (_ctx, request) => {
        const allowedOrigin = getAllowedOrigin(request);
        if (!allowedOrigin) return new Response(null, { status: 403 });
        return new Response(
            JSON.stringify({ ok: true, time: new Date().toISOString() }),
            {
                status: 200,
                headers: { 
                    "Content-Type": "application/json",
                    ...corsHeaders(allowedOrigin)
                }
            }
        );
    }),
});

export default http;
