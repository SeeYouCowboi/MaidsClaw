#[macro_use]
extern crate napi_derive;

#[napi]
pub fn version() -> String {
    "0.1.0".to_string()
}
