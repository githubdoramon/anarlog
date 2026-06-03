import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  pinOrder: integer("pin_order"),
  category: text("category"),
  targetsJson: text("targets_json", { mode: "json" }),
  sectionsJson: text("sections_json", { mode: "json" }).notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const calendars = sqliteTable(
  "calendars",
  {
    id: text("id").primaryKey().notNull(),
    trackingIdCalendar: text("tracking_id_calendar").notNull().default(""),
    name: text("name").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    provider: text("provider").notNull().default(""),
    source: text("source").notNull().default(""),
    color: text("color").notNull().default("#888"),
    connectionId: text("connection_id").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_calendars_provider").on(table.provider)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey().notNull(),
    trackingIdEvent: text("tracking_id_event").notNull().default(""),
    calendarId: text("calendar_id").notNull().default(""),
    title: text("title").notNull().default(""),
    startedAt: text("started_at").notNull().default(""),
    endedAt: text("ended_at").notNull().default(""),
    location: text("location").notNull().default(""),
    meetingLink: text("meeting_link").notNull().default(""),
    description: text("description").notNull().default(""),
    note: text("note").notNull().default(""),
    recurrenceSeriesId: text("recurrence_series_id").notNull().default(""),
    hasRecurrenceRules: integer("has_recurrence_rules", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    isAllDay: integer("is_all_day", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    provider: text("provider").notNull().default(""),
    participantsJson: text("participants_json", { mode: "json" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_events_calendar_id").on(table.calendarId),
    index("idx_events_started_at").on(table.startedAt),
  ],
);

export const meetingTranscriptUploadQueue = sqliteTable(
  "meeting_transcript_upload_queue",
  {
    id: text("id").primaryKey().notNull(),
    sessionId: text("session_id").notNull().default(""),
    transcriptHash: text("transcript_hash").notNull().default(""),
    payloadJson: text("payload_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull().default(""),
    lastError: text("last_error").notNull().default(""),
    serverId: text("server_id").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    sentAt: text("sent_at").notNull().default(""),
  },
  (table) => [
    uniqueIndex("idx_meeting_transcript_upload_queue_session_hash").on(
      table.sessionId,
      table.transcriptHash,
    ),
    index("idx_meeting_transcript_upload_queue_retry").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);
