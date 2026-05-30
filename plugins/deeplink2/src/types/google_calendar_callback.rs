use std::fmt;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct GoogleCalendarCallbackSearch {
    pub code: Option<String>,
    pub state: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
}

impl fmt::Debug for GoogleCalendarCallbackSearch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleCalendarCallbackSearch")
            .field("code", &self.code.as_ref().map(|_| "[REDACTED]"))
            .field("state", &self.state)
            .field("scope", &self.scope)
            .field("error", &self.error)
            .finish()
    }
}
