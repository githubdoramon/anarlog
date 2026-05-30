import { commands as calendarCommands } from "@hypr/plugin-calendar";
import type { CalendarEvent } from "@hypr/plugin-calendar";

import type { Ctx } from "../ctx";
import type {
  EventParticipant,
  IncomingEvent,
  IncomingParticipants,
} from "./types";

import {
  GOOGLE_LOCAL_CONNECTION_ID,
  listGoogleLocalEvents,
  type GoogleEvent,
} from "~/calendar/google-local";

export class CalendarFetchError extends Error {
  constructor(
    public readonly calendarTrackingId: string,
    public readonly cause: string,
  ) {
    super(
      `Failed to fetch events for calendar ${calendarTrackingId}: ${cause}`,
    );
    this.name = "CalendarFetchError";
  }
}

export async function fetchIncomingEvents(ctx: Ctx): Promise<{
  events: IncomingEvent[];
  participants: IncomingParticipants;
}> {
  if (
    ctx.provider === "google" &&
    ctx.connectionId === GOOGLE_LOCAL_CONNECTION_ID
  ) {
    return fetchGoogleLocalIncomingEvents(ctx);
  }

  const trackingIds = Array.from(ctx.calendarTrackingIdToId.keys());

  const results = await Promise.all(
    trackingIds.map(async (trackingId) => {
      const result = await calendarCommands.listEvents(
        ctx.provider,
        ctx.connectionId,
        {
          calendar_tracking_id: trackingId,
          from: ctx.from.toISOString(),
          to: ctx.to.toISOString(),
        },
      );

      if (result.status === "error") {
        throw new CalendarFetchError(trackingId, result.error);
      }

      return result.data;
    }),
  );

  const calendarEvents = results.flat();
  const events: IncomingEvent[] = [];
  const participants: IncomingParticipants = new Map();

  for (const calendarEvent of calendarEvents) {
    if (
      calendarEvent.attendees.find(
        (attendee) =>
          attendee.is_current_user && attendee.status === "declined",
      )
    ) {
      continue;
    }
    const { event, eventParticipants } =
      await normalizeCalendarEvent(calendarEvent);
    events.push(event);
    if (eventParticipants.length > 0) {
      participants.set(event.tracking_id_event, eventParticipants);
    }
  }

  return { events, participants };
}

async function fetchGoogleLocalIncomingEvents(ctx: Ctx): Promise<{
  events: IncomingEvent[];
  participants: IncomingParticipants;
}> {
  const trackingIds = Array.from(ctx.calendarTrackingIdToId.keys());
  const results = await Promise.all(
    trackingIds.map(async (trackingId) => {
      try {
        const googleEvents = await listGoogleLocalEvents({
          calendarId: trackingId,
          from: ctx.from,
          to: ctx.to,
        });

        return googleEvents.map((event) => ({ trackingId, event }));
      } catch (e) {
        throw new CalendarFetchError(
          trackingId,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );

  const events: IncomingEvent[] = [];
  const participants: IncomingParticipants = new Map();

  for (const { trackingId, event: googleEvent } of results.flat()) {
    const normalized = normalizeGoogleEvent(trackingId, googleEvent);
    if (!normalized) continue;
    events.push(normalized.event);
    if (normalized.eventParticipants.length > 0) {
      participants.set(
        normalized.event.tracking_id_event,
        normalized.eventParticipants,
      );
    }
  }

  return { events, participants };
}

function normalizeGoogleEvent(
  calendarTrackingId: string,
  event: GoogleEvent,
): { event: IncomingEvent; eventParticipants: EventParticipant[] } | null {
  const start = googleEventDateToIso(event.start);
  const end = googleEventDateToIso(event.end);
  if (!start || !end) {
    return null;
  }

  const eventParticipants: EventParticipant[] = [];
  if (event.organizer) {
    eventParticipants.push({
      name: event.organizer.displayName,
      email: event.organizer.email,
      is_organizer: true,
      is_current_user: event.organizer.self,
    });
  }

  const organizerEmail = event.organizer?.email?.toLowerCase();
  for (const attendee of event.attendees ?? []) {
    if (organizerEmail && attendee.email?.toLowerCase() === organizerEmail) {
      continue;
    }
    eventParticipants.push({
      name: attendee.displayName,
      email: attendee.email,
      is_organizer: false,
      is_current_user: attendee.self,
    });
  }

  return {
    event: {
      tracking_id_event: event.id,
      tracking_id_calendar: calendarTrackingId,
      title: event.summary ?? "",
      started_at: start,
      ended_at: end,
      location: event.location,
      meeting_link: getGoogleMeetingLink(event),
      description: event.description,
      recurrence_series_id: event.recurringEventId,
      has_recurrence_rules: (event.recurrence?.length ?? 0) > 0,
      is_all_day: !!event.start?.date,
    },
    eventParticipants,
  };
}

function googleEventDateToIso(value: GoogleEvent["start"]) {
  if (!value) return undefined;
  if (value.dateTime) return value.dateTime;
  if (value.date) return new Date(`${value.date}T00:00:00`).toISOString();
  return undefined;
}

function getGoogleMeetingLink(event: GoogleEvent) {
  const conferenceLink = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video" && entry.uri,
  )?.uri;
  return conferenceLink ?? event.hangoutLink ?? event.htmlLink;
}

async function normalizeCalendarEvent(calendarEvent: CalendarEvent): Promise<{
  event: IncomingEvent;
  eventParticipants: EventParticipant[];
}> {
  const meetingLink =
    calendarEvent.meeting_link ??
    (await extractMeetingLink(
      calendarEvent.description,
      calendarEvent.location,
    ));

  const eventParticipants: EventParticipant[] = [];

  if (calendarEvent.organizer) {
    eventParticipants.push({
      name: calendarEvent.organizer.name ?? undefined,
      email: calendarEvent.organizer.email ?? undefined,
      is_organizer: true,
      is_current_user: calendarEvent.organizer.is_current_user,
    });
  }

  const organizerEmail = calendarEvent.organizer?.email?.toLowerCase();

  for (const attendee of calendarEvent.attendees) {
    if (attendee.role === "nonparticipant") continue;
    if (organizerEmail && attendee.email?.toLowerCase() === organizerEmail)
      continue;
    eventParticipants.push({
      name: attendee.name ?? undefined,
      email: attendee.email ?? undefined,
      is_organizer: false,
      is_current_user: attendee.is_current_user,
    });
  }

  return {
    event: {
      tracking_id_event: calendarEvent.id,
      tracking_id_calendar: calendarEvent.calendar_id,
      title: calendarEvent.title,
      started_at: calendarEvent.started_at,
      ended_at: calendarEvent.ended_at,
      location: calendarEvent.location ?? undefined,
      meeting_link: meetingLink ?? undefined,
      description: calendarEvent.description ?? undefined,
      recurrence_series_id: calendarEvent.recurring_event_id ?? undefined,
      has_recurrence_rules: calendarEvent.has_recurrence_rules,
      is_all_day: calendarEvent.is_all_day,
    },
    eventParticipants,
  };
}

async function extractMeetingLink(
  ...texts: (string | undefined | null)[]
): Promise<string | undefined> {
  for (const text of texts) {
    if (!text) continue;
    const result = await calendarCommands.parseMeetingLink(text);
    if (result) return result;
  }
  return undefined;
}
