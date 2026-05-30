use crate::{Feature, FlagStrategy};

pub struct Flag<'a, R: tauri::Runtime, M: tauri::Manager<R>> {
    _manager: &'a M,
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<'a, R: tauri::Runtime, M: tauri::Manager<R>> Flag<'a, R, M> {
    pub async fn is_enabled(&self, feature: Feature) -> bool {
        match feature.strategy() {
            FlagStrategy::Debug => cfg!(debug_assertions),
            FlagStrategy::Hardcoded(v) => v,
            FlagStrategy::Posthog(_) => false,
        }
    }
}

pub trait FlagPluginExt<R: tauri::Runtime> {
    fn flag(&self) -> Flag<'_, R, Self>
    where
        Self: tauri::Manager<R> + Sized;
}

impl<R: tauri::Runtime, T: tauri::Manager<R>> FlagPluginExt<R> for T {
    fn flag(&self) -> Flag<'_, R, Self>
    where
        Self: Sized,
    {
        Flag {
            _manager: self,
            _runtime: std::marker::PhantomData,
        }
    }
}
