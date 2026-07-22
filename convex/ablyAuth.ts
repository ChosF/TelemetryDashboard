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

export const createTokenRequest = internalAction({
    args: { clientId: v.string() },
    returns: tokenRequestValidator,
    handler: async (_ctx, args) => {
        const ablyApiKey = process.env.ABLY_API_KEY?.trim();
        if (!ablyApiKey) {
            throw new Error("ABLY_API_KEY is not configured");
        }

        const separatorIndex = ablyApiKey.indexOf(":");
        const keyName = ablyApiKey.slice(0, separatorIndex);
        const keySecret = ablyApiKey.slice(separatorIndex + 1);
        if (
            separatorIndex <= 0
            || separatorIndex === ablyApiKey.length - 1
            || ablyApiKey.indexOf(":", separatorIndex + 1) !== -1
            || /\s/.test(ablyApiKey)
        ) {
            throw new Error("ABLY_API_KEY has an invalid format");
        }

        const dashboardChannel = process.env.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";
        const esp32Channel = process.env.ESP32_ABLY_CHANNEL_NAME || "EcoTele";
        const capabilityChannels = [
            ...new Set([dashboardChannel, esp32Channel]),
        ].sort();
        const capability = JSON.stringify(Object.fromEntries(
            capabilityChannels.map((channel) => [
                channel,
                ["history", "subscribe"],
            ]),
        ));
        const timestamp = Date.now();
        const ttl = 3_600_000;
        const nonce = randomUUID();
        const signText = [
            keyName,
            ttl,
            capability,
            args.clientId,
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
            clientId: args.clientId,
            nonce,
            mac,
        };
    },
});
