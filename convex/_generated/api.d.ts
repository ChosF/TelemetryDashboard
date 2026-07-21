/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as archiveActions from "../archiveActions.js";
import type * as archiveValidators from "../archiveValidators.js";
import type * as archives from "../archives.js";
import type * as auth from "../auth.js";
import type * as authHelpers from "../authHelpers.js";
import type * as authInternal from "../authInternal.js";
import type * as config from "../config.js";
import type * as crons from "../crons.js";
import type * as driverNotifications from "../driverNotifications.js";
import type * as historicalAccess from "../historicalAccess.js";
import type * as http from "../http.js";
import type * as sessions from "../sessions.js";
import type * as telemetry from "../telemetry.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  archiveActions: typeof archiveActions;
  archiveValidators: typeof archiveValidators;
  archives: typeof archives;
  auth: typeof auth;
  authHelpers: typeof authHelpers;
  authInternal: typeof authInternal;
  config: typeof config;
  crons: typeof crons;
  driverNotifications: typeof driverNotifications;
  historicalAccess: typeof historicalAccess;
  http: typeof http;
  sessions: typeof sessions;
  telemetry: typeof telemetry;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
