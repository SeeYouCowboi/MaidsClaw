#[napi(js_name = "fitsInWindow")]
pub fn fits_in_window(token_count: u32, max_tokens: u32) -> bool {
    token_count <= max_tokens
}

#[napi(js_name = "truncateToWindow")]
pub fn truncate_to_window(tokens: Vec<String>, max_tokens: u32) -> Vec<String> {
    let max = max_tokens as usize;
    if tokens.len() <= max {
        return tokens;
    }

    let start_index = tokens.len() - max;
    tokens.into_iter().skip(start_index).collect()
}
