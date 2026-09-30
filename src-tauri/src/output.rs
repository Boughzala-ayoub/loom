//! Limit output until xterm acknowledges parsing it, including hidden panes.
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The shortest gap between two bus messages.
pub const FLUSH: Duration = Duration::from_millis(16);

type Sink = Arc<dyn Fn(Vec<(u32, String)>) + Send + Sync>;
/// The page's sink, once it opens the bus, and the chunks waiting for the next flush.
type Queue = (Option<Sink>, Vec<(u32, String)>);

/// Every pane's output to the window as one message per flush, entries tagged
/// with the launch's channel id. A message is a script eval on the main thread
/// and a hop through WebView2's browser process: one per chunk cost ~30% of a
/// core at 24 panes redrawing 10 times a second. A flush leaves at once when the
/// last one left over FLUSH ago, so a lone keystroke's echo waits for nothing;
/// under load, chunks ride the next flush. Flow control stays per launch: an
/// entry is one acquired chunk, and the page acks each one.
#[derive(Default)]
pub struct Bus {
    state: Mutex<Queue>,
    ready: Condvar,
    /// Held from taking a batch until it is sent, so batches leave in order.
    sending: Mutex<()>,
}

impl Bus {
    /// Where flushes go from now on. A reloaded page opens it again.
    pub fn open(&self, sink: impl Fn(Vec<(u32, String)>) + Send + Sync + 'static) {
        self.state.lock().unwrap().0 = Some(Arc::new(sink));
    }

    /// Queues a chunk, or hands it back while no page has opened the bus.
    pub fn push(&self, channel: u32, text: String) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.0.is_none() { return Err(text); }
        state.1.push((channel, text));
        self.ready.notify_one();
        Ok(())
    }

    /// Sends what is queued now. An exit calls this before its event, so a
    /// process's last output still lands before "[exited]".
    pub fn flush(&self) {
        let _order = self.sending.lock().unwrap();
        let (batch, sink) = {
            let mut state = self.state.lock().unwrap();
            (std::mem::take(&mut state.1), state.0.clone())
        };
        if let (false, Some(sink)) = (batch.is_empty(), sink) { sink(batch); }
    }

    /// The flusher, on its own thread for the app's life.
    pub fn run(&self) {
        let mut last = Instant::now() - FLUSH;
        loop {
            {
                let mut state = self.state.lock().unwrap();
                while state.1.is_empty() { state = self.ready.wait(state).unwrap(); }
            }
            std::thread::sleep(FLUSH.saturating_sub(last.elapsed()));
            self.flush();
            last = Instant::now();
        }
    }
}

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
        self.ack_n(1);
    }

    pub fn ack_n(&self, n: usize) {
        let mut state = self.state.lock().unwrap();
        state.0 = state.0.saturating_sub(n);
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

    #[test]
    fn bus_sends_a_lone_chunk_at_once_and_batches_a_burst_in_order() {
        let bus = Arc::new(Bus::default());
        assert_eq!(bus.push(1, "early".into()), Err("early".into()), "no page, no queue");
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        bus.open(move |batch| tx.lock().unwrap().send((Instant::now(), batch)).unwrap());
        let runner = bus.clone();
        std::thread::spawn(move || runner.run());
        let pushed = Instant::now();
        bus.push(1, "a".into()).unwrap();
        let (first_at, first) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first, vec![(1, "a".to_string())]);
        assert!(first_at - pushed < FLUSH, "the first flush does not wait");
        bus.push(2, "b".into()).unwrap();
        bus.push(1, "c".into()).unwrap();
        let (second_at, second) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(second, vec![(2, "b".to_string()), (1, "c".to_string())]);
        assert!(second_at - first_at >= FLUSH);
        // An exit's flush doesn't wait out the gap.
        bus.push(3, "last words".into()).unwrap();
        let flushed = Instant::now();
        bus.flush();
        let (third_at, third) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(third, vec![(3, "last words".to_string())]);
        assert!(third_at - flushed < FLUSH);
    }
}
