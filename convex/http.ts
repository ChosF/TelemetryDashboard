import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// CORS headers for cross-origin requests
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
};

/**
 * CORS preflight handler for /ably/token
 */
http.route({
    path: "/ably/token",
    method: "OPTIONS",
    handler: httpAction(async () => {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
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
    handler: httpAction(async (ctx, request) => {
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
                        ...corsHeaders
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

            // Get clientId from query params if provided
            const url = new URL(request.url);
            const clientId = url.searchParams.get("clientId") || "";

            // For simple token requests, we can return basic token params
            // The client will use these to request a token from Ably
            const tokenParams = {
                keyName: keyName,
                timestamp: timestamp,
                ttl: ttl,
                capability: JSON.stringify({ "*": ["*"] }),
                clientId: clientId,
            };

            // Sign the token request
            const crypto = await import("crypto");
            const signText = [
                keyName,
                ttl,
                JSON.stringify({ "*": ["*"] }),
                clientId,
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
                        ...corsHeaders
                    }
                }
            );
        } catch (error) {
            console.error("Ably token error:", error);
            return new Response(
                JSON.stringify({ 
                    error: "Failed to create Ably token",
                    details: error instanceof Error ? error.message : "Unknown error"
                }),
                {
                    status: 500,
                    headers: { 
                        "Content-Type": "application/json",
                        ...corsHeaders
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
    handler: httpAction(async () => {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
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
                headers: { 
                    "Content-Type": "application/json",
                    ...corsHeaders
                }
            }
        );
    }),
});

export default http;
