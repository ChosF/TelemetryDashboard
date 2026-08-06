"use node";

import { createHmac, randomUUID } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const tokenRequestValidator = v.object({
    keyName: v.string(),
    timestamp: v.number(),
    ttl: v.number(),
    capability: v.string(),
    clientId: v.string(),
    nonce: v.string(),
    mac: v.string(),
});

function createSignedTokenRequest(
    ablyApiKey: string | undefined,
    environmentVariable: "ABLY_API_KEY" | "ESP32_ABLY_API_KEY",
    channelName: string,
    operations: readonly string[],
    clientId: string,
) {
    const normalizedApiKey = ablyApiKey?.trim();
    if (!normalizedApiKey) {
        throw new Error(`${environmentVariable} is not configured`);
    }

    const separatorIndex = normalizedApiKey.indexOf(":");
    const keyName = normalizedApiKey.slice(0, separatorIndex);
    const keySecret = normalizedApiKey.slice(separatorIndex + 1);
    if (
        separatorIndex <= 0
        || separatorIndex === normalizedApiKey.length - 1
        || normalizedApiKey.indexOf(":", separatorIndex + 1) !== -1
        || /\s/.test(normalizedApiKey)
    ) {
        throw new Error(`${environmentVariable} has an invalid format`);
    }

    const capability = JSON.stringify({
        [channelName]: operations,
    });
    const timestamp = Date.now();
    const ttl = 3_600_000;
    const nonce = randomUUID();
    const signText = [
        keyName,
        ttl,
        capability,
        clientId,
        timestamp,
        nonce,
        "",
    ].join("\n");
    const mac = createHmac("sha256", keySecret)
        .update(signText, "utf8")
        .digest("base64");

    return {
        keyName,
        timestamp,
        ttl,
        capability,
        clientId,
        nonce,
        mac,
    };
}

export const createTokenRequest = internalAction({
    args: { clientId: v.string() },
    returns: tokenRequestValidator,
    handler: async (_ctx, args) => {
        const dashboardChannel = process.env.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";
        return createSignedTokenRequest(
            process.env.ABLY_API_KEY,
            "ABLY_API_KEY",
            dashboardChannel,
            ["history", "subscribe"],
            args.clientId,
        );
    },
});

export const createEsp32TokenRequest = internalAction({
    args: { clientId: v.string() },
    returns: tokenRequestValidator,
    handler: async (_ctx, args) => {
        const esp32Channel = process.env.ESP32_ABLY_CHANNEL_NAME || "EcoTele";
        return createSignedTokenRequest(
            process.env.ESP32_ABLY_API_KEY,
            "ESP32_ABLY_API_KEY",
            esp32Channel,
            ["subscribe"],
            args.clientId,
        );
    },
});
