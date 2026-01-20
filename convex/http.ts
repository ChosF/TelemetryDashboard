import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

/**
 * Ably token endpoint for ESP32 authentication
 * This allows the ESP32 and Python bridge to get Ably tokens
 * 
 * Note: You'll need to set ABLY_API_KEY in Convex environment variables
 */
http.route({
    path: "/ably/token",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
        const ablyApiKey = process.env.ABLY_API_KEY;

        if (!ablyApiKey) {
            return new Response(
                JSON.stringify({ error: "Ably API key not configured" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" }
                }
            );
        }

        try {
            // Create a token request using Ably REST API
            const [keyName, keySecret] = ablyApiKey.split(":");
            const timestamp = Date.now();
            const ttl = 3600000; // 1 hour

            // For simple token requests, we can return basic token params
            // The client will use these to request a token from Ably
            const tokenParams = {
                keyName: keyName,
                timestamp: timestamp,
                ttl: ttl,
                capability: JSON.stringify({ "*": ["*"] }),
            };

            // Sign the token request
            const crypto = await import("crypto");
            const signText = [
                keyName,
                ttl,
                JSON.stringify({ "*": ["*"] }),
                "", // clientId
                timestamp,
                "", // nonce
            ].join("\n");

            const mac = crypto
                .createHmac("sha256", keySecret)
                .update(signText)
                .digest("base64");

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
                        "Access-Control-Allow-Origin": "*",
                    }
                }
            );
        } catch (error) {
            console.error("Ably token error:", error);
            return new Response(
                JSON.stringify({ error: "Failed to create Ably token" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" }
                }
            );
        }
    }),
});

/**
 * Health check endpoint
 */
http.route({
    path: "/health",
    method: "GET",
    handler: httpAction(async () => {
        return new Response(
            JSON.stringify({ ok: true, time: new Date().toISOString() }),
            {
                status: 200,
                headers: { "Content-Type": "application/json" }
            }
        );
    }),
});

export default http;
