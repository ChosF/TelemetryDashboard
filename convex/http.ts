import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

function matchesOriginPattern(origin: string, pattern: string): boolean {
    if (!pattern.includes("*")) return origin === pattern;

    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin) return false;

    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wildcardPattern = escapedPattern.replaceAll("\\*", "[A-Za-z0-9-]+");
    return new RegExp(`^${wildcardPattern}$`).test(origin);
}

function getAllowedOrigin(request: Request): string | null {
    const origin = request.headers.get("Origin");
    const configuredOrigins = (process.env.ALLOWED_WEB_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (configuredOrigins.length === 0) return "*";
    if (!origin) return configuredOrigins[0] ?? null;
    try {
        return configuredOrigins.some((pattern) => matchesOriginPattern(origin, pattern))
            ? origin
            : null;
    } catch {
        return null;
    }
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
    handler: httpAction(async (ctx, request) => {
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
            // Get clientId from query params if provided
            const url = new URL(request.url);
            const requestedClientId = url.searchParams.get("clientId") || "dashboard-web";
            const clientId = /^[A-Za-z0-9._-]{1,64}$/.test(requestedClientId)
                ? requestedClientId
                : "dashboard-web";
            const tokenRequest = await ctx.runAction(
                internal.ablyAuth.createTokenRequest,
                { clientId },
            );

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
