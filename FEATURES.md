# Features

This document summarizes which features in this repo are payment-gated, how the
gate is enforced, and which related features are not gated.

Billing state is derived from JWT claims in `packages/supabase/src/billing.ts`.

- `isPaid`: true for `lite`, `pro`, active trial, or active subscription
- `isPro`: effectively Pro entitlement or active trial

## Payment-Gated Features

| Feature | Gate | Where enforced | Notes |
| --- | --- | --- | --- |
| Anarlog-hosted LLM provider (`hyprnote` / "Anarlog Cloud") | `isPaid` / Pro entitlement path | Provider requires auth + `pro` in `apps/desktop/src/settings/ai/llm/shared.tsx`, connection rejects non-Pro in `apps/desktop/src/ai/hooks/useLLMConnection.ts`, selector blocks it in `apps/desktop/src/settings/ai/llm/select.tsx`, cloud CTA upgrades in `apps/desktop/src/settings/ai/llm/configure.tsx` | This is the built-in hosted LLM, not BYO providers like OpenAI or Ollama. |
| Meeting summarization with the built-in Anarlog LLM | Same as above | Error state shown in `apps/desktop/src/session/components/note-input/enhanced/config-error.tsx` | The summary UI is blocked when the selected provider is hosted Anarlog and the plan is not valid. |
| Anarlog-hosted cloud STT (`hyprnote` provider + `cloud` model) | `isPaid` | Connection returns `null` unless signed in and paid in `apps/desktop/src/stt/useSTTConnection.ts`, cloud provider entry in `apps/desktop/src/settings/ai/stt/shared.tsx`, selector shows locked state in `apps/desktop/src/settings/ai/stt/select.tsx`, cloud CTA upgrades in `apps/desktop/src/settings/ai/stt/configure.tsx` | Local STT downloads are separate and not payment-gated. |
| Web integration connect flow | `isPaid` | Upgrade prompt if unpaid in `apps/web/src/routes/_view/app/integration.tsx` | Named integration ids here are `google-calendar`, `linear`, and `github`. |
| Google Calendar integration | `isPro` | Provider definitions in `apps/desktop/src/calendar/components/shared.tsx`, sidebar treats Nango providers as Pro-only in `apps/desktop/src/calendar/components/sidebar.tsx`, OAuth panel upgrades in `apps/desktop/src/calendar/components/oauth/provider-content.tsx`, onboarding upgrades before connect in `apps/desktop/src/onboarding/calendar.tsx` | Apple Calendar is not in this gate path. |
| Outlook Calendar integration | `isPro` | Same enforcement path as Google Calendar, plus onboarding connect in `apps/desktop/src/onboarding/calendar.tsx` | Outlook is labeled "Only in Pro" during onboarding. |
| OAuth todo integrations in general | `isPaid` | Upgrade required in `apps/desktop/src/settings/todo/provider-content.tsx` | This is the generic gate for todo providers with `nangoIntegrationId`. |
| GitHub private repo access in todo UI | `isPaid` + GitHub connection | Explicit copy in `apps/desktop/src/settings/todo/github.tsx` | Public repos still work without payment. Private repos require upgrade and then GitHub connection. |
| Audio playback speed above `1x` | `isPro` | Non-Pro users are forced back to `1x` in `apps/desktop/src/audio-player/provider.tsx`, rate menu only renders for Pro in `apps/desktop/src/audio-player/timeline.tsx` | This is the only clearly local-only feature found to be payment-gated. |

## Not Payment-Gated

- Local note capture and editing
- Local STT models you download yourself
- BYO LLM providers like OpenAI, Anthropic, OpenRouter, Ollama, and LM Studio
- Apple Calendar
- Apple Reminders
- Public GitHub repo selection in the todo UI

## Billing UX, Not Separate Feature Gates

- Trial start and eligibility flows in `apps/desktop/src/onboarding/account/trial.tsx`
- Upgrade and portal/account screens in `apps/web/src/functions/billing.ts`
- Desktop account upgrade prompts in `apps/desktop/src/auth/billing.tsx`
