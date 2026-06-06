use std::fmt;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct AuthCallbackSearch {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub code: Option<String>,
    pub state: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
}

impl fmt::Debug for AuthCallbackSearch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthCallbackSearch")
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("code", &self.code.as_ref().map(|_| "[REDACTED]"))
            .field("state", &self.state)
            .field("scope", &self.scope)
            .field("error", &self.error)
            .finish()
    }
}
