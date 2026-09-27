//! Limit output until xterm acknowledges parsing it, including hidden panes.
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
pub struct Flows(pub Mutex<HashMap<u32, (String, Arc<Flow>)>>);

#[derive(Default)]
pub struct Flow {
    state: Mutex<(usize, bool)>,
    ready: Condvar,
}

impl Flow {
    pub fn acquire(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        while state.0 >= 4 && !state.1 { state = self.ready.wait(state).unwrap(); }
        if state.1 { return false; }
        state.0 += 1;
        true
    }

    pub fn ack(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = state.0.saturating_sub(1);
        self.ready.notify_one();
    }

    pub fn close(&self) {
        self.state.lock().unwrap().1 = true;
        self.ready.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn output_waits_for_parser_ack_and_shutdown_releases_waiters() {
        let flow = Arc::new(Flow::default());
        for _ in 0..4 { assert!(flow.acquire()); }
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = flow.clone();
        let task = std::thread::spawn(move || { tx.send(worker.acquire()).unwrap(); tx.send(worker.acquire()).unwrap(); });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.ack();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.close();
        assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
        task.join().unwrap();
    }
}
