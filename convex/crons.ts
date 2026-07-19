import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Inactive telemetry is immutable analytical data. Moving it in bounded jobs
// keeps the live tail queryable while steadily reducing database rows/indexes.
crons.interval(
  "archive inactive telemetry sessions",
  // Hourly keeps the idle baseline to 24 scheduler invocations per day. The
  // 30-minute inactivity check still guarantees that live sessions stay hot.
  { hours: 1 },
  internal.archiveActions.archiveInactiveSessions,
);

export default crons;
