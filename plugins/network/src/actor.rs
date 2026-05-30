use ractor::{Actor, ActorProcessingErr, ActorRef};

pub const NETWORK_ACTOR_NAME: &str = "network_actor";

pub enum NetworkMsg {
    Check,
}

pub struct NetworkArgs {
    pub app: tauri::AppHandle,
}

pub struct NetworkState {
    app: tauri::AppHandle,
    is_online: bool,
}

pub struct NetworkActor;

impl NetworkActor {
    pub fn name() -> ractor::ActorName {
        NETWORK_ACTOR_NAME.into()
    }
}

#[ractor::async_trait]
impl Actor for NetworkActor {
    type Msg = NetworkMsg;
    type State = NetworkState;
    type Arguments = NetworkArgs;

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        Ok(NetworkState {
            app: args.app,
            is_online: true,
        })
    }

    async fn handle(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            NetworkMsg::Check => {
                let _ = (&state.app, state.is_online);
            }
        }
        Ok(())
    }
}
