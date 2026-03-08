#[macro_use]
extern crate napi_derive;

mod context_window;
mod lore_matcher;
mod token_counter;

pub use context_window::{fits_in_window, truncate_to_window};
pub use lore_matcher::match_keywords;
pub use token_counter::{count_tokens, count_tokens_batch};

#[napi]
pub fn version() -> String {
    "0.1.0".to_string()
}
