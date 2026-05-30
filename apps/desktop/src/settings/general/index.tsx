import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";

import { commands as listenerCommands } from "@hypr/plugin-transcription";
import type { General, GeneralStorage } from "@hypr/store";

export { SettingsAccount } from "./account";
import { AppSettingsView } from "./app-settings";
import { getAdditionalSpokenLanguages } from "./language";
import { MainLanguageView } from "./main-language";
import { NotificationSettingsView } from "./notification";
import { Permissions } from "./permissions";
import { SpokenLanguagesView } from "./spoken-languages";
import { StorageSettingsView } from "./storage";
import { TimezoneSelector } from "./timezone";
import { WeekStartSelector } from "./week-start";

import { Data } from "~/settings/data";
import { SettingsPageTitle } from "~/settings/page-title";
import { useConfigValues } from "~/shared/config";
import * as settings from "~/store/tinybase/store/settings";

function useSettingsForm() {
  const value = useConfigValues([
    "auto_start_scheduled_meetings",
    "auto_stop_meetings",
    "notification_detect",
    "ai_language",
    "spoken_languages",
    "current_stt_provider",
  ] as const);

  const setPartialValues = settings.UI.useSetPartialValuesCallback(
    (row: Partial<General>) =>
      ({
        ...row,
        spoken_languages: row.spoken_languages
          ? JSON.stringify(row.spoken_languages)
          : undefined,
        ignored_platforms: row.ignored_platforms
          ? JSON.stringify(row.ignored_platforms)
          : undefined,
        included_platforms: row.included_platforms
          ? JSON.stringify(row.included_platforms)
          : undefined,
        ignored_recurring_series: row.ignored_recurring_series
          ? JSON.stringify(row.ignored_recurring_series)
          : undefined,
        ignored_events: row.ignored_events
          ? JSON.stringify(row.ignored_events)
          : undefined,
      }) satisfies Partial<GeneralStorage>,
    [],
    settings.STORE_ID,
  );

  const form = useForm({
    defaultValues: {
      auto_start_scheduled_meetings: value.auto_start_scheduled_meetings,
      auto_stop_meetings: value.auto_stop_meetings,
      notification_detect: value.notification_detect,
      ai_language: value.ai_language,
      spoken_languages: getAdditionalSpokenLanguages(
        value.ai_language,
        value.spoken_languages,
      ),
    },
    listeners: {
      onChange: ({ formApi }) => {
        const {
          form: { errors },
        } = formApi.getAllErrors();
        if (errors.length > 0) {
          console.log(errors);
        }
        void formApi.handleSubmit();
      },
    },
    onSubmit: ({ value }) => {
      const normalizedValue = {
        ...value,
        spoken_languages: getAdditionalSpokenLanguages(
          value.ai_language,
          value.spoken_languages,
        ),
      };

      setPartialValues(normalizedValue);
    },
  });

  return { form, value };
}

export function SettingsApp() {
  const { form } = useSettingsForm();

  const supportedLanguagesQuery = useQuery({
    queryKey: ["documented-language-codes", "live"],
    queryFn: async () => {
      const result = await listenerCommands.listDocumentedLanguageCodesLive();
      if (result.status === "error") {
        throw new Error(result.error);
      }
      return result.data;
    },
    staleTime: Infinity,
  });
  const supportedLanguages = supportedLanguagesQuery.data ?? ["en"];

  return (
    <div className="flex flex-col gap-8">
      <form.Field name="auto_start_scheduled_meetings">
        {(autoStartScheduledMeetingsField) => (
          <form.Field name="auto_stop_meetings">
            {(autoStopMeetingsField) => (
              <AppSettingsView
                autoStartScheduledMeetings={{
                  title: "Start when meeting begins",
                  description:
                    "Automatically start listening when an event-backed note reaches its scheduled start time.",
                  value: autoStartScheduledMeetingsField.state.value,
                  onChange: (val) =>
                    autoStartScheduledMeetingsField.handleChange(val),
                }}
                autoStopMeetings={{
                  title: "Stop when meeting ends",
                  description:
                    "Automatically stop listening when the meeting app releases the microphone.",
                  value: autoStopMeetingsField.state.value,
                  onChange: (val) => autoStopMeetingsField.handleChange(val),
                }}
              />
            )}
          </form.Field>
        )}
      </form.Field>

      <div>
        <h2 className="mb-4 font-serif text-lg font-semibold">
          Language & Region
        </h2>
        <div className="flex flex-col gap-6">
          <form.Field name="ai_language">
            {(field) => (
              <MainLanguageView
                value={field.state.value}
                onChange={(val) => {
                  field.handleChange(val);
                  form.setFieldValue(
                    "spoken_languages",
                    getAdditionalSpokenLanguages(
                      val,
                      form.state.values.spoken_languages,
                    ),
                  );
                }}
                supportedLanguages={supportedLanguages}
              />
            )}
          </form.Field>
          <TimezoneSelector />
          <WeekStartSelector />
          <form.Field name="spoken_languages">
            {(field) => (
              <SpokenLanguagesView
                mainLanguage={form.state.values.ai_language}
                value={field.state.value}
                onChange={(val) =>
                  field.handleChange(
                    getAdditionalSpokenLanguages(
                      form.state.values.ai_language,
                      val,
                    ),
                  )
                }
                supportedLanguages={supportedLanguages}
              />
            )}
          </form.Field>
        </div>
      </div>
    </div>
  );
}

export function SettingsData() {
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Data" />
      <StorageSettingsView />
      <Data />
    </div>
  );
}

export function SettingsNotifications() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageTitle title="Notifications" />
      <NotificationSettingsView />
    </div>
  );
}

export function SettingsPermissions() {
  return (
    <div className="flex flex-col gap-8">
      <Permissions />
    </div>
  );
}
