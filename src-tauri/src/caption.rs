//! Windows 11 snap layouts on Loom's own maximize button. The window has no
//! native frame, and WebView2's child window takes every mouse message over the
//! page, so Windows never gets the HTMAXBUTTON hit-test that opens the snap
//! flyout. A bare child window above the page answers it over the page's
//! maximize button, whose rectangle the page reports (`caption_max`). It takes
//! the click too, so the page's button no longer sees the mouse: hover and
//! press come to the page as `caption-max` events instead.
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::*;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// The overlay, 0 until it exists. An HWND is a pointer, so it is kept as a number.
static SNAP: AtomicIsize = AtomicIsize::new(0);
static HOVER: AtomicBool = AtomicBool::new(false);

fn tell(state: &str) {
    if let Some(app) = APP.get() { let _ = app.emit("caption-max", state); }
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize),
        WM_NCMOUSEMOVE => {
            if !HOVER.swap(true, Ordering::Relaxed) {
                let mut track = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
                let _ = unsafe { TrackMouseEvent(&mut track) };
                tell("enter");
            }
            LRESULT(0)
        }
        WM_NCMOUSELEAVE => {
            HOVER.store(false, Ordering::Relaxed);
            tell("leave");
            LRESULT(0)
        }
        // Not DefWindowProc: its caption-button loop would maximize this child.
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
            tell("down");
            LRESULT(0)
        }
        WM_NCLBUTTONUP => {
            tell("up");
            if let Ok(root) = unsafe { GetParent(hwnd) } {
                let zoomed = unsafe { IsZoomed(root) }.as_bool();
                let _ = unsafe { ShowWindow(root, if zoomed { SW_RESTORE } else { SW_MAXIMIZE }) };
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

/// Makes the overlay over `parent`, hidden until the page reports its button.
pub fn create(app: &AppHandle, parent: HWND) -> windows::core::Result<()> {
    let _ = APP.set(app.clone());
    unsafe {
        let instance = HINSTANCE(GetModuleHandleW(None)?.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance,
            lpszClassName: w!("LoomSnapLayouts"),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: HBRUSH(GetStockObject(NULL_BRUSH).0), // never paints
            ..Default::default()
        };
        RegisterClassW(&class);
        // No extended styles: WS_EX_LAYERED loses the hit-test and WS_EX_TRANSPARENT the mouse.
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE::default(), w!("LoomSnapLayouts"), w!(""), WS_CHILD | WS_CLIPSIBLINGS,
            0, 0, 0, 0, Some(parent), None, Some(instance), None)?;
        SNAP.store(hwnd.0 as isize, Ordering::Relaxed);
    }
    Ok(())
}

/// Where the page's maximize button is, in physical pixels of the client area,
/// or None while it isn't on screen.
#[tauri::command]
pub fn caption_max(app: AppHandle, rect: Option<(i32, i32, i32, i32)>) {
    let raw = SNAP.load(Ordering::Relaxed);
    if raw == 0 { return; }
    let _ = app.run_on_main_thread(move || unsafe {
        let hwnd = HWND(raw as *mut _);
        match rect {
            // Raised above WebView2's window, its sibling, every time.
            Some((x, y, w, h)) => { let _ = SetWindowPos(hwnd, Some(HWND_TOP), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW); }
            None => { let _ = ShowWindow(hwnd, SW_HIDE); }
        }
    });
}
