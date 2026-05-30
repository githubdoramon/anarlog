mod auth_callback;
mod billing_refresh;
mod google_calendar_callback;
mod integration_callback;

pub use auth_callback::*;
pub use billing_refresh::*;
pub use google_calendar_callback::*;
pub use integration_callback::*;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::str::FromStr;

#[derive(Debug, Clone, serde::Serialize, specta::Type, tauri_specta::Event)]
pub struct DeepLinkEvent(pub DeepLink);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "to", content = "search")]
pub enum DeepLink {
    #[serde(rename = "/auth/callback")]
    AuthCallback(AuthCallbackSearch),
    #[serde(rename = "/billing/refresh")]
    BillingRefresh(BillingRefreshSearch),
    #[serde(rename = "/google-calendar/callback")]
    GoogleCalendarCallback(GoogleCalendarCallbackSearch),
    #[serde(rename = "/integration/callback")]
    IntegrationCallback(IntegrationCallbackSearch),
}

impl DeepLink {
    pub fn path(&self) -> &'static str {
        match self {
            DeepLink::AuthCallback(_) => "/auth/callback",
            DeepLink::BillingRefresh(_) => "/billing/refresh",
            DeepLink::GoogleCalendarCallback(_) => "/google-calendar/callback",
            DeepLink::IntegrationCallback(_) => "/integration/callback",
        }
    }
}

impl FromStr for DeepLink {
    type Err = crate::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let parsed = url::Url::parse(s)?;

        let host = parsed.host_str().unwrap_or("");
        let path = parsed.path().trim_start_matches('/');
        let full_path = if path.is_empty() {
            host.to_string()
        } else {
            format!("{}/{}", host, path)
        };

        let query = parsed.query().unwrap_or("");

        match full_path.as_str() {
            "auth/callback" => Ok(DeepLink::AuthCallback(serde_qs::from_str(query)?)),
            "billing/refresh" => Ok(DeepLink::BillingRefresh(serde_qs::from_str(query)?)),
            "google-calendar/callback" => {
                Ok(DeepLink::GoogleCalendarCallback(serde_qs::from_str(query)?))
            }
            "integration/callback" => Ok(DeepLink::IntegrationCallback(serde_qs::from_str(query)?)),
            _ => Err(crate::Error::UnknownPath(full_path)),
        }
    }
}
