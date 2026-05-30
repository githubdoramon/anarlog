use hypr_apple_todo::types::{
    CreateReminderInput, Reminder, ReminderFilter, ReminderIdentifierInput, ReminderList,
};
use hypr_ticket_interface::{CollectionPage, TicketPage};

use crate::error::Error;
use crate::read_path::{ReadPath, ReadPathResult};

#[tauri::command]
#[specta::specta]
pub fn authorization_status() -> Result<String, Error> {
    #[cfg(target_os = "macos")]
    {
        let status = hypr_apple_todo::Handle::authorization_status();
        Ok(format!("{:?}", status))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub fn request_full_access() -> Result<bool, Error> {
    #[cfg(target_os = "macos")]
    {
        Ok(hypr_apple_todo::Handle::request_full_access())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub fn list_todo_lists() -> Result<Vec<ReminderList>, Error> {
    #[cfg(target_os = "macos")]
    {
        let handle = hypr_apple_todo::Handle;
        handle.list_reminder_lists().map_err(Into::into)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub fn fetch_todos(filter: ReminderFilter) -> Result<Vec<Reminder>, Error> {
    #[cfg(target_os = "macos")]
    {
        let handle = hypr_apple_todo::Handle;
        handle.fetch_reminders(filter).map_err(Into::into)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = filter;
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn read_path<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<ReadPathResult, Error> {
    match ReadPath::parse(&path)? {
        ReadPath::Apple(path) => {
            #[cfg(target_os = "macos")]
            {
                let handle = hypr_apple_todo::Handle;
                match handle.read_path(path)? {
                    hypr_apple_todo::ReadPathResult::Lists(items) => {
                        Ok(ReadPathResult::ReminderLists(items))
                    }
                    hypr_apple_todo::ReadPathResult::Reminders(items) => {
                        Ok(ReadPathResult::Reminders(items))
                    }
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                Err(Error::UnsupportedPlatform)
            }
        }
        ReadPath::LinearTeams { connection_id } => {
            let _ = (app, connection_id, limit, cursor);
            Err(Error::RemoteDisabled)
        }
        ReadPath::LinearTickets {
            connection_id,
            team_id,
        } => {
            let _ = (app, connection_id, team_id, limit, cursor);
            Err(Error::RemoteDisabled)
        }
        ReadPath::GithubRepos { connection_id } => {
            let _ = (app, connection_id, limit, cursor);
            Err(Error::RemoteDisabled)
        }
        ReadPath::GithubTickets {
            connection_id,
            owner,
            repo,
        } => {
            let _ = (app, connection_id, owner, repo, limit, cursor);
            Err(Error::RemoteDisabled)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn create_todo(input: CreateReminderInput) -> Result<String, Error> {
    #[cfg(target_os = "macos")]
    {
        let handle = hypr_apple_todo::Handle;
        handle.create_reminder_identifier(input).map_err(Into::into)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = input;
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub fn complete_todo(target: ReminderIdentifierInput) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    {
        let handle = hypr_apple_todo::Handle;
        handle.complete_reminder(&target).map_err(Into::into)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub fn delete_todo(target: ReminderIdentifierInput) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    {
        let handle = hypr_apple_todo::Handle;
        handle.delete_reminder(&target).map_err(Into::into)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err(Error::UnsupportedPlatform)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn linear_list_teams<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    connection_id: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<CollectionPage, Error> {
    let _ = (app, connection_id, limit, cursor);
    Err(Error::RemoteDisabled)
}

#[tauri::command]
#[specta::specta]
pub async fn linear_list_tickets<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    connection_id: String,
    team_id: String,
    query: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<TicketPage, Error> {
    let _ = (app, connection_id, team_id, query, limit, cursor);
    Err(Error::RemoteDisabled)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issue_state(
    owner: String,
    repo: String,
    number: u64,
) -> Result<crate::github_state::GitHubIssueState, Error> {
    let _ = (owner, repo, number);
    Err(Error::RemoteDisabled)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issue_detail(
    owner: String,
    repo: String,
    number: u64,
) -> Result<hypr_github_issues::Issue, Error> {
    let _ = (owner, repo, number);
    Err(Error::RemoteDisabled)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issue_comments(
    owner: String,
    repo: String,
    number: u64,
) -> Result<Vec<hypr_github_issues::IssueComment>, Error> {
    let _ = (owner, repo, number);
    Err(Error::RemoteDisabled)
}
