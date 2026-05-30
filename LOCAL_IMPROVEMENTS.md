# Local Improvements

This document lists the changes worth making if the goal is a quieter, local-first fork of this repo with fewer remote calls, less telemetry, and less automatic host-side behavior.

The focus is reducing unnecessary tracking, background network traffic, automatic update behavior, and startup side effects.

## Priority 1

These changes have the highest privacy or predictability payoff and the lowest risk to core local note-taking.


| Change                                        | Why                                                                                                           | Files                                                                                               | Suggested change                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove frontend Sentry initialization         | Prevent desktop UI crash/replay telemetry from being sent to Sentry.                                          | `apps/desktop/src/main.tsx`                                                                         | Delete the `Sentry.init(...)` block or guard it behind a local-fork build flag that defaults off.                                               |
| Remove Rust-side Sentry initialization        | Prevent native crash reporting and Sentry user tagging based on the machine fingerprint.                      | `apps/desktop/src-tauri/src/lib.rs`                                                                 | Remove the `option_env!("SENTRY_DSN")` setup and the `tauri_plugin_sentry::init_with_no_injection(client)` registration.                        |
| Remove PostHog analytics plugin               | Prevent analytics events and identify calls from being emitted at all.                                        | `apps/desktop/src-tauri/src/lib.rs`, `plugins/analytics/src/lib.rs`, `plugins/analytics/src/ext.rs` | Stop registering `tauri_plugin_analytics::init()`. For a cleaner fork, compile the plugin out entirely rather than relying on `disabled` state. |
| Remove auth-driven analytics identification   | Signed-in users currently get identified with email, plan, app version, platform, OS version, and trial date. | `apps/desktop/src/auth/context.tsx`                                                                 | Delete `trackAuthEvent(...)` calls or no-op the function in the local fork.                                                                     |
| Disable the background updater loop           | Prevent silent periodic update checks and background downloads every 30 minutes.                              | `apps/desktop/src-tauri/src/lib.rs`, `plugins/updater2/src/lib.rs`                                  | Remove `tauri_plugin_updater2::init()` or change the plugin to only perform manual checks from an explicit settings action.                     |
| Remove the 2-second Google reachability probe | Avoid constant outbound requests to `https://www.google.com/generate_204`.                                    | `plugins/network/src/actor.rs`                                                                      | Replace the HTTP probe with OS-native connectivity signals, a user-triggered retry, or a much slower optional backoff-based check.              |


## Priority 2

These are still reasonable changes for a local-only build, but they affect more integration behavior or startup convenience.


| Change                                        | Why                                                                                                                   | Files                                                          | Suggested change                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Disable autostart registration                | Prevent the app from registering itself to launch in the background on login.                                         | `apps/desktop/src-tauri/src/lib.rs`                            | Gate it behind a user opt-in under settings                                                                                  |
| Stop automatic agent hook upgrades on startup | Prevent the app from modifying existing Codex, Claude, or OpenCode hook config on launch.                             | `plugins/agent/src/lib.rs`, `crates/agent-core/src/install.rs` | Remove the `hypr_agent_core::upgrade_hooks()` call from plugin setup.                                                        |
| Disable shell hook execution by default       | Hooks can spawn arbitrary local commands once configured.                                                             | `crates/hooks/src/runner.rs` and the hooks plugin/config path  | Require an explicit “enable hooks” setting before execution is allowed.                                                      |
| Reduce plugin surface area                    | The desktop app loads many plugins with filesystem, shell, process, HTTP, sidecar, MCP, and integration capabilities. | `apps/desktop/src-tauri/src/lib.rs`                            | Remove plugins that are not needed for your fork, especially cloud, integration, update, hook, and external-tooling plugins. |


## Priority 3

These are mostly product-shaping changes for a cleaner local-only fork.


| Change                                                    | Why                                                                                            | Files                                                                                      | Suggested change                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Hide cloud-first onboarding and billing UX                | Reduce dead-end flows when the fork is intended to be local-only.                              | Desktop auth, onboarding, billing, and settings screens                                    | Remove sign-in prompts, upgrade CTAs, and cloud-provider defaults from the desktop UI.                                      |
| Default to local models and local storage                 | Keep first-run behavior aligned with the fork's privacy goal.                                  | AI/STT settings and onboarding flows                                                       | Prefer local STT, local LLMs, and local calendar/todo options by default.                                                   |
| Remove Supabase dependencies from the local fork          | A local note-taker should not depend on hosted auth or hosted data services for core behavior. | Web auth/billing/integration flows, desktop auth flows, Supabase client helpers, env setup | Remove Supabase-backed auth/session/billing flows and keep note, settings, and metadata storage in local SQLite/files only. |
| Remove cloud environment variables from local build setup | Prevent accidental activation of telemetry or hosted services.                                 | `.env` files, build secrets, CI config                                                     | Do not set `SENTRY_DSN`, `VITE_SENTRY_DSN`, `POSTHOG_API_KEY`, or hosted API credentials in local builds.                   |


## Recommended Order

1. Remove Sentry and PostHog completely.
2. Remove the updater loop.
3. Remove the Google connectivity probe.
4. Disable autostart.
5. Disable automatic agent hook upgrades and hook execution.
6. Trim the plugin list to what your fork actually needs.
7. Clean up the UI so local-only paths are the default experience.

## What This Should Not Break

If done carefully, these changes should not break the core local workflow:

- local note capture and editing
- local database usage
- local STT models
- BYO LLM providers
- other purely local desktop behavior

## Verification Checklist

- Launch the app with no network connection and confirm it still opens normally.
- Confirm there are no outbound requests on idle startup except for features you intentionally kept.
- Confirm no login item or autostart entry is created unless explicitly enabled.
- Confirm no files in external CLI tool configs are rewritten during startup.
- Confirm local note-taking, local STT, and local model flows still work.

