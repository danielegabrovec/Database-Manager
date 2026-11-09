#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = dbmanager_lib::windows_service::run_helper(&args) {
        if let Err(error) = &result {
            eprintln!("{error}");
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    dbmanager_lib::run();
}
