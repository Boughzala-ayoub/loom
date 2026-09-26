use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, EXECUTION_STATE,
};

// Thread-scoped: callers must use the main event-loop thread, including cleanup.
pub fn apply(enabled: bool) -> Result<EXECUTION_STATE, String> {
    let flags = if enabled {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    let previous = unsafe { SetThreadExecutionState(flags) };
    if previous.0 == 0 {
        Err("Windows could not change the keep-awake setting".into())
    } else {
        Ok(previous)
    }
}

#[tauri::command]
pub async fn set_keep_awake(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.try_send(apply(enabled).map(|_| ()));
    }).map_err(|e| e.to_string())?;
    rx.recv().await.ok_or("Keep-awake request was interrupted")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_system_and_display_awake_until_disabled() {
        let original = apply(true).unwrap();
        let enabled = apply(true);
        let released = apply(false);
        let disabled = apply(false);
        unsafe { SetThreadExecutionState(original); }
        let flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED;
        assert_eq!(enabled.unwrap(), flags);
        assert_eq!(released.unwrap(), flags);
        assert_eq!(disabled.unwrap(), ES_CONTINUOUS);
    }
}
