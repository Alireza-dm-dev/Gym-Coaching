import handler from "vinext/server/fetch-handler";
import { getDb } from "../db";
import { deleteExpiredSessionDetails } from "../lib/session-retention";

/**
 * Worker entry: HTTP is delegated unchanged to vinext's own fetch handler;
 * `scheduled` is the daily Session-detail retention trigger. It is internal
 * infrastructure (no HTTP surface, no user auth) and only adapts the cron
 * event to `deleteExpiredSessionDetails`, which owns all retention logic.
 */
export default {
  fetch: handler.fetch,

  async scheduled(controller: ScheduledController): Promise<void> {
    const startedAt = Date.now();
    const scheduledTime = new Date(controller.scheduledTime);
    try {
      const result = await deleteExpiredSessionDetails(getDb(), scheduledTime);
      console.log(
        JSON.stringify({
          event: "session_detail_retention",
          scheduledTime: scheduledTime.toISOString(),
          cutoffDateKey: result.cutoffDateKey,
          cutoffIso: result.cutoffIso,
          deletedNotes: result.deletedNotes,
          deletedMuscles: result.deletedMuscles,
          durationMs: Date.now() - startedAt,
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "session_detail_retention_failed",
          scheduledTime: Number.isNaN(scheduledTime.getTime()) ? null : scheduledTime.toISOString(),
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        })
      );
      // Rethrow so Cloudflare records the invocation as failed.
      throw error;
    }
  },
} satisfies ExportedHandler;
