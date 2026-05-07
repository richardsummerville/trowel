// main.rs — thin entry point. The actual command implementations live in lib.rs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    trowel_lib::run();
}
